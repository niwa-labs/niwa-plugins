// Context requests: another agent is told only conclusions with their scope; a project's notes go to that
// project's agents; a note about the owner leaves only on his own answer. Every conclusion carries its
// source, and an answer can be read again as the memory stood when it was given.

import { afterEach, expect, test } from "bun:test";

import { CONFIRM_NO, CONFIRM_YES } from "@niwa-labs/core";
import type { Address } from "@niwa-labs/core";
import { connectAsOwner } from "@niwa-labs/testing";

import { bob, closeAll, dataOf, memoryHost, owner, rin, until } from "./fixtures/host.ts";
import type { MemoryHost } from "./fixtures/host.ts";

afterEach(closeAll);

type Item = { note: string; text: string; about: string; project?: string; detail?: string; confirmed: boolean; source: { owner: Address; note: string; seq: number } };
type Withheld = { note: string; reason: string; status?: string };
type Context = { memory: Address; for: Address; at: number; items: Item[]; withheld: Withheld[] };

const lead: Address = { kind: "agent", id: "lead" };
const AGENTS = [
  { name: "rin", harness: "h", prompt: "p" },
  { name: "bob", harness: "h", prompt: "p" },
  { name: "lead", harness: "h", prompt: "p", project: { cwd: "/work/billing" } },
];

async function served(): Promise<MemoryHost> {
  return memoryHost({}, { agents: AGENTS });
}

async function noted(host: MemoryHost, input: Record<string, unknown>, who: Address = rin): Promise<string> {
  return (await host.as<{ note: string }>(who, "memory.note", input)).note;
}

const ask = (host: MemoryHost, who: Address | undefined, input: Record<string, unknown>) => host.as<Context>(who, "memory.context", { memory: "rin", purpose: "to plan the week", ...input });

async function answer(host: MemoryHost, id: string, yes: boolean): Promise<void> {
  const client = await connectAsOwner(host.home);
  try {
    await client.call("request.answer" as never, { id, answer: { ids: [yes ? CONFIRM_YES : CONFIRM_NO] } } as never);
  } finally {
    await client.close();
  }
}

test("the memory's own agent and the owner are told everything; another agent only the conclusion and its scope", async () => {
  const host = await served();
  const note = await noted(host, { text: "Releases go out on Fridays.", detail: "Bob said so in the retro of week 40." });
  const mine = await ask(host, rin, { query: "releases" });
  expect(mine.for).toEqual(rin);
  expect(mine.items).toEqual([
    { note, text: "Releases go out on Fridays.", about: "work", detail: "Bob said so in the retro of week 40.", confirmed: false, source: { owner: rin, note, seq: mine.items[0]!.source.seq } },
  ]);
  expect((await ask(host, owner, { query: "releases" })).items[0]?.detail).toBe("Bob said so in the retro of week 40.");
  const theirs = await ask(host, bob, { query: "releases" });
  expect(theirs.items).toEqual([{ note, text: "Releases go out on Fridays.", about: "work", confirmed: false, source: { owner: rin, note, seq: mine.items[0]!.source.seq } }]);
  expect(theirs.withheld).toEqual([]);
});

test("a caller asks for itself; a handler or the host names the addressee", async () => {
  const host = await served();
  await noted(host, { text: "Releases go out on Fridays." });
  await expect(ask(host, bob, { query: "releases", for: lead })).rejects.toThrow(/asks for itself/);
  await expect(ask(host, undefined, { query: "releases" })).rejects.toThrow(/name the addressee/);
  expect((await ask(host, undefined, { query: "releases", for: lead })).for).toEqual(lead);
});

test("a project's notes go to that project's agents, and stay home from the others", async () => {
  const host = await served();
  const billing = await noted(host, { text: "Invoices are made nightly.", project: "/work/billing/api" });
  const general = await noted(host, { text: "Invoices are checked by a person." });
  const forLead = await ask(host, lead, { query: "invoices" });
  expect(forLead.items.map((item) => item.note).sort()).toEqual([billing, general].sort());
  const forBob = await ask(host, bob, { query: "invoices" });
  expect(forBob.items.map((item) => item.note)).toEqual([general]);
  expect(forBob.withheld).toEqual([{ note: billing, reason: "another-project" }]);
});

