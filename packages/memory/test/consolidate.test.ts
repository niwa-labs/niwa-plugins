// Consolidation: notes that say the same are merged, the notes that earned it are lifted, the weakest
// drop out of a part of the top layer grown too long, stale or surplus notes are retired, and notes placed
// by hand stay where they are. A memory consolidates by itself as digests keep coming in.

import { afterEach, expect, test } from "bun:test";

import { AgentTurnQueued } from "@niwa-labs/agent/records";

import { closeAll, dataOf, memoryHost, owner, rin, until } from "./fixtures/host.ts";
import type { MemoryHost } from "./fixtures/host.ts";

afterEach(closeAll);

type Plan = { memory: string; merged: Array<{ note: string; into: string }>; lifted: string[]; dropped: string[]; retired: string[] };
type View = { note: string; status: string; top: boolean; sources: number; confirmed: boolean };

const DAY = 24 * 60 * 60 * 1000;

async function noted(host: MemoryHost, text: string, more: Record<string, unknown> = {}): Promise<string> {
  return (await host.as<{ note: string }>(rin, "memory.note", { text, ...more })).note;
}
const session = (n: number) => ({ kind: "session", session: `claude s-${String(n)}`, upto: "l-1" });
const view = (host: MemoryHost, note: string) => host.as<View>(rin, "memory.get", { note });

test("notes that came to say the same are merged into the older one, or into the one the owner confirmed", async () => {
  const host = await memoryHost();
  const fridays = await noted(host, "Releases go out on Fridays.", { source: session(1) });
  const thursdays = await noted(host, "Releases go out on Thursdays.", { source: session(2) });
  await host.as(rin, "memory.correct", { note: thursdays, text: "Releases go out on Fridays." });
  const tea = await noted(host, "He drinks green tea.", { about: "owner" });
  const teaToo = await noted(host, "He drinks black tea.", { about: "owner", source: session(3) });
  await host.as(rin, "memory.correct", { note: teaToo, text: "He drinks green tea" });
  await host.as(owner, "memory.confirm", { memory: "rin", note: teaToo });

  const plan = await host.as<Plan>(rin, "memory.consolidate", {});
  expect(plan.merged).toEqual([
    { note: thursdays, into: fridays },
    { note: tea, into: teaToo },
  ]);
  expect(await view(host, thursdays)).toMatchObject({ status: "merged" });
  expect(await view(host, fridays)).toMatchObject({ status: "live", sources: 2 });
  expect(await view(host, teaToo)).toMatchObject({ status: "live", confirmed: true });
});

test("a note is lifted once the owner confirmed it or it has enough sources; one dropped by hand stays out", async () => {
  const host = await memoryHost({ limits: { liftAfter: 3 } });
  const told = await noted(host, "Deploys need a review.", { source: session(1) });
  for (const n of [2, 3]) await noted(host, "Deploys need a review.", { source: session(n) });
  const confirmed = await noted(host, "He reads mail in the morning.", { about: "owner" });
  await host.as(owner, "memory.confirm", { memory: "rin", note: confirmed });
  const twice = await noted(host, "Tests run in CI.", { source: session(4) });
  await noted(host, "Tests run in CI.", { source: session(5) });
  const kept = await noted(host, "Lint runs before tests.", { source: session(6) });
  for (const n of [7, 8]) await noted(host, "Lint runs before tests.", { source: session(n) });
  await host.as(rin, "memory.drop", { note: kept });

  const plan = await host.as<Plan>(rin, "memory.consolidate", {});
  expect(plan.lifted.sort()).toEqual([told, confirmed].sort());
  expect(await view(host, twice)).toMatchObject({ top: false });
  expect(await view(host, kept)).toMatchObject({ top: false });
  expect((await host.as<{ notes: string[] }>(rin, "memory.top", {})).notes.sort()).toEqual([told, confirmed].sort());
  // Consolidated again, nothing more is to be done.
  expect(await host.as<Plan>(rin, "memory.consolidate", {})).toEqual({ memory: "rin", merged: [], lifted: [], dropped: [], retired: [] });
});

test("a part of the top layer grown too long keeps its strongest notes, and never drops one lifted by hand", async () => {
  const host = await memoryHost({ limits: { topNotes: 2 } });
  const byHand = await noted(host, "Weakest but placed by hand.");
  await host.as(rin, "memory.lift", { note: byHand });
  const weak = await noted(host, "Weaker note with sources.", { source: session(1) });
  for (const n of [2, 3]) await noted(host, "Weaker note with sources.", { source: session(n) });
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).lifted).toEqual([weak]);

  const strong = await noted(host, "Strong note with sources.", { source: session(4) });
  for (const n of [5, 6, 7]) await noted(host, "Strong note with sources.", { source: session(n) });
  const plan = await host.as<Plan>(rin, "memory.consolidate", {});
  expect(plan.lifted).toEqual([strong]);
  expect(plan.dropped).toEqual([weak]);
  expect((await host.as<{ notes: string[] }>(rin, "memory.top", {})).notes.sort()).toEqual([byHand, strong].sort());
  // A note that would not fit is not lifted to be dropped at once.
  const weaker = await noted(host, "Weakest note with sources.", { source: session(8) });
  for (const n of [9, 10]) await noted(host, "Weakest note with sources.", { source: session(n) });
  expect(await host.as<Plan>(rin, "memory.consolidate", {})).toMatchObject({ lifted: [], dropped: [] });
  expect(await view(host, weaker)).toMatchObject({ top: false });
});

