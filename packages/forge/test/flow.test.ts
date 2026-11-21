// The script helpers, over the globals a workflow script is given: what they call, what they wait
// for, and what they answer.

import { afterEach, expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import { forgePipelineRead, forgePrMerge, forgePrRead } from "../src/actions.ts";
import { durationMs, land, untilHeadMoved, untilPipeline } from "../src/flow.ts";
import { sha } from "./fake-gitlab.ts";

const repo = { host: "gitlab.example.com", path: "acme/billing" };
const head = sha("topic-1");

interface Seen {
  calls: Array<{ name: string; input: any; label?: string }>;
  waits: Array<{ type: string; filter: unknown; opts: any }>;
}

const globals = globalThis as Record<string, unknown>;
afterEach(() => {
  for (const name of ["call", "wait", "now", "race"]) delete globals[name];
});

/** Script globals over answers the test gives: each call and wait takes the next of its list. */
function scriptWith(answers: { calls: Record<string, any[]>; waits?: Record<string, any[]>; clock?: number[] }): Seen {
  const seen: Seen = { calls: [], waits: [] };
  const clock = [...(answers.clock ?? [])];
  globals.call = async (name: string, input: unknown, opts?: { label?: string }) => {
    seen.calls.push({ name, input, ...(opts?.label === undefined ? {} : { label: opts.label }) });
    // The host holds a call to the schema of its action: so does the script.
    const refs = { [forgePipelineRead.name]: forgePipelineRead, [forgePrMerge.name]: forgePrMerge, [forgePrRead.name]: forgePrRead };
    refs[name]?.input.parse(input);
    const next = answers.calls[name]?.shift();
    if (next === undefined) throw new Error(`no answer for ${name}`);
    return next;
  };
  // A script waits for a query a builder gave, of one type: the host holds it to the catalogue.
  globals.wait = async (query: Parameters<typeof resolveQuery>[0], opts: unknown) => {
    const resolved = resolveQuery(query);
    const [type] = resolved.types ?? [];
    if (resolved.types?.length !== 1 || type === undefined) throw new Error("a wait names one type");
    seen.waits.push({ type, filter: resolved.filter, opts });
    const next = answers.waits?.[type]?.shift();
    return next ?? new Promise(() => {});
  };
  globals.now = async () => clock.shift() ?? 0;
  globals.race = async (_name: string, branches: Record<string, () => Promise<unknown>>) =>
    await Promise.race(Object.entries(branches).map(async ([key, run]) => ({ key, value: await run() })));
  return seen;
}

const pipeline = (id: number, state: string, kind = "head") => ({ repo: { ...repo, projectId: 42 }, pipeline: id, kind, ref: "main", sourceSha: head, state });

test("a pipeline that already settled answers at once", async () => {
  const seen = scriptWith({ calls: { "forge.pipeline.read": [{ items: [pipeline(5, "success"), pipeline(4, "failed")] }] }, clock: [0] });
  expect(await untilPipeline("ci", { repo, sha: head, deadline: "40m" })).toEqual({ outcome: "green", pipeline: 5 });
  expect(seen.waits).toEqual([]);
});

test("a running pipeline is waited for by its commit, and read again when a record of it arrives", async () => {
  const seen = scriptWith({
    calls: { "forge.pipeline.read": [{ items: [pipeline(5, "running", "merge-result")] }, { items: [pipeline(5, "failed", "merge-result")] }] },
    waits: { "forge.pipeline": [{ data: {}, at: 77 }] },
    clock: [0, 1_000],
  });
  expect(await untilPipeline("ci", { repo, sha: head, kind: "merge-result", deadline: "40m" })).toEqual({ outcome: "red", pipeline: 5 });
  expect(seen.calls.map((one) => [one.input.kind, one.label])).toEqual([
    ["merge-result", "ci-read-1"],
    ["merge-result", "ci-read-2"],
  ]);
  expect(seen.waits[0]).toMatchObject({
    type: "forge.pipeline",
    filter: { "repo.host": repo.host, "repo.path": repo.path, sourceSha: head, kind: "merge-result" },
    opts: { timeout: 300_000, label: "ci-wait-1" },
  });
});

test("a pipeline still running at the deadline times out", async () => {
  scriptWith({
    calls: { "forge.pipeline.read": [{ items: [] }, { items: [pipeline(5, "running")] }] },
    waits: { "forge.pipeline": [{ timedOut: true }] },
    clock: [0, 1_000, 2_400_000],
  });
  expect(await untilPipeline("ci", { repo, sha: head, deadline: "40m" })).toEqual({ outcome: "timed-out" });
});

test("landing at once answers the commit the merge made, and a refusal says why", async () => {
  const seen = scriptWith({
    calls: { "forge.pr.merge": [{ outcome: "merged", sha: sha("m"), externalId: "x" }, { outcome: "refused", why: "SHA does not match" }] },
  });
  expect(await land("land", { pr: { repo, number: 7 }, expectHead: head, method: "squash" })).toEqual({ outcome: "merged", sha: sha("m") });
  expect(seen.calls[0]).toEqual({ name: "forge.pr.merge", input: { repo, number: 7, expectHead: head, method: "squash", when: "now" }, label: "land-merge" });
  expect(await land("again", { pr: { repo, number: 7 }, expectHead: head, method: "merge" })).toEqual({ outcome: "refused", why: "SHA does not match" });
});

const armed = { outcome: "armed", externalId: "gitlab.example.com/acme/billing!7", cancel: "forge.pr.merge.cancel" };
const read = (state: string, fields: Record<string, unknown> = {}) => ({
  pr: { repo: { ...repo, projectId: 42 }, number: 7 },
  state,
  title: "t",
  branch: "topic",
  base: "main",
  head,
  draft: false,
  autoMerge: state === "open",
  ...fields,
});
const auto = { pr: { repo, number: 7 }, expectHead: head, method: "merge", auto: true } as const;

test("an automatic landing waits for the merge, and a merge at another head is not this landing", async () => {
  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ data: { head, mergeSha: sha("m") }, at: 9 }] } });
  expect(await land("land", auto)).toEqual({ outcome: "merged", sha: sha("m") });

  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ data: { head: sha("other") }, at: 9 }] } });
  expect(await land("land", auto)).toMatchObject({ outcome: "refused" });

  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merge.disarmed": [{ data: {}, at: 9 }] } });
  expect(await land("land", auto)).toMatchObject({ outcome: "refused", why: expect.stringContaining("called off") });
});

