// Merging: only at the expected head, a merge the server takes for later shown with what calls it
// off, and a merge that was cut off checked against the server.

import { afterEach, expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/testing";
import type { OperationId } from "@niwa-labs/core";

import { CancelStarted, MergeStarted, forge, secret, forgePrMerge, forgePrMergeCancel, forgePrMergePending, forgePrRead } from "../src/index.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function served(): Promise<ForgeHost> {
  const host = await forgeHost();
  hosts.push(host);
  openMr(host);
  return host;
}

const head = sha("topic-1");
const ask = { repo: BILLING, number: 7, expectHead: head, method: "merge" } as const;

/** The operation of the last merge asked, as its record says. */
async function lastOperation(host: ForgeHost): Promise<OperationId> {
  const asked = (await host.records([MergeStarted.name])).at(-1);
  return MergeStarted.schema.parse(asked?.data).operation as OperationId;
}

/** Ask the module's own check of the merge, as the host does after a cut. */
async function check(host: ForgeHost, operation: OperationId) {
  const merge = host.actions.get(forgePrMerge.name);
  if (merge?.check === undefined) throw new Error("forge.pr.merge has no check");
  return await merge.check(operation, { operationId: operation, caller: { kind: "host" } });
}

test("a merge at the expected head merges and answers the commit it made", async () => {
  const host = await served();
  const done = await host.niwa.call(forgePrMerge, { ...ask, method: "squash" });
  expect(done).toEqual({ outcome: "merged", sha: sha(`merge-7-${head}`), externalId: "gitlab.example.com/acme/billing!7" });
  expect(host.server.seen("PUT", /\/merge$/)[0]?.body).toMatchObject({ sha: head, squash: true });
});

test("a squash in a project that merges by merge commit lands on the merge commit, not on the squash it was made from", async () => {
  const host = await served();
  const done = await host.niwa.call(forgePrMerge, { ...ask, method: "squash" });
  const mr = host.billing.mrs.get(7)!;
  expect(mr.squash_commit_sha).toBe(sha("squash-7"));
  expect(mr.merge_commit_sha).not.toBe(mr.squash_commit_sha);
  expect(done).toMatchObject({ outcome: "merged", sha: mr.merge_commit_sha });
  const operation = await lastOperation(host);
  expect(await check(host, operation)).toMatchObject({ status: "completed", value: { sha: mr.merge_commit_sha } });
  expect(await host.niwa.call(forgePrRead, { repo: BILLING, number: 7 })).toMatchObject({ mergeSha: mr.merge_commit_sha });
});

test("a squash in a project that merges by fast-forward lands on the squash commit", async () => {
  const host = await served();
  host.billing.fastForward = true;
  const done = await host.niwa.call(forgePrMerge, { ...ask, method: "squash" });
  expect(done).toMatchObject({ outcome: "merged", sha: sha("squash-7") });
  expect(await check(host, await lastOperation(host))).toMatchObject({ status: "completed", value: { sha: sha("squash-7") } });
  expect(await host.niwa.call(forgePrRead, { repo: BILLING, number: 7 })).toMatchObject({ mergeSha: sha("squash-7") });
});

test("a head that moved is refused by the server and nothing is merged", async () => {
  const host = await served();
  host.billing.mrs.get(7)!.sha = sha("topic-2");
  const done = await host.niwa.call(forgePrMerge, ask);
  expect(done).toMatchObject({ outcome: "refused", why: expect.stringContaining("SHA does not match") });
  expect(host.billing.mrs.get(7)?.state).toBe("opened");
});

test("an automatic merge is armed, listed as pending with its id and the action that calls it off, and cancelled", async () => {
  const host = await served();
  const done = await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  expect(done).toEqual({ outcome: "armed", externalId: "gitlab.example.com/acme/billing!7", cancel: "forge.pr.merge.cancel" });
  const { items } = await host.niwa.call(forgePrMergePending, {});
  expect(items).toEqual([
    {
      pr: { repo: { ...BILLING, projectId: 42 }, number: 7 },
      mode: "auto-merge",
      externalId: "gitlab.example.com/acme/billing!7",
      expectHead: head,
      cancel: { action: "forge.pr.merge.cancel", input: { repo: BILLING, number: 7 } },
    },
  ]);
  const cancel = items[0]?.cancel;
  expect(await host.niwa.call(forgePrMergeCancel, cancel?.input ?? { repo: BILLING, number: 0 })).toEqual({ cancelled: true });
  expect(host.billing.mrs.get(7)?.merge_when_pipeline_succeeds).toBe(false);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});

