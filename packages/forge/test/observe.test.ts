// Watching a repository: events under the server's ids, changes between polls as versions with the
// state before them, merge results bound to their pair of commits, and the cadence of the polls.

import { afterEach, expect, test } from "bun:test";

import type { JournalReader } from "@niwa-labs/core";

import { setTimeout as sleep } from "node:timers/promises";

import {
  ChecksObserved,
  DEFAULT_INTERVALS,
  JobObserved,
  PipelineObserved,
  Poller,
  PrComment,
  PrHead,
  PrClosed,
  PrMerged,
  PrOpened,
  Pushed,
  forgePipelineRead,
  forgePrList,
  forgePrMerge,
  forgePrMergePending,
  forgeRepoStatus,
  forgeRepoSync,
  forgeRepoWatch,
  pollInterval,
} from "../src/index.ts";
import { GitLab } from "../src/gitlab.ts";
import { Seen, sync } from "../src/observe.ts";
import type { Emit } from "../src/observe.ts";
import { FakeGitLab, sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function watched(opts: Parameters<typeof forgeHost>[0] = {}): Promise<ForgeHost> {
  const host = await forgeHost(opts);
  hosts.push(host);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  return host;
}

const syncNow = (host: ForgeHost) => host.niwa.call(forgeRepoSync, { repo: BILLING });
const dataOf = async (host: ForgeHost, type: string) => (await host.records([type])).map((one) => one.data as Record<string, unknown>);

test("events written before the repository was watched are history, and an event is written once under the server's id", async () => {
  const host = await forgeHost();
  hosts.push(host);
  host.server.event(host.billing, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: sha("old-0"), commit_to: sha("old-1") } });
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  const push = host.server.event(host.billing, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: sha("main-1"), commit_to: sha("main-2") } });
  expect((await syncNow(host)).written).toBeGreaterThan(0);
  expect(await syncNow(host)).toEqual({ written: 0 });
  const records = await host.records([Pushed.name]);
  expect(records.map((one) => [one.id, one.data])).toEqual([
    [
      `forge:gitlab.example.com:42:event:${String(push.id)}`,
      { repo: { ...BILLING, projectId: 42 }, ref: "main", refType: "branch", before: sha("main-1"), after: sha("main-2"), author: "dev", source: { kind: "event", id: push.id } },
    ],
  ]);
});

test("a pull request opened and merged is written from the event log, and a merge pending on it is no longer pending", async () => {
  const host = await watched();
  openMr(host);
  host.server.event(host.billing, { action_name: "opened", target_type: "MergeRequest", target_iid: 7 });
  await syncNow(host);
  expect(await dataOf(host, PrOpened.name)).toEqual([expect.objectContaining({ title: "MR 7", branch: "topic", base: "main", source: expect.objectContaining({ kind: "event" }) })]);
  await host.niwa.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge", when: "pipeline" });
  expect((await host.niwa.call(forgePrMergePending, {})).items).toHaveLength(1);

  const mr = host.billing.mrs.get(7)!;
  Object.assign(mr, { state: "merged", merge_commit_sha: sha("merge-7") });
  host.server.event(host.billing, { action_name: "accepted", target_type: "MergeRequest", target_iid: 7, author: { username: "marge" } });
  await syncNow(host);
  expect(await dataOf(host, PrMerged.name)).toEqual([expect.objectContaining({ base: "main", head: sha("topic-1"), mergeSha: sha("merge-7"), by: "marge" })]);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});

test("one merge is one record for a subscriber, whether the log or a look at the pull request told it first", async () => {
  const host = await watched();
  const mr = openMr(host);
  host.server.event(host.billing, { action_name: "opened", target_type: "MergeRequest", target_iid: 7 });
  await syncNow(host);
  // The merge shows on the pull request before its event is in the log.
  Object.assign(mr, { state: "merged", merge_commit_sha: sha("merge-7") });
  await syncNow(host);
  host.server.event(host.billing, { action_name: "accepted", target_type: "MergeRequest", target_iid: 7, author: { username: "marge" } });
  await syncNow(host);
  await syncNow(host);
  expect(await dataOf(host, PrMerged.name)).toEqual([expect.objectContaining({ mergeSha: sha("merge-7"), source: { kind: "observed", version: 1 } })]);
});