test("an automatic landing still waiting at the deadline reads the pull request first and is queued-unknown", async () => {
  const seen = scriptWith({
    calls: { "forge.pr.merge": [armed], "forge.pr.read": [read("open")] },
    waits: { "forge.pr.merged": [{ timedOut: true }] },
    clock: [0, 300_000],
  });
  expect(await land("land", { ...auto, deadline: "5m" })).toMatchObject({ outcome: "queued-unknown" });
  expect(seen.calls.filter((one) => one.name === "forge.pr.read")).toHaveLength(1);
  expect(seen.waits[0]?.opts.timeout).toBe(300_000);
});

test("a merge that was recorded before the waits began, or never recorded, is found by reading the pull request", async () => {
  const seen = scriptWith({
    calls: { "forge.pr.merge": [armed], "forge.pr.read": [read("merged", { mergeSha: sha("m"), autoMerge: false })] },
    waits: { "forge.pr.merged": [{ timedOut: true }] },
    clock: [0],
  });
  expect(await land("land", { ...auto, deadline: "2h" })).toEqual({ outcome: "merged", sha: sha("m") });
  expect(seen.waits.every((one) => one.opts.timeout === 300_000)).toBe(true);
  expect(seen.calls.at(-1)).toMatchObject({ name: "forge.pr.read", input: { repo, number: 7 } });

  scriptWith({
    calls: { "forge.pr.merge": [armed], "forge.pr.read": [read("merged", { head: sha("other"), mergeSha: sha("m"), autoMerge: false })] },
    waits: { "forge.pr.merged": [{ timedOut: true }] },
    clock: [0],
  });
  expect(await land("land", auto)).toMatchObject({ outcome: "refused", why: expect.stringContaining("not at") });
});

