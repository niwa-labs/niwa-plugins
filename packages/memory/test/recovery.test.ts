// An operation made again after its record was written but before its result was saved finds what it wrote and
// answers as the first run did, instead of failing against its own work.

import { afterEach, expect, test } from "bun:test";

import type { Address } from "@niwa-labs/core";

import { closeAll, dataOf, memoryHost, rin } from "./fixtures/host.ts";

afterEach(closeAll);

const WHO = { memory: "rin" };

test("a page written again under the same operation answers the revision it wrote", async () => {
  const host = await memoryHost();
  const write = { ...WHO, page: "billing", title: "Billing", text: "How billing works.", revision: 0 };
  expect(await host.again("memory.page.write", write, "op-page-1")).toEqual({ page: "billing", revision: 1 });
  expect(await host.again("memory.page.write", write, "op-page-1")).toEqual({ page: "billing", revision: 1 });
  expect(dataOf(await host.records(), "memory.page.written")).toHaveLength(1);
  // Another operation is still refused for a revision that is out of date.
  await expect(host.again("memory.page.write", write, "op-page-2")).rejects.toThrow(/revision 1, not 0/);
});

test("a consolidation made again answers the plan it recorded, not a new empty one", async () => {
  const host = await memoryHost();
  const first = (await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Fridays.", source: { kind: "session", session: "claude s-1", upto: "l-1" } })).note;
  const second = (await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Thursdays.", source: { kind: "session", session: "claude s-2", upto: "l-1" } })).note;
  await host.as(rin, "memory.correct", { note: second, text: "Releases go out on Fridays." });
  const plan = await host.again<{ merged: unknown[] }>("memory.consolidate", WHO, "op-consolidate-1");
  expect(plan.merged).toEqual([{ note: second, into: first }]);
  expect(await host.again("memory.consolidate", WHO, "op-consolidate-1")).toEqual(plan);
  expect(dataOf(await host.records(), "memory.consolidated")).toHaveLength(1);
});

test("a correction made again answers the revision it made", async () => {
  const host = await memoryHost();
  const { note } = await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Fridays." });
  const correct = { ...WHO, note, text: "Releases go out on Thursdays." };
  expect(await host.again("memory.correct", correct, "op-correct-1")).toEqual({ note, revision: 2 });
  expect(await host.again("memory.correct", correct, "op-correct-1")).toEqual({ note, revision: 2 });
  expect(dataOf(await host.records(), "memory.note.corrected")).toHaveLength(1);
});

test("a note written again under the same operation is the note it wrote, not a copy of it", async () => {
  const host = await memoryHost();
  const write = { ...WHO, text: "Releases go out on Fridays." };
  const first = await host.again<{ note: string; corroborated: boolean }>("memory.note", write, "op-note-1");
  expect(first.corroborated).toBe(false);
  expect(await host.again("memory.note", write, "op-note-1")).toEqual(first);
  // The same words under another operation are one more source of it.
  expect(await host.again("memory.note", { ...write, source: { kind: "session", session: "claude s-1", upto: "l-1" } }, "op-note-2")).toEqual({ ...first, corroborated: true });
  const corroborated = { ...WHO, text: "Releases go out on Fridays.", source: { kind: "session", session: "claude s-3", upto: "l-1" } };
  const joined = await host.again("memory.note", corroborated, "op-note-3");
  expect(await host.again("memory.note", corroborated, "op-note-3")).toEqual(joined);
  expect(dataOf(await host.records(), "memory.note.corroborated")).toHaveLength(2);
});

test("a context request cut after some of its questions is made again without writing them twice or colliding", async () => {
  const host = await memoryHost();
  const client: Address = { kind: "client", id: "reader" };
  const notes: string[] = [];
  for (const month of ["May", "June", "July"]) notes.push((await host.as<{ note: string }>(rin, "memory.note", { text: `He is on leave in ${month}.`, about: "owner" })).note);
  const ask = { memory: "rin", query: "leave", purpose: "to plan", for: client, limit: 5 };
  await expect(host.again("memory.context", ask, "op-context-1", 2)).rejects.toThrow(/cut/);
  expect(dataOf(await host.records(), "memory.share.wanted")).toHaveLength(2);
  const told = await host.again<{ withheld: Array<{ note: string; status: string }> }>("memory.context", ask, "op-context-1");
  expect(told.withheld.map((one) => one.status)).toEqual(["asked", "asked", "asked"]);
  const wanted = dataOf(await host.records(), "memory.share.wanted") as Array<{ note: string }>;
  expect(wanted.map((one) => one.note).sort()).toEqual([...notes].sort());
});
