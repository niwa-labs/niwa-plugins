// Notes: an agent writes to its own memory and reaches no other; the owner reaches every memory, and only
// his word is his. A note can be confirmed, corrected, taken back and erased, and read as it stood earlier.

import { afterEach, expect, test } from "bun:test";

import { connectAsOwner } from "@niwa-labs/testing";

import { bob, closeAll, dataOf, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Noted = { memory: string; note: string };
type View = { note: string; text: string; detail?: string; status: string; confirmed: boolean; revision: number; seq: number; written: number; source: { kind: string }; by: unknown };

test("an agent writes a note to its own memory, and the owner reads it by naming the memory", async () => {
  const host = await memoryHost();
  const noted = await host.as<Noted>(rin, "memory.note", { text: "The release goes out on Fridays.", detail: "Said in the planning session." });
  expect(noted.memory).toBe("rin");
  expect(noted.note).toMatch(/^note-[0-9a-f]{12}$/);
  const written = dataOf(await host.records(), "memory.note.written");
  expect(written).toEqual([
    { memory: "rin", note: noted.note, text: "The release goes out on Fridays.", detail: "Said in the planning session.", about: "work", source: { kind: "inferred" }, by: rin },
  ]);

  const seen = await host.as<View>(owner, "memory.get", { memory: "rin", note: noted.note });
  expect(seen).toMatchObject({ text: "The release goes out on Fridays.", status: "live", confirmed: false, revision: 1 });
  expect((await host.as<{ notes: View[] }>(rin, "memory.list", {})).notes.map((one) => one.note)).toEqual([noted.note]);
});

test("an agent reaches only its own memory, and the owner and the host must name the one they mean", async () => {
  const host = await memoryHost();
  const noted = await host.as<Noted>(rin, "memory.note", { text: "Bob's tests are slow." });
  await expect(host.as(bob, "memory.get", { memory: "rin", note: noted.note })).rejects.toThrow(/only its own memory/);
  await expect(host.as(bob, "memory.note", { memory: "rin", text: "Something else." })).rejects.toThrow(/only its own memory/);
  await expect(host.as(owner, "memory.note", { text: "No memory named." })).rejects.toThrow(/name the memory/);
  await expect(host.as(undefined, "memory.list", {})).rejects.toThrow(/name the memory/);
  expect((await host.as<{ notes: View[] }>(undefined, "memory.list", { memory: "rin" })).notes).toHaveLength(1);
  expect((await host.as<{ notes: View[] }>(bob, "memory.list", {})).notes).toEqual([]);
});

test("only the owner's own word has the owner as its source, and it is confirmed as it is written", async () => {
  const host = await memoryHost();
  await expect(host.as(rin, "memory.note", { text: "He prefers tea.", about: "owner", source: { kind: "owner" } })).rejects.toThrow(/only the owner/);
  await expect(host.as(undefined, "memory.note", { memory: "rin", text: "He prefers tea.", about: "owner", source: { kind: "owner" } })).rejects.toThrow(/only the owner/);
  const noted = await host.as<Noted>(owner, "memory.note", { memory: "rin", text: "I prefer tea.", about: "owner", source: { kind: "owner" } });
  expect(await host.as<View>(rin, "memory.get", { note: noted.note })).toMatchObject({ confirmed: true, by: owner, source: { kind: "owner" } });
});

test("the owner confirms a note; a correction by the agent leaves it unconfirmed, one by the owner is his word", async () => {
  const host = await memoryHost();
  const { note } = await host.as<Noted>(rin, "memory.note", { text: "He wants short answers.", about: "owner", source: { kind: "session", session: "claude s-1", upto: "l-9" } });
  await expect(host.as(rin, "memory.confirm", { memory: "rin", note })).rejects.toThrow(/only the owner/);
  expect(await host.as(owner, "memory.confirm", { memory: "rin", note })).toEqual({ note, confirmed: true });
  expect(await host.as<View>(rin, "memory.get", { note })).toMatchObject({ confirmed: true });

  expect(await host.as(rin, "memory.correct", { note, text: "He wants short answers with the reason." })).toEqual({ note, revision: 2 });
  expect(await host.as<View>(rin, "memory.get", { note })).toMatchObject({ confirmed: false, revision: 2, text: "He wants short answers with the reason." });
  await host.as(owner, "memory.correct", { memory: "rin", note, text: "I want short answers." });
  expect(await host.as<View>(rin, "memory.get", { note })).toMatchObject({ confirmed: true, revision: 3, text: "I want short answers." });
  await expect(host.as(bob, "memory.correct", { memory: "rin", note, text: "x" })).rejects.toThrow(/only its own memory/);
});

test("a memory is read as it stood at a position of the journal", async () => {
  const host = await memoryHost();
  const { note } = await host.as<Noted>(rin, "memory.note", { text: "CI runs on every push." });
  const before = await host.as<View>(rin, "memory.get", { note });
  await host.as(rin, "memory.correct", { note, text: "CI runs on every push to main." });
  expect(await host.as<View>(rin, "memory.get", { note, at: before.seq })).toMatchObject({ text: "CI runs on every push.", revision: 1 });
  expect(await host.as<View>(rin, "memory.get", { note })).toMatchObject({ text: "CI runs on every push to main.", revision: 2 });
  await expect(host.as(rin, "memory.get", { note, at: before.written - 1 })).rejects.toThrow(/no note/);
});

test("a retracted note leaves the list; an erased one keeps nothing of its text", async () => {
  const host = await memoryHost();
  const kept = await host.as<Noted>(rin, "memory.note", { text: "Deploys need a review." });
  const taken = await host.as<Noted>(rin, "memory.note", { text: "Deploys need two reviews.", detail: "A guess." });
  const gone = await host.as<Noted>(owner, "memory.note", { memory: "rin", text: "My phone number is 555.", about: "owner", source: { kind: "owner" } });
  await host.as(rin, "memory.retract", { note: taken.note, reason: "one review is enough" });
  await host.as(owner, "memory.erase", { memory: "rin", note: gone.note });
  expect((await host.as<{ notes: View[] }>(rin, "memory.list", {})).notes.map((one) => one.note)).toEqual([kept.note]);
  expect(await host.as<View>(rin, "memory.get", { note: taken.note })).toMatchObject({ status: "retracted", text: "Deploys need two reviews." });
  const erased = await host.as<View>(rin, "memory.get", { note: gone.note });
  expect(erased).toMatchObject({ status: "erased", text: "" });
  expect(erased.detail).toBeUndefined();
  // An erased note stays erased: it cannot be corrected back into the memory.
  await expect(host.as(owner, "memory.correct", { memory: "rin", note: gone.note, text: "Back." })).rejects.toThrow(/erased/);
});

test("a client with the owner's token speaks as the owner", async () => {
  const host = await memoryHost();
  const client = await connectAsOwner(host.home);
  try {
    const noted = (await client.call("memory.note" as never, { memory: "rin", text: "I am on leave in May.", about: "owner", source: { kind: "owner" } } as never)) as Noted;
    expect(await host.as<View>(rin, "memory.get", { note: noted.note })).toMatchObject({ confirmed: true, by: owner });
  } finally {
    await client.close();
  }
});

test("an erased note leaves no trace in what the memory shows, and the same words make a new note", async () => {
  const host = await memoryHost();
  const { note } = await host.as<Noted>(owner, "memory.note", { memory: "rin", text: "My door code is 4711.", about: "owner", source: { kind: "owner" } });
  await host.as(rin, "memory.lift", { note });
  await host.as(owner, "memory.erase", { memory: "rin", note });
  expect((await host.as<{ notes: string[] }>(rin, "memory.top", {})).notes).toEqual([]);
  expect((await host.as<{ hits: unknown[] }>(rin, "memory.search", { query: "door code 4711" })).hits).toEqual([]);
  expect((await host.as<{ items: unknown[] }>(rin, "memory.context", { memory: "rin", query: "door code", purpose: "to let a courier in" })).items).toEqual([]);
  const again = await host.as<Noted & { corroborated: boolean }>(owner, "memory.note", { memory: "rin", text: "My door code is 4711.", about: "owner", source: { kind: "owner" } });
  expect(again.corroborated).toBe(false);
  expect(again.note).not.toBe(note);
});

test("the notes a memory listed at a position are those that held then, and an erased one is in none", async () => {
  const host = await memoryHost();
  const first = await host.as<Noted>(rin, "memory.note", { text: "Releases go out on Fridays." });
  const at = Number((await host.records()).at(-1)!.seq);
  const second = await host.as<Noted>(rin, "memory.note", { text: "Releases are announced in the channel." });
  const listed = async (input: Record<string, unknown>) => (await host.as<{ notes: View[] }>(rin, "memory.list", input)).notes.map((one) => one.note);
  expect(await listed({})).toEqual([second.note, first.note]);
  expect(await listed({ at })).toEqual([first.note]);
  expect(await listed({ at: 0 })).toEqual([]);
  await host.as(owner, "memory.erase", { memory: "rin", note: first.note });
  expect(await listed({ at })).toEqual([]);
});