test("a pull request closed and opened again is each state in turn, from the log and from a look at the open ones", async () => {
  const host = await watched();
  const mr = openMr(host);
  const list = async () => (await host.niwa.call(forgePrList, {})).items.map((one) => one.state);
  await syncNow(host);
  expect(await list()).toEqual(["open"]);
  mr.state = "closed";
  await syncNow(host);
  expect(await list()).toEqual(["closed"]);
  // Reopened between two polls: only the open list shows it.
  mr.state = "opened";
  await syncNow(host);
  expect(await list()).toEqual(["open"]);
  // Closed and reopened with the log saying so.
  mr.state = "closed";
  host.server.event(host.billing, { action_name: "closed", target_type: "MergeRequest", target_iid: 7 });
  await syncNow(host);
  expect(await list()).toEqual(["closed"]);
  mr.state = "opened";
  host.server.event(host.billing, { action_name: "reopened", target_type: "MergeRequest", target_iid: 7 });
  await syncNow(host);
  expect(await list()).toEqual(["open"]);
  mr.state = "closed";
  await syncNow(host);
  expect(await list()).toEqual(["closed"]);
  expect((await dataOf(host, PrOpened.name)).map((one) => [one["reopened"], (one["source"] as { kind: string }).kind])).toEqual([
    [undefined, "observed"],
    [true, "observed"],
    [true, "event"],
  ]);
  expect((await dataOf(host, PrClosed.name)).map((one) => (one["source"] as { kind: string }).kind)).toEqual(["observed", "event", "observed"]);
  expect(await syncNow(host)).toEqual({ written: 0 });
});

test("a comment is written as its author, size and digest, never its text", async () => {
  const host = await watched();
  openMr(host);
  const body = "The secret plan is in the wiki";
  host.server.event(host.billing, { action_name: "commented on", target_type: "Note", note: { id: 9001, body, noteable_type: "MergeRequest", noteable_iid: 7, author: { username: "rev" } } });
  await syncNow(host);
  expect(await dataOf(host, PrComment.name)).toEqual([expect.objectContaining({ comment: 9001, author: "rev", size: body.length, digest: expect.stringMatching(/^sha256:/) })]);
  expect(JSON.stringify(await host.records())).not.toContain("secret plan");
});

test("a head that moves away and back between polls is three observations, each with the head before it", async () => {
  const host = await watched();
  const mr = openMr(host);
  await syncNow(host);
  mr.sha = sha("topic-2");
  await syncNow(host);
  mr.sha = sha("topic-1");
  await syncNow(host);
  await syncNow(host);
  const heads = await host.records([PrHead.name]);
  expect(heads.map((one) => one.data)).toEqual([
    expect.objectContaining({ head: sha("topic-1"), source: { kind: "observed", version: 1 } }),
    expect.objectContaining({ head: sha("topic-2"), previous: sha("topic-1"), source: { kind: "observed", version: 2 } }),
    expect.objectContaining({ head: sha("topic-1"), previous: sha("topic-2"), source: { kind: "observed", version: 3 } }),
  ]);
  expect(new Set(heads.map((one) => one.id)).size).toBe(3);
  // An observation records no head the server never showed.
  expect(await dataOf(host, PrOpened.name)).toEqual([expect.objectContaining({ source: { kind: "observed", version: 1 } })]);
});

