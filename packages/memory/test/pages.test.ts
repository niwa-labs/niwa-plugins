import { afterEach, expect, test } from "bun:test";
import { record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";

import { Consolidated, PageItemChanged, PageWritten } from "../src/records.ts";
import type { NoteView, PageSummary, PageView } from "../src/records.ts";
import { bob, closeAll, dataOf, memoryHost, owner, rin, until } from "./fixtures/host.ts";

afterEach(closeAll);

type Noted = Pick<NoteView, "note">;

test("page metadata has revisions and changing it preserves the items", async () => {
  const host = await memoryHost();
  const page = "projects/billing";
  const metadata = { page, title: "Billing", project: "/work/billing" };
  expect(await host.as(rin, "memory.page.write", { ...metadata, revision: 0 })).toEqual({ page, revision: 1 });
  const first = await host.as<PageView>(rin, "memory.page.get", { page });
  expect(first).toMatchObject({ ...metadata, revision: 1, items: [] });

  const { note } = await host.as<Noted>(rin, "memory.note", { text: "Invoices are made nightly." });
  await host.as(rin, "memory.page.item.put", { page, item: "schedule", note, position: 0, revision: 1 });
  await expect(host.as(rin, "memory.page.write", { ...metadata, revision: 1 })).rejects.toThrow(/revision 2, not 1/);
  expect(await host.as(rin, "memory.page.write", { ...metadata, title: "Invoice schedule", revision: 2 })).toEqual({ page, revision: 3 });
  const renamed = await host.as<PageView>(rin, "memory.page.get", { page });
  expect(renamed).toMatchObject({ title: "Invoice schedule", revision: 3 });
  expect(renamed.items).toEqual([{ item: "schedule", note, position: 0, text: "Invoices are made nightly.", source: { kind: "inferred" } }]);
  expect(await host.as<PageView>(rin, "memory.page.get", { page, at: first.seq })).toEqual(first);
  await expect(host.as(rin, "memory.page.get", { page: "nothing" })).rejects.toThrow(/no page/);
  await expect(host.as(rin, "memory.page.write", { ...metadata, text: "Legacy text." })).rejects.toThrow();
  await expect(host.as(rin, "memory.page.write", { page: "big", title: "x".repeat(201) })).rejects.toThrow();
});

test("two placements of a note keep their own context, and moving or removing one leaves the other in place", async () => {
  const host = await memoryHost();
  const source = { kind: "session", session: "claude s-1", upto: "l-1" } as const;
  const text = "Invoices are made nightly.";
  const { note } = await host.as<Noted>(rin, "memory.note", { text, source });
  const later = await host.as<Noted>(rin, "memory.note", { text: "Receipts are archived weekly." });
  const billing = { page: "billing", item: "schedule", note, position: 2, context: "For the billing team" };
  const handbook = { page: "handbook", item: "jobs", note, position: 0, context: "Part of on-call training" };

  await host.as(rin, "memory.page.write", { page: billing.page, title: "Billing" });
  await host.as(rin, "memory.page.write", { page: handbook.page, title: "Handbook" });
  expect(await host.as(rin, "memory.page.item.put", { ...billing, revision: 1 })).toEqual({ page: billing.page, revision: 2 });
  expect(await host.as(rin, "memory.page.item.put", { ...handbook, revision: 1 })).toEqual({ page: handbook.page, revision: 2 });
  await host.as(rin, "memory.page.item.put", { page: billing.page, item: "archive", note: later.note, position: 10, revision: 2 });
  const firstBilling = await host.as<PageView>(rin, "memory.page.get", { page: billing.page });
  const firstHandbook = await host.as<PageView>(rin, "memory.page.get", { page: handbook.page });
  expect(firstBilling.items).toEqual([
    { item: billing.item, note, position: 2, context: billing.context, text, source },
    { item: "archive", note: later.note, position: 10, text: "Receipts are archived weekly.", source: { kind: "inferred" } },
  ]);
  expect(firstHandbook.items).toEqual([{ item: handbook.item, note, position: 0, context: handbook.context, text, source }]);

  const records = await host.records();
  expect(dataOf(records, PageWritten.name)).toEqual([
    { memory: "rin", page: billing.page, title: "Billing", basedOn: 0, revision: 1, by: rin },
    { memory: "rin", page: handbook.page, title: "Handbook", basedOn: 0, revision: 1, by: rin },
  ]);
  expect(dataOf(records, PageItemChanged.name)).toEqual([
    { kind: "put", memory: "rin", ...billing, basedOn: 1, revision: 2, by: rin },
    { kind: "put", memory: "rin", ...handbook, basedOn: 1, revision: 2, by: rin },
    { kind: "put", memory: "rin", page: billing.page, item: "archive", note: later.note, position: 10, basedOn: 2, revision: 3, by: rin },
  ]);

  const context = "After the archive step";
  expect(await host.as(rin, "memory.page.item.put", { ...billing, position: 12, context, revision: 3 })).toEqual({ page: billing.page, revision: 4 });
  const moved = await host.as<PageView>(rin, "memory.page.get", { page: billing.page });
  expect(moved.items).toEqual([firstBilling.items[1]!, { ...firstBilling.items[0]!, position: 12, context }]);
  expect(await host.as<PageView>(rin, "memory.page.get", { page: handbook.page })).toEqual(firstHandbook);

  const corrected = "Invoices are made hourly.";
  await host.as(rin, "memory.correct", { note, text: corrected });
  const correctedBilling = await host.as<PageView>(rin, "memory.page.get", { page: billing.page });
  const correctedHandbook = await host.as<PageView>(rin, "memory.page.get", { page: handbook.page });
  expect(correctedBilling).toMatchObject({ revision: 4, items: [moved.items[0]!, { item: billing.item, text: corrected, context }] });
  expect(correctedHandbook).toMatchObject({ revision: 2, items: [{ item: handbook.item, text: corrected, context: handbook.context }] });

  expect(await host.as(rin, "memory.page.item.remove", { page: billing.page, item: billing.item, revision: 4 })).toEqual({ page: billing.page, revision: 5 });
  expect((await host.as<PageView>(rin, "memory.page.get", { page: billing.page })).items).toEqual([firstBilling.items[1]!]);
  expect(await host.as<NoteView>(rin, "memory.get", { note })).toMatchObject({ status: "live", text: corrected, revision: 2 });
  const reopened = await memoryHost({}, { home: await host.leave() });
  expect(await reopened.as<PageView>(rin, "memory.page.get", { page: billing.page, at: firstBilling.seq })).toEqual(firstBilling);
  expect(await reopened.as<PageView>(rin, "memory.page.get", { page: billing.page, at: moved.seq })).toEqual(moved);
  const current = await reopened.as<PageView>(rin, "memory.page.get", { page: handbook.page });
  expect(current.items).toEqual([{ item: handbook.item, note, position: 0, context: handbook.context, text: corrected, source: { kind: "inferred" } }]);
  expect(current.revision).toBe(2);
});

test("equal positions sort by item ID before and after restart", async () => {
  const host = await memoryHost();
  const page = "billing";
  const { note } = await host.as<Noted>(rin, "memory.note", { text: "Invoices are made nightly." });
  await host.as(rin, "memory.page.write", { page, title: "Billing" });
  for (const [item, position] of [["a", 2], ["first", 1], ["Z", 2], ["later", 10]] as const) {
    await host.as(rin, "memory.page.item.put", { page, item, note, position });
  }
  const order = ["first", "Z", "a", "later"];
  expect((await host.as<PageView>(rin, "memory.page.get", { page })).items.map(({ item }) => item)).toEqual(order);
  const restored = await memoryHost({}, { home: await host.leave() });
  expect((await restored.as<PageView>(rin, "memory.page.get", { page })).items.map(({ item }) => item)).toEqual(order);
});

test("a placement can only refer to a live note in its page's memory", async () => {
  const host = await memoryHost();
  const page = "billing";
  const foreign = await host.as<Noted>(bob, "memory.note", { text: "Only Bob knows this." });
  const own = await host.as<Noted>(rin, "memory.note", { text: "An old idea." });
  await host.as(rin, "memory.page.write", { page, title: "Billing" });
  await host.as(rin, "memory.retract", { note: own.note });
  const placement = { page, item: "schedule", note: foreign.note, position: 0, revision: 1 };
  await expect(host.as(rin, "memory.page.item.put", placement)).rejects.toThrow(/no note/);
  await expect(host.as(owner, "memory.page.item.put", { ...placement, memory: "rin" })).rejects.toThrow(/no note/);
  await expect(host.as(rin, "memory.page.item.put", { ...placement, note: own.note })).rejects.toThrow(/no longer holds/);
  await expect(host.as(bob, "memory.page.item.put", { ...placement, memory: "rin" })).rejects.toThrow(/only its own memory/);
  await expect(host.as(bob, "memory.page.item.remove", { memory: "rin", page, item: placement.item })).rejects.toThrow(/only its own memory/);
  await expect(host.as(bob, "memory.page.get", { memory: "rin", page })).rejects.toThrow(/only its own memory/);
  expect(await host.as<PageView>(rin, "memory.page.get", { page })).toMatchObject({ revision: 1, items: [] });
  expect(dataOf(await host.records(), PageItemChanged.name)).toEqual([]);
});

test("an item resolves a merged note to the survivor until that note is erased", async () => {
  const host = await memoryHost();
  const page = "billing";
  const item = "schedule";
  const text = "Invoices are made nightly.";
  const source = { kind: "session", session: "claude s-1", upto: "l-1" } as const;
  const survivor = await host.as<Noted>(rin, "memory.note", { text, source });
  const duplicate = await host.as<Noted>(rin, "memory.note", { text: "Invoices are made hourly." });
  await host.as(rin, "memory.page.write", { page, title: "Billing" });
  await host.as(rin, "memory.page.item.put", { page, item, note: duplicate.note, position: 0, context: "Dunning schedule" });
  const before = await host.as<PageView>(rin, "memory.page.get", { page });
  await host.as(rin, "memory.correct", { note: duplicate.note, text });
  await host.as(rin, "memory.consolidate", {});
  const rows = await until(host, Consolidated.name);
  const at = Number(rows.find((row) => row.type === Consolidated.name)!.seq);

  expect((await host.as<PageView>(rin, "memory.page.get", { page })).items).toEqual([
    { item, note: survivor.note, position: 0, context: "Dunning schedule", text, source },
  ]);
  expect(await host.as<PageView>(rin, "memory.page.get", { page, at: before.seq })).toEqual(before);
  await host.as(rin, "memory.erase", { note: survivor.note });
  expect((await host.as<PageView>(rin, "memory.page.get", { page })).items).toEqual([]);
  expect((await host.as<PageView>(rin, "memory.page.get", { page, at })).items).toEqual([]);
  expect((await host.as<{ hits: unknown[] }>(rin, "memory.search", { query: "nightly dunning", at })).hits).toEqual([]);
  expect(await host.as(rin, "memory.page.item.remove", { page, item, revision: 2 })).toEqual({ page, revision: 3 });
});

test("page summaries include the latest revision in name order, including unscoped pages in a project", async () => {
  const host = await memoryHost();
  const page = "projects/billing";
  const project = "/work/billing";
  const { note } = await host.as<Noted>(rin, "memory.note", { text: "Invoices are made nightly.", project });
  await host.as(rin, "memory.page.write", { page, title: "Billing", project });
  await host.as(rin, "memory.page.write", { page, title: "Invoice schedule", project });
  await host.as(rin, "memory.page.item.put", { page, item: "schedule", note, position: 0 });
  await host.as(rin, "memory.page.write", { page: "about", title: "About" });
  await host.as(rin, "memory.page.write", { page: "projects/payroll", title: "Payroll", project: "/work/payroll" });
  await host.as(bob, "memory.page.write", { page: "bobs", title: "Bob's page" });

  type Listed = { memory: string; pages: PageSummary[] };
  const own = await host.as<Listed>(rin, "memory.page.list", {});
  expect(own.memory).toBe("rin");
  expect(own.pages.map((one) => [one.page, one.title, one.revision])).toEqual([
    ["about", "About", 1],
    [page, "Invoice schedule", 3],
    ["projects/payroll", "Payroll", 1],
  ]);
  expect(own.pages.some((one) => "items" in one || "text" in one)).toBe(false);
  expect((await host.as<Listed>(rin, "memory.page.list", { project })).pages.map((one) => one.page)).toEqual(["about", page]);
  expect((await host.as<Listed>(owner, "memory.page.list", { memory: "bob" })).pages.map((one) => one.page)).toEqual(["bobs"]);
  await expect(host.as(bob, "memory.page.list", { memory: "rin" })).rejects.toThrow(/only its own memory/);
  await expect(host.as(owner, "memory.page.list", {})).rejects.toThrow(/name the memory/);
});


test("a legacy inline page stays in the journal and can be recreated as an item page", async () => {
  const legacy = record("memory.page.written", z.unknown());
  const first = await memoryHost({}, { without: true, after: [plugin("memory", (api) => api.declare(legacy))] });
  const page = "billing";
  const old = { memory: "rin", page, title: "Billing", text: "Earlier inline schedule", basedOn: 0, revision: 1, by: rin };
  await first.host.emit(legacy, old);
  const restored = await memoryHost({}, { home: await first.leave() });

  expect(dataOf(await restored.records(), legacy.name)).toEqual([old]);
  await expect(restored.as(rin, "memory.page.get", { page })).rejects.toThrow(/no page/);
  expect(await restored.as(rin, "memory.search", { query: "inline schedule" })).toEqual({ memory: "rin", hits: [] });
  expect(await restored.as(rin, "memory.page.write", { page, title: "Billing", revision: 0 })).toEqual({ page, revision: 1 });
  const { note } = await restored.as<Noted>(rin, "memory.note", { text: "Invoices are made nightly." });
  expect(await restored.as(rin, "memory.page.item.put", { page, item: "schedule", note, position: 0, revision: 1 })).toEqual({ page, revision: 2 });
});
