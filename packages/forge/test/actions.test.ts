// The actions of the forge module against a fake server: what they read and change there, the class
// each declares, the grants that let them through, and the token that never reaches the journal.

import { afterEach, expect, test } from "bun:test";

import { forgeCommentCreate, forgeCommentRead, forgeJobLog, forgeJobRun, forgePipelineRead, forgePipelineRetry, forgePipelineTrigger, forgePrClose, forgePrEnsure, forgePrMerge, forgePrRead, forgeRepoList, forgeRepoWatch, secret } from "../src/index.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function served(opts: Parameters<typeof forgeHost>[0] = {}): Promise<ForgeHost> {
  const host = await forgeHost(opts);
  hosts.push(host);
  return host;
}

test("a pull request is read with the token of the host's secret file", async () => {
  const host = await served();
  openMr(host);
  const pr = await host.niwa.call(forgePrRead, { repo: BILLING, number: 7 });
  expect(pr).toMatchObject({ pr: { repo: { ...BILLING, projectId: 42 }, number: 7 }, state: "open", branch: "topic", base: "main", head: sha("topic-1") });
  expect(host.server.requests.every((one) => one.headers["PRIVATE-TOKEN"] === host.server.token)).toBe(true);
});

test("a token file others can read is refused, and the variable of the environment is taken when there is no file", async () => {
  const unsafe = await served({ tokenMode: 0o644 });
  openMr(unsafe);
  await expect(unsafe.niwa.call(forgePrRead, { repo: BILLING, number: 7 })).rejects.toThrow(/0600/);
  expect(unsafe.server.requests).toHaveLength(0);

  const fromEnv = await served({ tokenMode: false, env: { NIWA_SECRET_GITLAB_TOKEN: "glpat-test-token" } });
  openMr(fromEnv);
  expect((await fromEnv.niwa.call(forgePrRead, { repo: BILLING, number: 7 })).state).toBe("open");
  expect(fromEnv.server.requests.at(-1)?.headers["PRIVATE-TOKEN"]).toBe("glpat-test-token");
});

test("neither the token nor a secret variable is written to the journal, on success or on failure", async () => {
  const host = await served({ env: { NIWA_SECRET_DEPLOY_KEY: "s3cr3t-deploy-value" } });
  openMr(host);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  await host.niwa.call(forgePipelineTrigger, { repo: BILLING, ref: "main", variables: { DEPLOY_KEY: secret("DEPLOY_KEY"), MODE: "dry" } });
  const pipeline = [...host.billing.variables.values()][0];
  expect(pipeline).toEqual([
    { key: "DEPLOY_KEY", value: "s3cr3t-deploy-value" },
    { key: "MODE", value: "dry" },
  ]);
  host.server.token = "glpat-rotated";
  await expect(host.niwa.call(forgePrRead, { repo: BILLING, number: 7 })).rejects.toThrow(/401/);
  const journal = JSON.stringify(await host.records());
  expect(journal).toContain("forge.repo.watched");
  expect(journal).not.toContain("glpat-test-token");
  expect(journal).not.toContain("s3cr3t-deploy-value");
});

test("each action declares its class: reads read, merging and pipelines are irreversible, watching writes niwa's own records", async () => {
  const host = await served();
  const described = new Map((await host.niwa.describe()).actions.map((one) => [one.name as string, one]));
  expect(described.get("forge.pr.merge")).toMatchObject({ effect: "irreversible", world: "external", recovery: "do-not-repeat" });
  expect(described.get("forge.pr.read")).toMatchObject({ effect: "read", world: "external" });
  expect(described.get("forge.pr.ensure")).toMatchObject({ effect: "write", world: "external", idempotent: true });
  expect(described.get("forge.comment.create")).toMatchObject({ effect: "write", world: "external", recovery: "do-not-repeat" });
  expect(described.get("forge.repo.watch")).toMatchObject({ effect: "record", world: "niwa" });
  for (const name of ["forge.pipeline.trigger", "forge.pipeline.retry", "forge.pipeline.cancel", "forge.job.retry", "forge.job.cancel", "forge.job.run"]) {
    expect(described.get(name)).toMatchObject({ effect: "irreversible", world: "external" });
  }
});