test("a pipeline is written at each state it was seen in, and a merge result with the pair of commits it was made of", async () => {
  const host = await watched();
  openMr(host);
  const mergeSha = sha("merge-result-1");
  host.billing.commits.set(mergeSha, [sha("main-1"), sha("topic-1")]);
  const result = host.server.pipeline(host.billing, { sha: mergeSha, ref: "refs/merge-requests/7/merge", source: "merge_request_event" });
  host.server.job(host.billing, { pipeline: result.id, ref: result.ref, name: "test" });
  const orphan = host.server.pipeline(host.billing, { sha: sha("unknown-merge"), ref: "refs/merge-requests/7/merge", source: "merge_request_event" });
  await syncNow(host);
  result.status = "success";
  host.billing.jobs[0]!.status = "success";
  await syncNow(host);
  expect(await syncNow(host)).toEqual({ written: 0 });
  const pipelines = await dataOf(host, PipelineObserved.name);
  expect(pipelines).toEqual([
    expect.objectContaining({ pipeline: result.id, kind: "merge-result", pr: 7, sourceSha: sha("topic-1"), targetSha: sha("main-1"), mergeSha, state: "running", source: { kind: "observed", version: 1 } }),
    expect.objectContaining({ pipeline: result.id, state: "success", previous: "running", source: { kind: "observed", version: 2 } }),
  ]);
  expect(pipelines.some((one) => one["pipeline"] === orphan.id)).toBe(false);
  expect((await dataOf(host, JobObserved.name)).map((one) => [one["state"], one["previous"]])).toEqual([
    ["running", undefined],
    ["success", "running"],
  ]);
});

test("a tag's pipeline is a tag however it is read, though a list does not say that its ref is one", async () => {
  const host = await watched();
  const tagged = host.server.pipeline(host.billing, { sha: sha("v1-tip"), ref: "v1.0", tag: true, status: "success" });
  host.server.pipeline(host.billing, { sha: sha("main-tip"), ref: "main" });
  await syncNow(host);
  const recorded = (await dataOf(host, PipelineObserved.name)).map((one) => [one["ref"], one["kind"]]);
  expect(recorded).toEqual([["v1.0", "tag"], ["main", "branch"]]);
  const read = (input: object) => host.niwa.call(forgePipelineRead, { repo: BILLING, ...input });
  expect((await read({ sha: sha("v1-tip") })).items.map((one) => one.kind)).toEqual(["tag"]);
  expect((await read({ pipeline: tagged.id })).items.map((one) => one.kind)).toEqual(["tag"]);
  expect((await read({ sha: sha("v1-tip"), kind: "tag" })).items).toHaveLength(1);
});

test("a burst of pipelines between two polls is recorded whole, and a poll with nothing new reads one page", async () => {
  const host = await watched();
  for (let at = 0; at < 130; at += 1) host.server.pipeline(host.billing, { sha: sha(`burst-${String(at)}`), ref: "main", status: "success" });
  await syncNow(host);
  expect(await dataOf(host, PipelineObserved.name)).toHaveLength(130);
  host.server.requests.length = 0;
  expect(await syncNow(host)).toEqual({ written: 0 });
  expect(host.server.seen("GET", /\/pipelines$/).map((one) => one.query["page"])).toEqual(["1"]);
});

test("a job that moves while its pipeline stays running is written at each state it was seen in", async () => {
  const host = await watched();
  const run = host.server.pipeline(host.billing, { sha: sha("main-tip"), ref: "main", status: "running" });
  const job = host.server.job(host.billing, { pipeline: run.id, ref: "main", status: "pending" });
  await syncNow(host);
  job.status = "running";
  await syncNow(host);
  job.status = "success";
  await syncNow(host);
  expect((await dataOf(host, JobObserved.name)).map((one) => [one["state"], one["previous"]])).toEqual([
    ["pending", undefined],
    ["running", "pending"],
    ["success", "running"],
  ]);
  expect(await dataOf(host, PipelineObserved.name)).toHaveLength(1);
});

test("a pipeline whose jobs could not be read is read again by the next pass, not taken as done", async () => {
  const host = await watched();
  const run = host.server.pipeline(host.billing, { sha: sha("main-tip"), ref: "main", status: "success" });
  host.server.job(host.billing, { pipeline: run.id, ref: "main", status: "success" });
  host.server.queue("GET", /\/pipelines\/\d+\/jobs$/, 429, { message: "slow down" }, { "Retry-After": "0" });
  await expect(syncNow(host)).rejects.toThrow(/429|limit/);
  await syncNow(host);
  expect((await dataOf(host, JobObserved.name)).map((one) => one["state"])).toEqual(["success"]);
  expect((await dataOf(host, PipelineObserved.name)).map((one) => one["state"])).toEqual(["success"]);
});

