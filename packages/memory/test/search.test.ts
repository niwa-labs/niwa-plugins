// Search ranks the notes that hold and the pages by words, on the host, and never finds what was erased.

import { afterEach, expect, test } from "bun:test";

import { rank, words } from "../src/search.ts";
import type { PageView } from "../src/records.ts";
import { bob, closeAll, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Hit = { kind: string; id: string; title?: string; text: string; project?: string; score: number; seq: number };

test("words are letters and digits of any script, and a query word finds the longer words it starts", () => {
  expect(words("Деплой в 9:30, v2 — CI/CD!")).toEqual(["деплой", "30", "v2", "ci", "cd"]);
  const texts = [
    { text: "The deployment runs at night.", value: "a" },
    { text: "Tea, not coffee.", value: "b" },
    { text: "Deploy after the deploy check, deploy again.", value: "c" },
  ];
  expect(rank("deploy", texts, 10).map((hit) => hit.value)).toEqual(["c", "a"]);
  expect(rank("de", texts, 10)).toEqual([]);
  expect(rank("tea coffee", texts, 1).map((hit) => hit.value)).toEqual(["b"]);
});

test("a search finds the notes that hold and the pages, best first, and nothing that was taken back or erased", async () => {
  const host = await memoryHost();
  const release = await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Fridays after the release check." });
  const taken = await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Mondays." });
  const erased = await host.as<{ note: string }>(owner, "memory.note", { memory: "rin", text: "My release password is hunter2.", about: "owner", source: { kind: "owner" } });
  await host.as(rin, "memory.note", { text: "Billing invoices are made nightly.", project: "/work/billing" });
  const instructions = await host.as<{ note: string }>(rin, "memory.note", { text: "Tag, build, then publish." });
  await host.as(rin, "memory.page.write", { page: "release", title: "How a release is made" });
  await host.as(rin, "memory.page.item.put", { page: "release", item: "instructions", note: instructions.note, position: 0 });
  await host.as(rin, "memory.page.item.put", { page: "release", item: "taken", note: taken.note, position: 1, context: "Weekly cadence" });
  await host.as(rin, "memory.page.item.put", { page: "release", item: "secret", note: erased.note, position: 2, context: "Legacy credentials" });
  const { seq: at } = await host.as<PageView>(rin, "memory.page.get", { page: "release" });
  const ids = async (query: string, position?: number) =>
    (await host.as<{ hits: Hit[] }>(rin, "memory.search", { query, at: position })).hits.map((hit) => hit.id).sort();

  expect(await ids("publish")).toEqual([instructions.note, "release"].sort());
  expect(await ids("cadence")).toEqual(["release"]);
  expect(await ids("credentials")).toEqual(["release"]);
  await host.as(rin, "memory.retract", { note: taken.note });
  await host.as(rin, "memory.erase", { note: erased.note });

  const { hits } = await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "release" });
  expect(hits.map((hit) => hit.id)).toEqual([release.note, "release"]);
  expect(hits[1]).toMatchObject({ kind: "page", title: "How a release is made", text: "Tag, build, then publish." });
  expect(await ids("mondays cadence")).toEqual([]);
  expect(await ids("hunter2 credentials")).toEqual([]);
  expect(await ids("hunter2 credentials", at)).toEqual([]);
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "invoices" })).hits).toHaveLength(1);
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "invoices", project: "/work/other" })).hits).toEqual([]);
  // As it stood before the retraction, the Monday note still held and the page included it.
  expect(await ids("mondays cadence", at)).toEqual([taken.note, "release"].sort());
  const historical = await host.as<PageView>(rin, "memory.page.get", { page: "release", at });
  expect(historical.items.map((item) => item.item)).toEqual(["instructions", "taken"]);
  expect((await host.as<PageView>(rin, "memory.page.get", { page: "release" })).items.map((item) => item.item)).toEqual(["instructions"]);
  const historicalHits = await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "release", at });
  const historicalExcerpt = historicalHits.hits.find((hit) => hit.id === "release")?.text;
  expect(historicalExcerpt).toContain("Releases go out on Mondays.");
  expect(historicalExcerpt).not.toMatch(/hunter2|credentials/);
  await expect(host.as(bob, "memory.search", { memory: "rin", query: "release" })).rejects.toThrow(/only its own memory/);
});


test("project search respects the page and the project of each of its notes", async () => {
  const host = await memoryHost();
  const billing = "/work/billing";
  const payroll = "/work/payroll";
  const { note: general } = await host.as<{ note: string }>(rin, "memory.note", { text: "General procedure." });
  const { note: scoped } = await host.as<{ note: string }>(rin, "memory.note", { text: "Salary review.", project: payroll });
  for (const [page, project] of [["overview", undefined], ["payroll", payroll]] as const) {
    await host.as(rin, "memory.page.write", { page, project, title: "Operations" });
    await host.as(rin, "memory.page.item.put", { page, item: "general", note: general, position: 0 });
    await host.as(rin, "memory.page.item.put", { page, item: "scoped", note: scoped, position: 1, context: "Compensation timetable" });
  }
  const search = async (query: string, project: string) => (await host.as<{ hits: Hit[] }>(rin, "memory.search", { query, project })).hits;
  expect(await search("salary compensation", billing)).toEqual([]);
  expect((await search("operations", billing)).map(({ id, text }) => ({ id, text }))).toEqual([{ id: "overview", text: "General procedure." }]);
  const allowed = await search("compensation", payroll);
  expect(allowed.map(({ id }) => id).sort()).toEqual(["overview", "payroll"]);
  expect(allowed.every(({ text }) => text.includes("Salary review.") && text.includes("Compensation timetable"))).toBe(true);
});
