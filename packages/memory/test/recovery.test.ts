// An operation made again after its record was written but before its result was saved finds what it wrote and
// answers as the first run did, instead of failing against its own work.

import { afterEach, expect, test } from "bun:test";

import { record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { fileURLToPath } from "node:url";
import { connectAsOwner, eventually, gate, spawnHost, tempHome } from "@niwa-labs/testing";
import { z } from "zod";
import { memory } from "../src/index.ts";
import { ConsolidationStarted, Consolidated, memoryConsolidate, PageItemChanged, PageWritten } from "../src/records.ts";
import type { PageView } from "../src/records.ts";
import type { Address } from "@niwa-labs/core";

import { closeAll, dataOf, memoryHost, rin, until } from "./fixtures/host.ts";

afterEach(closeAll);

const WHO = { memory: "rin" };

test("a page written again under the same operation answers the revision it wrote", async () => {
  const host = await memoryHost();
  const write = { ...WHO, page: "billing", title: "Billing", revision: 0 };
  expect(await host.again("memory.page.write", write, "op-page-1")).toEqual({ page: "billing", revision: 1 });
  expect(await host.again("memory.page.write", write, "op-page-1")).toEqual({ page: "billing", revision: 1 });
  expect(dataOf(await host.records(), PageWritten.name)).toHaveLength(1);
  // Another operation is still refused for a revision that is out of date.
  await expect(host.again("memory.page.write", write, "op-page-2")).rejects.toThrow(/revision 1, not 0/);
  await host.again("memory.page.write", { ...write, revision: 1, title: "Revised" }, "advance");
  await expect(host.again("memory.page.write", write, "op-page-2")).rejects.toThrow(/revision 1, not 0/);
});

test("repeating put or remove returns its recorded revision after later edits", async () => {
  const host = await memoryHost();
  const page = "billing";
  const item = "schedule";
  const { note } = await host.as<{ note: string }>(rin, "memory.note", { text: "Invoices are made nightly." });
  await host.as(rin, "memory.page.write", { page, title: "Billing" });
  const put = { ...WHO, page, item, note, position: 0, revision: 1 };
  const remove = { ...WHO, page, item, revision: 2 };
  expect(await host.again("memory.page.item.put", put, "op-put")).toEqual({ page, revision: 2 });
  expect(await host.again("memory.page.item.remove", remove, "op-remove")).toEqual({ page, revision: 3 });
  await host.as(rin, "memory.erase", { note });
  const replacement = await host.as<{ note: string }>(rin, "memory.note", { text: "Invoices are made hourly." });
  await host.as(rin, "memory.page.item.put", { ...put, note: replacement.note, revision: 3 });

  const reopened = await memoryHost({}, { home: await host.leave() });
  expect(await reopened.again("memory.page.item.put", put, "op-put")).toEqual({ page, revision: 2 });
  expect(await reopened.again("memory.page.item.remove", remove, "op-remove")).toEqual({ page, revision: 3 });
  await expect(reopened.again("memory.page.item.remove", remove, "op-other-remove")).rejects.toThrow(/revision 4, not 2/);
  expect(dataOf(await reopened.records(), PageItemChanged.name)).toMatchObject([
    { kind: "put", page, item, note, revision: 2 },
    { kind: "remove", page, item, revision: 3 },
    { kind: "put", page, item, note: replacement.note, revision: 4 },
  ]);
  expect(await reopened.as<PageView>(rin, "memory.page.get", { page })).toMatchObject({ revision: 4, items: [{ item, note: replacement.note }] });
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

for (const transport of ["host", "wire"] as const) {
  test(`an unkeyed ${transport} consolidation is finished under its original operation before the next nightly run`, async () => {
    const cut = Promise.withResolvers<void>();
    const first = await memoryHost({}, { afterClaim: () => cut.promise });
    const { note } = await first.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Fridays." });
    await first.as({ kind: "owner" }, "memory.confirm", { ...WHO, note });
    const client = transport === "wire" ? await connectAsOwner(first.home) : first.host;
    const interrupted = client.call(memoryConsolidate, WHO);
    try {
      const claim = (await until(first, "memory.consolidation.started")).find(row => row.type === "memory.consolidation.started")!;
      const { operation } = claim.data as { operation: string };
      expect(String(claim.id)).toBe(`${operation}/emit/1`);
      await expect(first.host.call(memoryConsolidate, WHO)).rejects.toThrow(/consolidation/);
      expect(dataOf(await first.records(), "memory.consolidated")).toHaveLength(0);
      cut.reject(new Error("cut after claim"));
      await expect(interrupted).rejects.toThrow(/cut after claim/);
      if (transport === "wire") await client.close();
      const night = record("test.night", z.object({}));
      const nightly = plugin("nightly", api => {
        api.declare(night);
        api.on(night, async (_, step) => { await step(memoryConsolidate, WHO, { key: "nightly" }); });
      });
      const resumed = await memoryHost({}, { home: await first.leave(), after: [nightly] });
      await resumed.host.emit(night, {});
      const rows = (await until(resumed, "memory.consolidated", 2)).filter(row => row.type === "memory.consolidated");
      expect(String(rows[0]!.id)).toBe(`${operation}/emit/2`);
      expect(rows[0]!.data).toMatchObject({ operation, lifted: [note] });
      expect(rows[1]!.data).toMatchObject({ lifted: [] });
      expect((rows[1]!.data as { operation: string }).operation).not.toBe(operation);
      expect(await resumed.again("memory.consolidate", WHO, operation)).toMatchObject({ lifted: [note] });
      expect(dataOf(await resumed.records(), "memory.consolidated")).toHaveLength(2);
    } finally {
      cut.resolve();
      await interrupted.catch(() => {});
    }
  });
}

test("only one page written against revision zero becomes revision one", async () => {
  const host = await memoryHost();
  const write = { ...WHO, page: "billing", revision: 0 };
  const results = await Promise.allSettled(["one", "two"].map(title =>
    host.again("memory.page.write", { ...write, title }, title)));
  expect(results.filter(one => one.status === "fulfilled")).toHaveLength(1);
  expect(dataOf(await host.records(), PageWritten.name)).toHaveLength(1);
  await host.close();
});

test("metadata, put and remove compete for the same next page revision", async () => {
  const host = await memoryHost();
  const page = "billing";
  const { note } = await host.as<{ note: string }>(rin, "memory.note", { text: "Invoices are made nightly." });
  await host.as(rin, "memory.page.write", { page, title: "Billing" });
  await host.as(rin, "memory.page.item.put", { page, item: "schedule", note, position: 0, revision: 1 });
  const input = { ...WHO, page, revision: 2 };
  const results = await Promise.allSettled([
    host.again("memory.page.write", { ...input, title: "Invoice schedule" }, "race-metadata"),
    host.again("memory.page.item.put", { ...input, item: "schedule", note, position: 1 }, "race-put"),
    host.again("memory.page.item.remove", { ...input, item: "schedule" }, "race-remove"),
  ]);
  const won = results.filter(result => result.status === "fulfilled");
  const stale = results.filter(result => result.status === "rejected");
  expect(won).toEqual([{ status: "fulfilled", value: { page, revision: 3 } }]);
  expect(stale).toHaveLength(2);
  for (const result of stale) expect(String(result.reason)).toMatch(/revision 3, not 2/);
  const rows = await host.records();
  const revisions = [...dataOf(rows, PageWritten.name), ...dataOf(rows, PageItemChanged.name)] as Array<{ revision: number }>;
  expect(revisions.map(row => row.revision).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  expect((await host.as<PageView>(rin, "memory.page.get", { page })).revision).toBe(3);
  await expect(host.again("memory.page.item.remove", { ...input, revision: 5, item: "missing" }, "future-remove")).rejects.toThrow(/revision 3, not 5/);
});

test("replacing memory leaves an active consolidation with the writer that claimed it", async () => {
  const claimed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const live = await memoryHost({}, {afterClaim: async () => {
    claimed.resolve();
    await release.promise;
  }});
  const first = live.host.call(memoryConsolidate, WHO);
  try {
    await claimed.promise;
    live.host.use(memory());
    await expect(live.host.call(memoryConsolidate, WHO)).rejects.toThrow(/consolidation/);
    expect(dataOf(await live.records(), "memory.consolidated")).toHaveLength(0);
    release.resolve();
    await first;
    expect(dataOf(await live.records(), "memory.consolidated")).toHaveLength(1);
  } finally { release.resolve(); await first.catch(() => {}); }
});

test("a new host process finishes an unkeyed consolidation interrupted at its claim", async () => {
  const home = await tempHome();
  const script = fileURLToPath(new URL("./fixtures/host.ts", import.meta.url));
  let host = spawnHost(script, home.path);
  let client;
  try {
    await host.ready();
    client = await connectAsOwner(home.path);
    const first = client;
    const pending = first.call(memoryConsolidate, WHO).catch(() => undefined);
    await eventually(async () => (await first.records.read({types: [ConsolidationStarted]})).length === 1);
    const [claim] = await first.records.read({types: [ConsolidationStarted]});
    const {operation} = ConsolidationStarted.schema.parse(claim!.data);
    await host.kill();
    await first.close();
    await pending;
    gate(home.path, "finish-consolidation").open();
    host = spawnHost(script, home.path);
    await host.ready();
    client = await connectAsOwner(home.path);
    await client.call(memoryConsolidate, WHO);
    const receipts = await client.records.read({types: [Consolidated]});
    expect(receipts).toHaveLength(2);
    expect(String(receipts[0]!.id)).toBe(`${operation}/emit/2`);
    expect(Consolidated.schema.parse(receipts[1]!.data).operation).not.toBe(operation);
  } finally { await client?.close(); await host.kill(); await home.cleanup(); }
}, 20_000);