test("a pull request the server no longer holds for merging is refused when the read says so, not after the deadline", async () => {
  scriptWith({
    calls: { "forge.pr.merge": [armed], "forge.pr.read": [read("open", { autoMerge: false })] },
    waits: { "forge.pr.merged": [{ timedOut: true }] },
    clock: [0],
  });
  expect(await land("land", auto)).toMatchObject({ outcome: "refused", why: expect.stringContaining("no longer") });

  scriptWith({ calls: { "forge.pr.merge": [armed], "forge.pr.read": [read("closed", { autoMerge: false })] }, waits: { "forge.pr.merged": [{ timedOut: true }] }, clock: [0, 0] });
  expect(await land("land", auto)).toMatchObject({ outcome: "refused", why: expect.stringContaining("closed") });
});

test("durations are milliseconds or a number with a unit", () => {
  expect(durationMs(250)).toBe(250);
  expect(durationMs("40m")).toBe(2_400_000);
  expect(durationMs("2h")).toBe(7_200_000);
  expect(() => durationMs("soon")).toThrow(/duration/);
});

test("a helper called outside a script says so", async () => {
  await expect(untilPipeline("ci", { repo, sha: head, deadline: "1m" })).rejects.toThrow(/workflow script/);
});

test("a pipeline that waits on a manual job is still pending, as the checks of a pull request say", async () => {
  scriptWith({
    calls: { "forge.pipeline.read": [{ items: [pipeline(5, "manual")] }, { items: [pipeline(5, "success")] }] },
    waits: { "forge.pipeline": [{ data: {}, at: 3 }] },
    clock: [0, 1_000],
  });
  expect(await untilPipeline("ci", { repo, sha: head, deadline: "40m" })).toEqual({ outcome: "green", pipeline: 5 });
});

test("the helpers take the repository of a record, whose project id the actions do not", async () => {
  const known = { ...repo, projectId: 42 };
  const seen = scriptWith({
    calls: {
      "forge.pipeline.read": [{ items: [pipeline(5, "success")] }],
      "forge.pr.merge": [{ outcome: "merged", sha: sha("m"), externalId: "x" }],
    },
    clock: [0],
  });
  expect(await untilPipeline("ci", { repo: known, sha: head, deadline: "40m" })).toEqual({ outcome: "green", pipeline: 5 });
  expect(seen.calls[0]?.input.repo).toEqual(repo);
  expect(await land("land", { pr: { repo: known, number: 7 }, expectHead: head, method: "merge" })).toMatchObject({ outcome: "merged" });
  expect(seen.calls[1]?.input.repo).toEqual(repo);
});

test("landing waits for the merge, the close and the call-off of the pull request, each by its query", async () => {
  const seen = scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ data: { head, mergeSha: sha("m") }, at: 9 }] } });
  await land("land", auto);
  const filter = { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": 7 };
  expect(seen.waits.map((one) => [one.type, one.filter, one.opts.label])).toEqual([
    ["forge.pr.merged", filter, "land-merged-1"],
    ["forge.pr.closed", filter, "land-closed-1"],
    ["forge.pr.merge.disarmed", filter, "land-disarmed-1"],
  ]);
});

const pr = { repo, number: 7 };

test("a script waits for the head of a pull request to move, and is told where to go on from", async () => {
  const seen = scriptWith({ calls: {}, waits: { "forge.pr.head": [{ data: { head: sha("b"), previous: head }, at: 31 }, { data: { head: sha("c") }, at: 40 }, { timedOut: true }] } });
  expect(await untilHeadMoved("head", { pr, from: 12, timeout: "30m" })).toEqual({ moved: true, head: sha("b"), previous: head, at: 31 });
  expect(await untilHeadMoved("head-2", { pr, from: 31 })).toEqual({ moved: true, head: sha("c"), at: 40 });
  expect(await untilHeadMoved("head-3", { pr, from: 40, timeout: 1000 })).toEqual({ moved: false });
  expect(seen.waits.map((one) => one.opts)).toEqual([
    { from: 12, timeout: "30m", label: "head" },
    { from: 31, label: "head-2" },
    { from: 40, timeout: 1000, label: "head-3" },
  ]);
  expect(seen.waits[0]?.filter).toEqual({ "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": 7 });
});