test("a merge train takes the pull request as queued, and calling it off takes it out of the train", async () => {
  const host = await served();
  expect(await host.niwa.call(forgePrMerge, { ...ask, when: "train" })).toMatchObject({ outcome: "queued" });
  expect(host.billing.mrs.get(7)?.in_train).toBe(true);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([expect.objectContaining({ mode: "train" })]);
  expect(await host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).toEqual({ cancelled: true });
  expect(host.billing.mrs.get(7)?.in_train).toBe(false);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});

test("a check of a merge that was never asked says it failed", async () => {
  const host = await served();
  expect(await check(host, "op-never" as OperationId)).toEqual({ status: "failed", error: expect.stringContaining("never asked") });
});

test("a merge whose answer was lost is checked against the pull request on the server", async () => {
  const host = await served();
  host.server.queue("PUT", /\/merge$/, 502, { message: "bad gateway" });
  await expect(host.niwa.call(forgePrMerge, ask)).rejects.toThrow(/502/);
  const operation = await lastOperation(host);
  expect(await check(host, operation)).toMatchObject({ status: "unknown" });

  const mr = host.billing.mrs.get(7)!;
  mr.state = "merged";
  mr.merge_commit_sha = sha("merged-on-the-server");
  expect(await check(host, operation)).toEqual({
    status: "completed",
    value: { outcome: "merged", sha: sha("merged-on-the-server"), externalId: "gitlab.example.com/acme/billing!7" },
  });
});

test("a merge that was merged at another head than the one expected is not this merge", async () => {
  const host = await served();
  host.server.queue("PUT", /\/merge$/, 502, { message: "bad gateway" });
  await expect(host.niwa.call(forgePrMerge, ask)).rejects.toThrow(/502/);
  const mr = host.billing.mrs.get(7)!;
  Object.assign(mr, { state: "merged", sha: sha("topic-2"), merge_commit_sha: sha("other") });
  expect(await check(host, await lastOperation(host))).toMatchObject({ status: "failed" });
});

test("an automatic merge the server armed while its answer was lost is found by the check and listed as pending once", async () => {
  const host = await served();
  host.server.queue("PUT", /\/merge$/, 502, { message: "bad gateway" });
  await expect(host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" })).rejects.toThrow(/502/);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
  host.billing.mrs.get(7)!.merge_when_pipeline_succeeds = true;
  const operation = await lastOperation(host);
  expect(await check(host, operation)).toMatchObject({ status: "completed", value: { outcome: "armed" } });
  expect(await check(host, operation)).toMatchObject({ status: "completed", value: { outcome: "armed" } });
  expect((await host.niwa.call(forgePrMergePending, {})).items).toHaveLength(1);
  expect(await host.records(["forge.pr.merge.armed"])).toHaveLength(1);
});

test("a check after an automatic merge the call recorded itself writes no second record of it", async () => {
  const host = await served();
  await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  expect(await check(host, await lastOperation(host))).toMatchObject({ status: "completed", value: { outcome: "armed" } });
  expect(await host.records(["forge.pr.merge.armed"])).toHaveLength(1);
});

test("a cancel the server answers without calling anything off leaves the merge pending", async () => {
  const host = await served();
  await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  host.server.queue("POST", /cancel_merge_when_pipeline_succeeds$/, 201, { status: "error", message: "Merge train rate limit" });
  expect(await host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).toEqual({ cancelled: false });
  expect(host.billing.mrs.get(7)?.merge_when_pipeline_succeeds).toBe(true);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toHaveLength(1);
  expect(await host.records(["forge.pr.merge.disarmed"])).toEqual([]);
  expect(await host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).toEqual({ cancelled: true });
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});

test("a cancel that finds the pull request merged does not say the merge was called off", async () => {
  const host = await served();
  await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  const mr = host.billing.mrs.get(7)!;
  host.server.queue("POST", /cancel_merge_when_pipeline_succeeds$/, 406, { message: "406 Not Acceptable" });
  host.server.queue("DELETE", /merge_trains/, 404, { message: "404 Not found" });
  Object.assign(mr, { state: "merged", merge_when_pipeline_succeeds: false, merge_commit_sha: sha("merged-meanwhile") });
  expect(await host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).toEqual({ cancelled: false });
  expect(await host.records(["forge.pr.merge.disarmed"])).toEqual([]);
});

test("calling off an automatic merge does not ask about a merge train, which a server may not have", async () => {
  const host = await served();
  await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  host.server.queue("GET", /merge_trains/, 403, { message: "403 Forbidden" });
  expect(await host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).toEqual({ cancelled: true });
  expect(host.server.seen("GET", /merge_trains/)).toEqual([]);
  expect(await host.records(["forge.pr.merge.disarmed"])).toHaveLength(1);
});

test("concurrent merges and cancellations send one mutation per claim", async () => {
  const host = await served();
  const merge = () => host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  const first = await Promise.allSettled([merge(), merge()]);
  expect(first.filter(answer => answer.status === "fulfilled")).toHaveLength(1);
  expect(host.server.seen("PUT", /\/merge$/)).toHaveLength(1);
  const cancel = () => host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 });
  const second = await Promise.allSettled([cancel(), cancel()]);
  expect(second.filter(answer => answer.status === "fulfilled" && answer.value.cancelled)).toHaveLength(1);
  expect(host.server.seen("POST", /cancel_merge_when_pipeline_succeeds$/)).toHaveLength(1);
});