test("the checks of a pull request follow the pipelines of its head", async () => {
  const host = await watched();
  const mr = openMr(host);
  const first = host.server.pipeline(host.billing, { sha: sha("topic-1"), ref: "refs/merge-requests/7/head", source: "merge_request_event" });
  await syncNow(host);
  first.status = "success";
  await syncNow(host);
  mr.sha = sha("topic-2");
  await syncNow(host);
  expect((await dataOf(host, ChecksObserved.name)).map((one) => [one["head"], one["state"], one["previous"]])).toEqual([
    [sha("topic-1"), "pending", undefined],
    [sha("topic-1"), "green", "pending"],
    [sha("topic-2"), "none", "green"],
  ]);
});

test("a projection takes from the journal only what it gained since the last time, and records of other repositories are not its own", () => {
  const repo = { ...BILLING, projectId: 42 };
  const stored: Array<{ seq: number; type: string; data: unknown }> = [];
  const add = (type: string, data: unknown) => stored.push({ seq: stored.length + 1, type, data });
  let returned = 0;
  const journal = {
    since: (from: number, types?: string[]) => {
      const found = stored.filter((one) => one.seq > Number(from) && (types === undefined || types.includes(one.type)));
      returned += found.length;
      return found;
    },
  } as unknown as Parameters<Seen["absorb"]>[0];
  const opened = (number: number, project: number) => ({ pr: { repo: { ...repo, projectId: project }, number }, title: "t", branch: "b", base: "main", source: { kind: "event", id: number } });
  add("forge.pr.opened", opened(1, 42));
  add("forge.pr.opened", opened(2, 43));
  const seen = new Seen(repo);
  seen.absorb(journal);
  expect([...seen.life.keys()]).toEqual([1]);
  expect(returned).toBe(2);
  seen.absorb(journal);
  expect(returned).toBe(2);
  add("forge.pr.opened", opened(3, 42));
  seen.absorb(journal);
  expect([...seen.life.keys()]).toEqual([1, 3]);
  expect(returned).toBe(3);
});

test("an event log of more than 2000 new events is written whole, oldest first, and the next poll finds nothing missing", async () => {
  const host = await watched();
  for (let at = 0; at < 2100; at += 1) {
    host.server.event(host.billing, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: sha(`from-${String(at)}`), commit_to: sha(`to-${String(at)}`) } });
  }
  expect((await syncNow(host)).written).toBe(2100);
  expect(await syncNow(host)).toEqual({ written: 0 });
  expect((await host.niwa.call(forgeRepoStatus, {})).items[0]).not.toHaveProperty("eventsMissed");
}, 30_000);

test("a log read down to its bound says that what lay beyond it was not seen, and writes what it read", async () => {
  const server = new FakeGitLab();
  const project = server.project(42, "acme/billing");
  const repo = { ...BILLING, projectId: 42 };
  for (let at = 0; at < 250; at += 1) server.event(project, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: null, commit_to: sha(`to-${String(at)}`) } });
  const stored: Array<{ seq: number; type: string; data: unknown; id: string }> = [];
  const journal = { since: (from: number, types?: string[]) => stored.filter((one) => one.seq > Number(from) && (types === undefined || types.includes(one.type))) } as unknown as JournalReader;
  const emit: Emit = async (type, data, opts) => {
    stored.push({ seq: stored.length + 1, type: type.name, data, id: opts.id ?? "" });
    return {} as never;
  };
  let gaps = 0;
  const gitlab = new GitLab({ url: server.url, token: () => server.token, fetch: server.fetch, now: () => 0 });
  const written = await sync({ gitlab, journal, emit, gap: () => (gaps += 1), eventPages: 2 }, repo);
  expect(gaps).toBe(1);
  expect(written).toBe(200);
  const whole = await sync({ gitlab, journal, emit, gap: () => (gaps += 1), eventPages: 3 }, repo);
  expect(gaps).toBe(1);
  expect(whole).toBe(0);
});

