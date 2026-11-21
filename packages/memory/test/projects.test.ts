// Projects are directories, and one directory is one project however it is spelled: a path with `..`, `.`,
// doubled or trailing slashes is read as the directory it names, and a relative path names none.

import { afterEach, expect, test } from "bun:test";

import type { Address } from "@niwa-labs/core";

import { closeAll, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Listed = { notes: Array<{ note: string; project?: string }> };
type Context = { items: Array<{ note: string; project?: string }>; withheld: Array<{ note: string; reason: string }> };

const lead: Address = { kind: "agent", id: "lead" };
const AGENTS = [
  { name: "rin", harness: "h", prompt: "p" },
  { name: "bob", harness: "h", prompt: "p" },
  { name: "lead", harness: "h", prompt: "p", project: { cwd: "/work/billing/" } },
];

test("a project spelled with `..` is the directory it names, not the one it starts in", async () => {
  const host = await memoryHost({}, { agents: AGENTS });
  const shop = await host.as<{ note: string }>(rin, "memory.note", { text: "Orders are checked nightly.", project: "/work/billing/../shop" });
  const api = await host.as<{ note: string }>(rin, "memory.note", { text: "Invoices are made nightly.", project: "/work//billing/./api/" });
  const told = await host.as<Context>(undefined, "memory.context", { memory: "rin", query: "nightly", purpose: "to plan", for: lead });
  expect(told.items.map((item) => [item.note, item.project])).toEqual([[api.note, "/work/billing/api"]]);
  const listed = await host.as<Listed>(rin, "memory.list", { project: "/work/shop/" });
  expect(listed.notes.map((one) => [one.note, one.project])).toEqual([[shop.note, "/work/shop"]]);
  expect((await host.as<Listed>(rin, "memory.list", { project: "/work/billing/api/../api" })).notes.map((one) => one.note)).toEqual([api.note]);
});

test("a relative directory is no project", async () => {
  const host = await memoryHost();
  await expect(host.as(rin, "memory.note", { text: "Orders are checked nightly.", project: "work/shop" })).rejects.toThrow(/absolute/);
  await expect(host.as(owner, "memory.list", { memory: "rin", project: "../shop" })).rejects.toThrow(/absolute/);
});