test("an interrupted cancellation is recovered from GitLab without sending another mutation", async () => {
  const host = await served();
  await host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" });
  host.server.queue("POST", /cancel_merge_when_pipeline_succeeds$/, 502, {});
  await expect(host.niwa.call(forgePrMergeCancel, { repo: BILLING, number: 7 })).rejects.toThrow(/502/);
  const operation = CancelStarted.schema.parse((await host.records([CancelStarted.name]))[0]?.data).operation as OperationId;
  const cancel = host.actions.get(forgePrMergeCancel.name)!;
  const check = () => cancel.check!(operation, { operationId: operation, caller: { kind: "host" } });
  expect(await check()).toEqual({ status: "unknown" });
  host.billing.mrs.get(7)!.merge_when_pipeline_succeeds = false;
  expect(await check()).toEqual({ status: "completed", value: { cancelled: true } });
  expect(await check()).toEqual({ status: "completed", value: { cancelled: true } });
  expect(host.server.seen("POST", /cancel_merge_when_pipeline_succeeds$/)).toHaveLength(1);
  expect(await host.records(["forge.pr.merge.disarmed"])).toHaveLength(1);
});

test("reopening a host finds an interrupted merge on an unwatched repository without sending it again", async () => {
  const host = await served();
  host.server.queue("PUT", /\/merge$/, 502, {});
  await expect(host.niwa.call(forgePrMerge, { ...ask, when: "pipeline" })).rejects.toThrow(/502/);
  await host.niwa.close();
  host.billing.mrs.get(7)!.merge_when_pipeline_succeeds = true;
  const restarted = createNiwa({ home: host.home });
  restarted.use(forge({
    servers: [{ host: BILLING.host, url: host.server.url, token: secret("GITLAB_TOKEN") }],
    fetch: host.server.fetch, env: {}, poll: { awaited: 15, background: 15, quiet: 15 },
  }));
  try {
    await restarted.serve();
    const until = Date.now() + 3000;
    while ((await restarted.call(forgePrMergePending, {})).items.length === 0 && Date.now() < until) await Bun.sleep(15);
    expect((await restarted.call(forgePrMergePending, {})).items).toHaveLength(1);
    expect(host.server.seen("PUT", /\/merge$/)).toHaveLength(1);
  } finally {
    await restarted.close();
  }
});

test("an expected target commit refuses before any GitLab merge request", async () => {
  const host = await served();
  const target = sha("main-tip");
  host.billing.branches.set("main", target);
  expect((await host.niwa.call(forgePrRead, { repo: BILLING, number: 7, landing: true })).landing)
    .toMatchObject({ targetSha: target, conditionalMerge: false });
  for (const expectTarget of [target, sha("obsolete")]) {
    expect(await host.niwa.call(forgePrMerge, { ...ask, expectTarget })).toMatchObject({ outcome: "refused" });
  }
  expect(host.server.seen("PUT", /\/merge$/)).toHaveLength(0);
  expect(await host.records([MergeStarted.name])).toHaveLength(0);
});
