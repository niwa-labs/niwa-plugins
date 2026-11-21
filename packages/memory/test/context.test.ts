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
  // A note of another project is not even said to exist.
  expect(forBob.withheld).toEqual([]);
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
  // The question names the note and says why; the text of a note about the owner is not in it.
  expect(request.input.detail).not.toContain("He is on leave in May.");
  expect(request.input.detail).toContain(note);
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

test("only what the reader may read is ranked, and the limit counts only that", async () => {
  const host = await served();
  await noted(host, { text: "Invoices, invoices and more invoices are made nightly.", project: "/work/shop" });
  const owners = await noted(host, { text: "He wants invoices invoices invoices checked by hand.", about: "owner" });
  const general = await noted(host, { text: "Invoices are checked by a person." });
  const told = await ask(host, lead, { query: "invoices", limit: 1 });
  expect(told.items.map((item) => item.note)).toEqual([general]);
  expect(told.withheld).toEqual([{ note: owners, reason: "about-the-owner", status: "asked" }]);
});

test("an answer rests on one position even while the addressee's definition is awaited", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await memoryHost({}, { agents: AGENTS, hold });
  await noted(host, { text: "Releases go out on Fridays." });
  const pending = ask(host, undefined, { query: "releases", for: bob });
  // While it waits, a note is written and a read moves the fold on.
  await host.as(undefined, "memory.note", { memory: "rin", text: "Releases are announced in the channel." });
  await host.as(owner, "memory.list", { memory: "rin" });
  release();
  const told = await pending;
  expect(told.items.map((item) => item.text).sort()).toEqual(["Releases are announced in the channel.", "Releases go out on Fridays."]);
  expect(told.items.every((item) => item.source.seq <= told.at)).toBe(true);
  expect((await ask(host, undefined, { query: "releases", for: bob, at: told.at })).items).toEqual(told.items);
});

test("'asked' is said only when the owner was asked: a read at a position asks nobody and says so", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner" });
  const before = await ask(host, undefined, { query: "leave", for: bob, at: Number((await host.records()).at(-1)!.seq) });
  expect(before.withheld).toEqual([{ note, reason: "about-the-owner", status: "not-asked" }]);
  expect(dataOf(await host.records(), "memory.share.wanted")).toEqual([]);

  expect((await ask(host, bob, { query: "leave" })).withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);
  expect(dataOf(await host.records(), "memory.share.wanted")).toHaveLength(1);
  // The question exists now; read at a position before it was put, the answer still says nobody had been asked.
  expect((await ask(host, undefined, { query: "leave", for: bob, at: before.at })).withheld).toEqual([{ note, reason: "about-the-owner", status: "not-asked" }]);
  expect((await ask(host, undefined, { query: "leave", for: bob, at: Number((await host.records()).at(-1)!.seq) })).withheld).toEqual([
    { note, reason: "about-the-owner", status: "asked" },
  ]);
  expect(dataOf(await host.records(), "memory.share.wanted")).toHaveLength(1);
});

test("the owner's yes is for the purpose he was told, and a request for another purpose asks him again", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner" });
  await ask(host, bob, { query: "leave", purpose: "to plan the week" });
  const [first] = (await until(host, "request.created")).filter((one) => one.type === "request.created");
  await answer(host, (first!.data as { id: string }).id, true);
  await until(host, "memory.share.answered");
  expect((await ask(host, bob, { query: "leave", purpose: "to plan the week" })).items.map((item) => item.note)).toEqual([note]);

  const other = await ask(host, bob, { query: "leave", purpose: "to write him a letter" });
  expect(other.items).toEqual([]);
  expect(other.withheld).toEqual([{ note, reason: "about-the-owner", status: "asked" }]);
  const created = (await until(host, "request.created", 2)).filter((one) => one.type === "request.created");
  expect((created[1]!.data as { input: { detail: string } }).input.detail).toContain("to write him a letter");
  expect(dataOf(await host.records(), "memory.share.answered")).toMatchObject([{ purpose: "to plan the week", allowed: true }]);
});

test("the owner may allow a note for every purpose, or for one, in his own words", async () => {
  const host = await served();
  const note = await noted(host, { text: "He is on leave in May.", about: "owner" });
  await host.as(owner, "memory.share", { memory: "rin", note, for: bob, allowed: true, purpose: "to plan the week" });
  expect((await ask(host, bob, { query: "leave", purpose: "to plan the week" })).items).toHaveLength(1);
  expect((await ask(host, bob, { query: "leave", purpose: "to write him a letter" })).items).toEqual([]);
  await host.as(owner, "memory.share", { memory: "rin", note, for: bob, allowed: true });
  expect((await ask(host, bob, { query: "leave", purpose: "to write him a letter" })).items).toHaveLength(1);
  expect((await ask(host, lead, { query: "leave", purpose: "to plan the week" })).items).toEqual([]);
});

test("a question about a note that was corrected, retracted or erased is closed", async () => {
  const host = await served();
  const text = (n: number) => `He is on leave in month ${String(n)}.`;
  const notes = [await noted(host, { text: text(1), about: "owner" }), await noted(host, { text: text(2), about: "owner" }), await noted(host, { text: text(3), about: "owner" })];
  await ask(host, bob, { query: "leave month" });
  const created = (await until(host, "request.created", 3)).filter((one) => one.type === "request.created");
  expect(created).toHaveLength(3);
  await host.as(rin, "memory.correct", { note: notes[0], text: "He is on leave in the autumn." });
  await host.as(rin, "memory.retract", { note: notes[1] });
  await host.as(owner, "memory.erase", { memory: "rin", note: notes[2] });
  const ended = (await until(host, "request.cancelled", 3)).filter((one) => one.type === "request.cancelled");
  expect(ended.map((one) => (one.data as { id: string }).id).sort()).toEqual(created.map((one) => (one.data as { id: string }).id).sort());
  const { requests } = await host.as<{ requests: unknown[] }>(owner, "request.open", {});
  expect(requests).toEqual([]);
});
