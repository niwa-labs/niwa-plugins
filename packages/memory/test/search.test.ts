// Pages and search: a page is written whole under a name, refused when it changed since it was read; a
// search ranks the notes that hold and the pages by words, on the host, and never finds what was erased.

import { afterEach, expect, test } from "bun:test";

import { rank, words } from "../src/search.ts";
import { bob, closeAll, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Hit = { kind: string; id: string; title?: string; text: string; project?: string; score: number; seq: number };
type Page = { page: string; title: string; text: string; revision: number; seq: number };

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

test("a page is written whole, and a write over a change made since it was read is refused", async () => {
  const host = await memoryHost();
  expect(await host.as(rin, "memory.page.write", { page: "projects/billing", title: "Billing", text: "Invoices are made nightly.", project: "/work/billing", revision: 0 })).toEqual({
    page: "projects/billing",
    revision: 1,
  });
  await expect(host.as(rin, "memory.page.write", { page: "projects/billing", title: "Billing", text: "Again.", revision: 0 })).rejects.toThrow(/revision 1, not 0/);
  const first = await host.as<Page>(rin, "memory.page.get", { page: "projects/billing" });
  await host.as(rin, "memory.page.write", { page: "projects/billing", title: "Billing", text: "Invoices are made hourly.", revision: 1 });
  expect(await host.as<Page>(rin, "memory.page.get", { page: "projects/billing" })).toMatchObject({ revision: 2, text: "Invoices are made hourly." });
  expect(await host.as<Page>(rin, "memory.page.get", { page: "projects/billing", at: first.seq })).toMatchObject({ revision: 1, text: "Invoices are made nightly." });
  await expect(host.as(bob, "memory.page.get", { memory: "rin", page: "projects/billing" })).rejects.toThrow(/only its own memory/);
  await expect(host.as(rin, "memory.page.get", { page: "nothing" })).rejects.toThrow(/no page/);
  await expect(host.as(rin, "memory.page.write", { page: "big", title: "Big", text: "x".repeat(16 * 1024 + 1) })).rejects.toThrow();
});

type Listed = { memory: string; pages: Array<{ page: string; title: string; revision: number; project?: string; text?: string }> };

test("the pages of a memory are listed by name at their latest revision, without their text", async () => {
  const host = await memoryHost();
  await host.as(rin, "memory.page.write", { page: "projects/billing", title: "Billing", text: "Invoices are made nightly.", project: "/work/billing" });
  await host.as(rin, "memory.page.write", { page: "projects/billing", title: "Billing, again", text: "Invoices are made hourly.", project: "/work/billing" });
  await host.as(rin, "memory.page.write", { page: "about", title: "About", text: "What this memory is for." });
  await host.as(rin, "memory.page.write", { page: "projects/payroll", title: "Payroll", text: "Runs monthly.", project: "/work/payroll" });
  await host.as(bob, "memory.page.write", { page: "bobs", title: "Bob's page", text: "Not rin's." });

  const own = await host.as<Listed>(rin, "memory.page.list", {});
  expect(own.memory).toBe("rin");
  expect(own.pages.map((one) => [one.page, one.title, one.revision])).toEqual([
    ["about", "About", 1],
    ["projects/billing", "Billing, again", 2],
    ["projects/payroll", "Payroll", 1],
  ]);
  expect(own.pages.some((one) => "text" in one)).toBe(false);

  // A project is asked for with the pages of no project: the general ones.
  expect((await host.as<Listed>(rin, "memory.page.list", { project: "/work/billing" })).pages.map((one) => one.page)).toEqual(["about", "projects/billing"]);
  expect((await host.as<Listed>(owner, "memory.page.list", { memory: "bob" })).pages.map((one) => one.page)).toEqual(["bobs"]);
  await expect(host.as(bob, "memory.page.list", { memory: "rin" })).rejects.toThrow(/only its own memory/);
  await expect(host.as(owner, "memory.page.list", {})).rejects.toThrow(/name the memory/);
});

test("a search finds the notes that hold and the pages, best first, and nothing that was taken back or erased", async () => {
  const host = await memoryHost();
  const release = await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Fridays after the release check." });
  const taken = await host.as<{ note: string }>(rin, "memory.note", { text: "Releases go out on Mondays." });
  const erased = await host.as<{ note: string }>(owner, "memory.note", { memory: "rin", text: "My release password is hunter2.", about: "owner", source: { kind: "owner" } });
  await host.as(rin, "memory.note", { text: "Billing invoices are made nightly.", project: "/work/billing" });
  await host.as(rin, "memory.page.write", { page: "release", title: "How a release is made", text: "Tag, build, then publish." });
  await host.as(rin, "memory.retract", { note: taken.note });
  await host.as(rin, "memory.erase", { note: erased.note });

  const { hits } = await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "release" });
  expect(hits.map((hit) => hit.id)).toEqual([release.note, "release"]);
  expect(hits[1]).toMatchObject({ kind: "page", title: "How a release is made", text: "Tag, build, then publish." });
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "hunter2 password" })).hits).toEqual([]);
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "invoices" })).hits).toHaveLength(1);
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "invoices", project: "/work/other" })).hits).toEqual([]);
  // As it stood before the retraction, the Monday note still held.
  const before = (await host.as<{ written: number }>(rin, "memory.get", { note: taken.note })).written;
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "mondays", at: before })).hits.map((hit) => hit.id)).toEqual([taken.note]);
  await expect(host.as(bob, "memory.search", { memory: "rin", query: "release" })).rejects.toThrow(/only its own memory/);
});