test("a repository says when it was last polled and what its last poll failed with, and a poll that found nothing is not a failure", async () => {
  const host = await watched();
  const status = async () => (await host.niwa.call(forgeRepoStatus, { repo: BILLING })).items;
  expect(await status()).toEqual([{ repo: { ...BILLING, projectId: 42 } }]);
  host.server.queue("GET", /\/events$/, 503, { message: "server is down" });
  await expect(syncNow(host)).rejects.toThrow(/503/);
  const [failed] = await status();
  expect(failed).toMatchObject({ lastError: expect.stringContaining("503") });
  expect(failed?.lastPassAt).toBeGreaterThan(0);
  expect(failed).not.toHaveProperty("lastOkAt");
  expect(await syncNow(host)).toEqual({ written: 0 });
  const [ok] = await status();
  expect(ok?.lastOkAt).toBeGreaterThan(0);
  expect(ok).not.toHaveProperty("lastError");
  expect((await host.niwa.call(forgeRepoStatus, {})).items).toHaveLength(1);
});

test("a repository that is not watched is not polled", async () => {
  const host = await forgeHost();
  hosts.push(host);
  await expect(syncNow(host)).rejects.toThrow(/not watched/);
});

test("the cadence: 20 seconds while waited on, 2 minutes after a change, 5 after an hour of quiet", () => {
  const now = 10_000_000;
  expect(pollInterval({ awaited: true, lastChangeAt: now - 7_200_000, now })).toBe(20_000);
  expect(pollInterval({ awaited: false, lastChangeAt: now - 60_000, now })).toBe(120_000);
  expect(pollInterval({ awaited: false, lastChangeAt: now - 3_600_000, now })).toBe(300_000);
  expect(DEFAULT_INTERVALS).toEqual({ awaited: 20_000, background: 120_000, quiet: 300_000 });
});

test("the poller passes over a repository when its interval is up, sooner while it is read, never while the limit is spent", () => {
  const poller = new Poller();
  const free = () => 0;
  let now = 0;
  expect(poller.due(["a"], now, free)).toEqual(["a"]);
  expect(poller.due(["a"], now, () => 5_000)).toEqual([]);
  poller.passed("a", now, 1);
  now += 60_000;
  expect(poller.due(["a"], now, free)).toEqual([]);
  now += 60_000;
  expect(poller.due(["a"], now, free)).toEqual(["a"]);
  poller.passed("a", now, 0);
  poller.touch("a", now);
  now += 20_000;
  expect(poller.due(["a"], now, free)).toEqual(["a"]);
  poller.passed("a", now, 0);
  now += 4_000_000;
  poller.passed("a", now, 0);
  now += 200_000;
  expect(poller.due(["a"], now, free)).toEqual([]);
  now += 100_000;
  expect(poller.due(["a"], now, free)).toEqual(["a"]);
});

test("with polling on, the module polls a watched repository by itself", async () => {
  const host = await watched({ forge: { poll: { awaited: 20, background: 20, quiet: 20 } } });
  host.server.event(host.billing, { action_name: "pushed new", push_data: { ref: "topic", ref_type: "branch", commit_from: null, commit_to: sha("topic-1") } });
  const deadline = Date.now() + 5_000;
  while ((await host.records([Pushed.name])).length === 0 && Date.now() < deadline) await sleep(20);
  expect(await dataOf(host, Pushed.name)).toEqual([expect.objectContaining({ ref: "topic", after: sha("topic-1") })]);
});

test("an automatic merge called off on the server is no longer pending after the next poll", async () => {
  const host = await watched();
  openMr(host);
  await host.niwa.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge", when: "pipeline" });
  await syncNow(host);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toHaveLength(1);
  host.billing.mrs.get(7)!.merge_when_pipeline_succeeds = false;
  await syncNow(host);
  await syncNow(host);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
  expect(await host.records(["forge.pr.merge.disarmed"])).toHaveLength(1);
});

test("a merge train that dropped a pull request is no longer pending after the next poll", async () => {
  const host = await watched();
  openMr(host);
  await host.niwa.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge", when: "train" });
  await syncNow(host);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toHaveLength(1);
  host.billing.mrs.get(7)!.in_train = false;
  await syncNow(host);
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});