test("a note about the owner leaves only once he said yes, and is asked again when it changes", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner", source: { kind: "session", session: "claude s-1", upto: "l-3" } });
  const first = await ask(host, bob, { query: "leave May" });
  expect(first.items).toEqual([]);
  expect(first.withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);
  const created = (await until(host, "request.created")).filter((one) => one.type === "request.created");
  expect(created).toHaveLength(1);
  const request = created[0]!.data as { id: string; to: Address; from: Address; input: { title: string; detail: string } };
  expect(request.to).toEqual(owner);
  expect(request.from).toEqual(rin);
  expect(request.input.title).toBe("May agent bob be told what agent rin remembers about you?");
  expect(request.input.detail).toContain("He is on leave in May.");
  expect(request.input.detail).toContain("to plan the week");
  // Asked again before he answers, he is not asked twice.
  expect((await ask(host, bob, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);

  await answer(host, request.id, true);
  await until(host, "memory.share.answered");
  const released = await ask(host, bob, { query: "leave" });
  expect(released.items.map((item) => item.text)).toEqual(["He is on leave in May."]);
  // The yes was for bob, not for every agent.
  expect((await ask(host, lead, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);

  await host.as(rin, "memory.correct", { note, text: "He is on leave in June." });
  expect((await ask(host, bob, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);
  expect(dataOf(await host.records(), "request.created")).toHaveLength(3);
});

test("a no from the owner keeps the note home until he says otherwise", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner" });
  await ask(host, bob, { query: "leave" });
  const [created] = await until(host, "request.created").then((all) => all.filter((one) => one.type === "request.created"));
  await answer(host, (created!.data as { id: string }).id, false);
  await until(host, "memory.share.answered");
  expect((await ask(host, bob, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "refused" }]);
  await expect(host.as(rin, "memory.share", { memory: "rin", note, for: bob, allowed: true })).rejects.toThrow(/only the owner/);
  await host.as(owner, "memory.share", { memory: "rin", note, for: bob, allowed: true });
  expect((await ask(host, bob, { query: "leave" })).items.map((item) => item.note)).toEqual([note]);
});

test("an answer that is not the owner's own lets nothing leave", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner" });
  await ask(host, bob, { query: "leave" });
  const [created] = await until(host, "request.created").then((all) => all.filter((one) => one.type === "request.created"));
  // Something other than the owner answers yes for him: a resolver that recalled an old decision.
  await host.as(undefined, "request.resolve", { id: (created!.data as { id: string }).id, answer: { ids: [CONFIRM_YES] }, info: { how: "recalled" } });
  const [answered] = await until(host, "memory.share.answered").then((all) => dataOf(all, "memory.share.answered"));
  expect(answered).toMatchObject({ allowed: false, reason: "not-the-owner" });
  expect((await ask(host, bob, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "refused" }]);
});

test("an answer read again at its position tells the memory as it stood then", async () => {
  const host = await served();
  const note = await noted(host, { text: "Releases go out on Fridays." });
  const then = await ask(host, bob, { query: "releases" });
  await host.as(rin, "memory.correct", { note, text: "Releases go out on Thursdays." });
  await host.as(rin, "memory.note", { text: "Releases are announced in the channel." });
  expect((await ask(host, bob, { query: "releases" })).items.map((item) => item.text).sort()).toEqual(["Releases are announced in the channel.", "Releases go out on Thursdays."]);
  const again = await ask(host, bob, { query: "releases", at: then.at });
  expect(again.at).toBe(then.at);
  expect(again.items).toEqual(then.items);
  // Erased since, the note cannot be read back even at the old position.
  await host.as(owner, "memory.erase", { memory: "rin", note });
  expect((await ask(host, bob, { query: "fridays", at: then.at })).items).toEqual([]);
});