test("an unconfirmed note of one source goes stale and is retired; past the limit the oldest are retired", async () => {
  const host = await memoryHost({ limits: { notes: 3, staleAfter: 30 * DAY } });
  const stale = await noted(host, "The office is on the third floor.");
  const confirmed = await noted(host, "He works from home on Mondays.", { about: "owner" });
  await host.as(owner, "memory.confirm", { memory: "rin", note: confirmed });
  const sourced = await noted(host, "The build takes ten minutes.", { source: session(1) });
  await noted(host, "The build takes ten minutes.", { source: session(2) });
  await host.clock.advance(31 * DAY);
  const recent = await noted(host, "The coffee machine is broken.");
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).retired).toEqual([stale]);
  expect(await view(host, stale)).toMatchObject({ status: "retired" });
  expect((await host.as<{ hits: unknown[] }>(rin, "memory.search", { query: "office floor" })).hits).toEqual([]);

  const newer = await noted(host, "Standup is at ten.");
  const newest = await noted(host, "Lunch is at one.");
  // Five hold and three fit: the oldest that are neither confirmed, placed by hand nor in the top layer go.
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).retired).toEqual([sourced, recent]);
  expect((await host.as<{ notes: Array<{ note: string }> }>(rin, "memory.list", {})).notes.map((one) => one.note)).toEqual([newest, newer, confirmed]);
});

test("a memory consolidates by itself once enough has changed in it as digests come in", async () => {
  const host = await memoryHost({ limits: { consolidateEvery: 3, liftAfter: 2 } });
  const note = await noted(host, "Invoices are made nightly.", { source: session(1) });
  await noted(host, "Invoices are made nightly.", { source: session(2) });
  const digest = (turn: string) => ({
    agent: "rin",
    turn,
    kind: "fact" as const,
    author: { kind: "niwa" as const, by: "workflow" },
    text: "The session paused.",
    source: { kind: "session-digest" as const, session: "claude s-1", upto: turn },
  });
  await host.host.emit(AgentTurnQueued, digest("fact-000001"));
  const records = await until(host, "memory.consolidated");
  expect(dataOf(records, "memory.consolidated")).toEqual([{ memory: "rin", merged: [], lifted: [note], dropped: [], retired: [] }]);
  // Only one change since: the next digest does not consolidate again.
  await host.host.emit(AgentTurnQueued, digest("fact-000002"));
  await until(host, "memory.digest.taken", 2);
  expect(dataOf(await host.records(), "memory.consolidated")).toHaveLength(1);
});

test("a note the owner confirmed is never retired, even outside the top layer and past the limit", async () => {
  const host = await memoryHost({ limits: { topNotes: 1, notes: 1, staleAfter: DAY } });
  const older = await noted(host, "He works from home on Mondays.", { about: "owner" });
  const newer = await noted(host, "He takes calls after ten.", { about: "owner" });
  for (const note of [older, newer]) await host.as(owner, "memory.confirm", { memory: "rin", note });
  await host.clock.advance(2 * DAY);
  const plan = await host.as<Plan>(rin, "memory.consolidate", {});
  expect(plan.lifted).toEqual([newer]);
  expect(plan.retired).toEqual([]);
  expect(await view(host, older)).toMatchObject({ status: "live", top: false });
});

test("a corrected note stands on its new text alone: the sources of the old one and its place in the top layer do not carry over", async () => {
  const host = await memoryHost({ limits: { liftAfter: 3 } });
  const note = await noted(host, "Deploys need a review.", { source: session(1) });
  for (const n of [2, 3]) await noted(host, "Deploys need a review.", { source: session(n) });
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).lifted).toEqual([note]);
  expect(await view(host, note)).toMatchObject({ top: true, sources: 3 });

  await host.as(rin, "memory.correct", { note, text: "Deploys need no review." });
  expect(await view(host, note)).toMatchObject({ top: false, sources: 1, confirmed: false, revision: 2, by: rin, source: { kind: "inferred" } });
  expect(await host.as<Plan>(rin, "memory.consolidate", {})).toMatchObject({ lifted: [] });
  expect((await host.as<{ notes: string[] }>(rin, "memory.top", {})).notes).toEqual([]);
  // The new text earns its own sources.
  for (const n of [4, 5]) await noted(host, "Deploys need no review.", { source: session(n) });
  expect(await view(host, note)).toMatchObject({ sources: 3 });
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).lifted).toEqual([note]);
});

test("the owner's correction is his word and one source; a note placed by hand keeps its place through a correction", async () => {
  const host = await memoryHost({ limits: { liftAfter: 3 } });
  const note = await noted(host, "Deploys need a review.", { source: session(1) });
  for (const n of [2, 3]) await noted(host, "Deploys need a review.", { source: session(n) });
  const placed = await noted(host, "Lint runs before tests.");
  await host.as(rin, "memory.lift", { note: placed });
  await host.as<Plan>(rin, "memory.consolidate", {});

  await host.as(owner, "memory.correct", { memory: "rin", note, text: "Deploys need two reviews." });
  expect(await view(host, note)).toMatchObject({ top: false, sources: 1, confirmed: true, by: owner, source: { kind: "owner" } });
  expect((await host.as<Plan>(rin, "memory.consolidate", {})).lifted).toEqual([note]);

  await host.as(rin, "memory.correct", { note: placed, text: "Lint runs after tests." });
  expect(await view(host, placed)).toMatchObject({ top: true, pinned: true, sources: 1 });
});
