// The pull requests the module observed: folded from its records, the open ones first, with the checks of
// the head and the latest pipelines, and nothing asked of the server.

import { afterEach, expect, test } from "bun:test";

import { forgePrList, forgeRepoSync, forgeRepoWatch } from "../src/index.ts";
import { PIPELINES_SHOWN } from "../src/prs.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const PAYROLL = { host: "gitlab.example.com", path: "acme/payroll" };

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function watched(): Promise<ForgeHost> {
  const host = await forgeHost();
  hosts.push(host);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  await host.niwa.call(forgeRepoWatch, { repo: PAYROLL });
  return host;
}

const syncAll = async (host: ForgeHost) => {
  await host.niwa.call(forgeRepoSync, { repo: BILLING });
  await host.niwa.call(forgeRepoSync, { repo: PAYROLL });
};

test("an open pull request is listed with its head, its checks and its pipelines as they were last seen", async () => {
  const host = await watched();
  openMr(host);
  const head = host.server.pipeline(host.billing, { sha: sha("topic-1"), ref: "refs/merge-requests/7/head", source: "merge_request_event" });
  await syncAll(host);
  expect((await host.niwa.call(forgePrList, {})).items).toEqual([
    {
      pr: { repo: { ...BILLING, projectId: 42 }, number: 7 },
      state: "open",
      title: "MR 7",
      branch: "topic",
      base: "main",
      draft: false,
      author: "dev",
      head: sha("topic-1"),
      checks: "pending",
      pipelines: [{ pipeline: head.id, kind: "head", state: "running", sourceSha: sha("topic-1") }],
    },
  ]);

  head.status = "success";
  await syncAll(host);
  const [listed] = (await host.niwa.call(forgePrList, {})).items;
  expect(listed?.checks).toBe("green");
  expect(listed?.pipelines).toEqual([expect.objectContaining({ pipeline: head.id, state: "success" })]);
});

test("a merge result is listed with the pair of commits it was made of, newest pipeline first", async () => {
  const host = await watched();
  openMr(host);
  const first = host.server.pipeline(host.billing, { sha: sha("topic-1"), ref: "refs/merge-requests/7/head", source: "merge_request_event" });
  const mergeSha = sha("merge-result-1");
  host.billing.commits.set(mergeSha, [sha("main-1"), sha("topic-1")]);
  const second = host.server.pipeline(host.billing, { sha: mergeSha, ref: "refs/merge-requests/7/merge", source: "merge_request_event" });
  await syncAll(host);
  const [listed] = (await host.niwa.call(forgePrList, {})).items;
  expect(listed?.pipelines.map((one) => one.pipeline)).toEqual([second.id, first.id]);
  expect(listed?.pipelines[0]).toEqual({ pipeline: second.id, kind: "merge-result", state: "running", sourceSha: sha("topic-1"), targetSha: sha("main-1"), mergeSha });
});

test("a pipeline of no pull request is not listed under one, and only the latest ones are kept", async () => {
  const host = await watched();
  openMr(host);
  host.server.pipeline(host.billing, { sha: sha("main-1"), ref: "main", source: "push" });
  const made = Array.from({ length: PIPELINES_SHOWN + 2 }, (_, at) =>
    host.server.pipeline(host.billing, { sha: sha("topic-1"), ref: `refs/merge-requests/7/head`, source: "merge_request_event", status: at % 2 === 0 ? "success" : "failed" }),
  );
  await syncAll(host);
  const [listed] = (await host.niwa.call(forgePrList, {})).items;
  expect(listed?.pipelines).toHaveLength(PIPELINES_SHOWN);
  expect(listed?.pipelines[0]?.pipeline).toBe(made.at(-1)?.id);
});

test("a title, a base and a draft flag that changed are read as they stand now", async () => {
  const host = await watched();
  const mr = openMr(host);
  await syncAll(host);
  Object.assign(mr, { title: "Draft: rework", target_branch: "release", draft: true });
  await syncAll(host);
  const [listed] = (await host.niwa.call(forgePrList, {})).items;
  expect(listed).toMatchObject({ title: "Draft: rework", base: "release", draft: true, state: "open" });
});

test("the open ones come first, then the latest changed, and a filter keeps a repository or a state", async () => {
  const host = await watched();
  openMr(host, 7);
  openMr(host, 8, "topic-8");
  openMr(host, 3, "topic-3", host.payroll);
  await syncAll(host);
  Object.assign(host.billing.mrs.get(7)!, { state: "merged", merge_commit_sha: sha("merge-7") });
  host.server.event(host.billing, { action_name: "accepted", target_type: "MergeRequest", target_iid: 7 });
  await syncAll(host);

  const all = (await host.niwa.call(forgePrList, {})).items.map((one) => [one.pr.repo.path, one.pr.number, one.state]);
  expect(all).toEqual([
    ["acme/payroll", 3, "open"],
    ["acme/billing", 8, "open"],
    ["acme/billing", 7, "merged"],
  ]);
  expect((await host.niwa.call(forgePrList, { repo: BILLING })).items.map((one) => one.pr.number)).toEqual([8, 7]);
  expect((await host.niwa.call(forgePrList, { state: "merged" })).items.map((one) => one.pr.number)).toEqual([7]);
  expect((await host.niwa.call(forgePrList, { repo: PAYROLL, state: "merged" })).items).toEqual([]);
});

test("a pull request closed without a merge is listed as closed", async () => {
  const host = await watched();
  openMr(host);
  host.server.event(host.billing, { action_name: "opened", target_type: "MergeRequest", target_iid: 7 });
  await syncAll(host);
  host.billing.mrs.get(7)!.state = "closed";
  host.server.event(host.billing, { action_name: "closed", target_type: "MergeRequest", target_iid: 7 });
  await syncAll(host);
  expect((await host.niwa.call(forgePrList, {})).items.map((one) => one.state)).toEqual(["closed"]);
});