test("a mask lets a caller write on pull requests but never merge or touch a pipeline; a rule that names merge on one project does", async () => {
  const host = await served();
  openMr(host);
  host.server.mr(host.payroll, { iid: 7, source_branch: "topic", sha: sha("payroll") });
  const masked = await host.as(["forge.*"]);
  expect(await masked.call(forgePrClose, { repo: BILLING, number: 7 })).toMatchObject({ closed: true });
  await expect(masked.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge" })).rejects.toThrow(/grant/);
  await expect(masked.call(forgePipelineRetry, { repo: BILLING, ref: "main", pipeline: 1 })).rejects.toThrow(/grant/);

  host.billing.mrs.get(7)!.state = "opened";
  const named = await host.as(["forge.pr.merge@gitlab.example.com/acme/billing/pr/*"]);
  expect(await named.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge" })).toMatchObject({ outcome: "merged" });
  const payroll = { host: BILLING.host, path: "acme/payroll" };
  await expect(named.call(forgePrMerge, { repo: payroll, number: 7, expectHead: sha("payroll"), method: "merge" })).rejects.toThrow(/grant/);
  expect(host.payroll.mrs.get(7)?.state).toBe("opened");
});

test("a read is granted on the repository, a write on the pull request it changes", async () => {
  const host = await served();
  openMr(host);
  const reader = await host.as(["forge.pr.read@gitlab.example.com/acme/billing", "forge.comment.*@gitlab.example.com/acme/billing/pr/7"]);
  expect((await reader.call(forgePrRead, { repo: BILLING, number: 7 })).state).toBe("open");
  expect(await reader.call(forgeCommentCreate, { repo: BILLING, number: 7, body: "Looks good" })).toMatchObject({ discussion: expect.any(String) });
  await expect(reader.call(forgeCommentCreate, { repo: BILLING, number: 8, body: "No" })).rejects.toThrow(/grant/);
  await expect(reader.call(forgePrRead, { repo: { ...BILLING, path: "acme/payroll" }, number: 7 })).rejects.toThrow(/grant/);
});

test("ensure opens a pull request of a branch once, finds it again, and updates it by its number", async () => {
  const host = await served();
  host.billing.branches.set("feature/login", sha("login-1"));
  const first = await host.niwa.call(forgePrEnsure, { repo: BILLING, branch: "feature/login", base: "main", title: "Login" });
  expect(first).toMatchObject({ created: true, head: sha("login-1") });
  const same = await host.niwa.call(forgePrEnsure, { repo: BILLING, branch: "feature/login", base: "main", title: "Login" });
  expect(same).toMatchObject({ created: false, pr: { number: first.pr.number } });
  const again = await host.niwa.call(forgePrEnsure, { repo: BILLING, number: first.pr.number, branch: "feature/login", base: "develop", title: "Login, again", draft: true });
  expect(again).toMatchObject({ created: false, pr: { number: first.pr.number } });
  expect(host.billing.mrs.get(first.pr.number)).toMatchObject({ title: "Draft: Login, again", target_branch: "develop" });
  expect(host.billing.mrs.size).toBe(1);
});

test("ensure with a number reopens a closed pull request and updates it, so the answer is an open one", async () => {
  const host = await served();
  openMr(host);
  host.billing.mrs.get(7)!.state = "closed";
  const owner = await host.as(["forge.pr.ensure@gitlab.example.com/acme/billing/pr/7"]);
  expect(await owner.call(forgePrEnsure, { repo: BILLING, number: 7, branch: "topic", base: "main", title: "Back again" })).toMatchObject({ created: false, pr: { number: 7 } });
  expect(host.billing.mrs.get(7)).toMatchObject({ state: "opened", title: "Back again" });
  expect(host.server.seen("PUT", /merge_requests\/7$/)[0]?.body).toMatchObject({ state_event: "reopen" });
});

test("ensure with a number refuses a pull request that is merged or locked, and changes nothing", async () => {
  const host = await served();
  openMr(host);
  const owner = await host.as(["forge.pr.ensure@gitlab.example.com/acme/billing/pr/7"]);
  const ensure = () => owner.call(forgePrEnsure, { repo: BILLING, number: 7, branch: "topic", base: "main", title: "Renamed" }).catch((caught: unknown) => caught) as Promise<Error>;
  host.billing.mrs.get(7)!.state = "merged";
  expect(await ensure()).toMatchObject({ message: expect.stringContaining("is merged") });
  host.billing.mrs.get(7)!.state = "locked";
  expect(await ensure()).toMatchObject({ message: expect.stringContaining("is locked") });
  expect(host.server.requests.filter((one) => one.method === "PUT")).toHaveLength(0);
  expect(host.billing.mrs.get(7)?.title).toBe("MR 7");
});

test("comments are read with their text from the server, and the text is the step's, not a record's", async () => {
  const host = await served();
  openMr(host);
  await host.niwa.call(forgeCommentCreate, { repo: BILLING, number: 7, body: "Please rename the field" });
  const { items } = await host.niwa.call(forgeCommentRead, { repo: BILLING, number: 7 });
  expect(items).toEqual([expect.objectContaining({ body: "Please rename the field", author: "niwa", resolved: false })]);
});

test("a pipeline or a job of another ref than the one the call names is refused before anything changes", async () => {
  const host = await served();
  const release = host.server.pipeline(host.billing, { sha: sha("v1"), ref: "release", status: "failed" });
  const manual = host.server.job(host.billing, { pipeline: release.id, ref: "release", status: "manual" });
  await expect(host.niwa.call(forgePipelineRetry, { repo: BILLING, ref: "feature/x", pipeline: release.id })).rejects.toThrow(/release/);
  await expect(host.niwa.call(forgeJobRun, { repo: BILLING, ref: "feature/x", job: manual.id })).rejects.toThrow(/release/);
  expect(host.server.requests.filter((one) => one.method === "POST")).toHaveLength(0);
  expect(await host.niwa.call(forgePipelineRetry, { repo: BILLING, ref: "release", pipeline: release.id })).toMatchObject({ state: "running" });
  expect(await host.niwa.call(forgeJobRun, { repo: BILLING, ref: "release", job: manual.id })).toMatchObject({ state: "pending" });
});

test("a watched repository is listed with its project id, and watching it again changes nothing", async () => {
  const host = await served();
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  expect(await host.niwa.call(forgeRepoList, {})).toEqual({ items: [{ ...BILLING, projectId: 42 }] });
  expect(await host.records(["forge.repo.watched"])).toHaveLength(1);
});

test("ensure without a number changes no open pull request: a grant on pr/new cannot rewrite pull request 7", async () => {
  const host = await served();
  openMr(host);
  const creator = await host.as(["forge.pr.ensure@gitlab.example.com/acme/billing/pr/new"]);
  await expect(creator.call(forgePrEnsure, { repo: BILLING, branch: "topic", base: "develop", title: "Hijacked" })).rejects.toThrow(/number/);
  expect(host.billing.mrs.get(7)).toMatchObject({ title: "MR 7", target_branch: "main" });
  expect(await creator.call(forgePrEnsure, { repo: BILLING, branch: "topic", base: "main", title: "MR 7" })).toMatchObject({ created: false, pr: { number: 7 } });
  const owner = await host.as(["forge.pr.ensure@gitlab.example.com/acme/billing/pr/7"]);
  expect(await owner.call(forgePrEnsure, { repo: BILLING, number: 7, branch: "topic", base: "develop", title: "Renamed" })).toMatchObject({ created: false });
  expect(host.billing.mrs.get(7)).toMatchObject({ title: "Renamed", target_branch: "develop" });
});

test("a secret value the server repeats in an error is not in the error, nor in the journal", async () => {
  const host = await served({ env: { NIWA_SECRET_DEPLOY_KEY: "s3cr3t-deploy-value" } });
  host.server.queue("POST", /\/pipeline$/, 400, { message: { variables: ["DEPLOY_KEY=s3cr3t-deploy-value is not allowed"] } });
  const error = await host.niwa.call(forgePipelineTrigger, { repo: BILLING, ref: "main", variables: { DEPLOY_KEY: secret("DEPLOY_KEY") } }).catch((caught: unknown) => caught);
  expect(String((error as Error).message)).toContain("is not allowed");
  expect(String((error as Error).message)).not.toContain("s3cr3t-deploy-value");
  expect(JSON.stringify(await host.records())).not.toContain("s3cr3t-deploy-value");
});

test("the pipelines of a commit include a merge result however many pipelines the project ran since", async () => {
  const host = await served();
  openMr(host);
  const mergeSha = sha("merge-result-1");
  host.billing.commits.set(mergeSha, [sha("main-1"), sha("topic-1")]);
  const result = host.server.pipeline(host.billing, { sha: mergeSha, ref: "refs/merge-requests/7/merge", source: "merge_request_event", status: "success" });
  for (let at = 0; at < 60; at += 1) host.server.pipeline(host.billing, { sha: sha(`other-${String(at)}`), ref: "main" });
  const found = await host.niwa.call(forgePipelineRead, { repo: BILLING, sha: sha("topic-1"), kind: "merge-result" });
  expect(found.items.map((one) => [one.pipeline, one.sourceSha, one.mergeSha])).toEqual([[result.id, sha("topic-1"), mergeSha]]);
});

test("a job log counts the bytes the server sent, and a tail that starts inside a character starts after it", async () => {
  const host = await served();
  const pipeline = host.server.pipeline(host.billing, { sha: sha("main"), ref: "main" });
  const bad = new Uint8Array([0xff, 0xfe, 0xff]);
  const text = new TextEncoder().encode(`${"é".repeat(40)}end\n`);
  const trace = new Uint8Array([...bad, ...text]);
  const job = host.server.job(host.billing, { pipeline: pipeline.id, ref: "main", trace });
  const whole = await host.niwa.call(forgeJobLog, { repo: BILLING, job: job.id });
  expect(whole).toMatchObject({ truncated: false, size: trace.length });
  const tail = await host.niwa.call(forgeJobLog, { repo: BILLING, job: job.id, bytes: 7 });
  expect(tail).toMatchObject({ truncated: true, size: trace.length });
  expect(tail.log).toBe("éend\n");
});

test("a secret value that crosses the bound of the error message is taken out before the message is cut", async () => {
  const host = await served({ env: { NIWA_SECRET_DEPLOY_KEY: "s3cr3t-deploy-value" } });
  host.server.queue("POST", /\/pipeline$/, 400, { message: `${"x".repeat(480)}DEPLOY_KEY=s3cr3t-deploy-value is not allowed` });
  const error = (await host.niwa.call(forgePipelineTrigger, { repo: BILLING, ref: "main", variables: { DEPLOY_KEY: secret("DEPLOY_KEY") } }).catch((caught: unknown) => caught)) as Error;
  expect(error.message).not.toContain("s3cr3t");
  expect(error.message).toContain("DEPLOY_KEY=");
  expect(JSON.stringify(await host.records())).not.toContain("s3cr3t");
});

test("the token of the host is taken out of what the server says, even when it is cut by the bound", async () => {
  const host = await served();
  host.server.queue("GET", /\/merge_requests\/7$/, 400, { message: `${"y".repeat(494)}${host.server.token}` });
  const error = (await host.niwa.call(forgePrRead, { repo: BILLING, number: 7 }).catch((caught: unknown) => caught)) as Error;
  expect(error.message).not.toContain("glpat");
  expect(error.message).toContain("yyyy");
});

test("a job log is read up to a bound that keeps the step's outcome small", async () => {
  const host = await served();
  const pipeline = host.server.pipeline(host.billing, { sha: sha("main"), ref: "main" });
  const job = host.server.job(host.billing, { pipeline: pipeline.id, ref: "main", trace: `start\n${"x".repeat(70_000)}\nend\n` });
  const log = await host.niwa.call(forgeJobLog, { repo: BILLING, job: job.id });
  expect(log).toMatchObject({ truncated: true, size: 70_011 });
  expect(log.log.endsWith("end\n")).toBe(true);
  expect(Buffer.byteLength(log.log)).toBe(65_536);
  expect(forgeJobLog.input.safeParse({ repo: BILLING, job: job.id, bytes: 65_537 }).success).toBe(false);
});
