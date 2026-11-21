// The script helpers, over the globals a workflow script is given: what they call, what they wait
// for, and what they answer.

import { afterEach, expect, test } from "bun:test";

import { durationMs, land, untilPipeline } from "../src/flow.ts";
import { sha } from "./fake-gitlab.ts";

const repo = { host: "gitlab.example.com", path: "acme/billing" };
const head = sha("topic-1");

interface Seen {
  calls: Array<{ name: string; input: any; label?: string }>;
  waits: Array<{ type: string; opts: any }>;
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
    const next = answers.calls[name]?.shift();
    if (next === undefined) throw new Error(`no answer for ${name}`);
    return next;
  };
  globals.wait = async (type: string, opts: unknown) => {
    seen.waits.push({ type, opts });
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
  expect(seen.waits[0]?.opts).toEqual({
    filter: { "repo.host": repo.host, "repo.path": repo.path, sourceSha: head, kind: "merge-result" },
    timeout: 300_000,
    label: "ci-wait-1",
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

test("an automatic landing waits for the merge, and a merge at another head is not this landing", async () => {
  const armed = { outcome: "armed", externalId: "gitlab.example.com/acme/billing!7", cancel: "forge.pr.merge.cancel" };
  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ data: { head, mergeSha: sha("m") }, at: 9 }] } });
  expect(await land("land", { pr: { repo, number: 7 }, expectHead: head, method: "merge", auto: true })).toEqual({ outcome: "merged", sha: sha("m") });

  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ data: { head: sha("other") }, at: 9 }] } });
  expect(await land("land", { pr: { repo, number: 7 }, expectHead: head, method: "merge", auto: true })).toMatchObject({ outcome: "refused" });

  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merge.disarmed": [{ data: {}, at: 9 }] } });
  expect(await land("land", { pr: { repo, number: 7 }, expectHead: head, method: "merge", auto: true })).toMatchObject({ outcome: "refused", why: expect.stringContaining("called off") });

  scriptWith({ calls: { "forge.pr.merge": [armed] }, waits: { "forge.pr.merged": [{ timedOut: true }] } });
  expect(await land("land", { pr: { repo, number: 7 }, expectHead: head, method: "merge", auto: true, deadline: "1h" })).toMatchObject({ outcome: "queued-unknown" });
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
