// A note written again in nearly the same words is one more source of the note the memory holds, not a
// second copy; the same source counts once, and so does the same writer's own conclusion.

import { afterEach, expect, test } from "bun:test";

import { similar } from "../src/similar.ts";
import { closeAll, dataOf, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Noted = { memory: string; note: string; corroborated: boolean };

test("texts are alike when nearly all their words are the same", () => {
  expect(similar("Releases go out on Fridays.", "releases go out on fridays")).toBe(true);
  expect(similar("Releases go out on Fridays after the check.", "Releases go out on Fridays after a check.")).toBe(true);
  expect(similar("Releases go out on Fridays.", "Releases go out on Mondays.")).toBe(false);
});

test("a note written again from another source gains a source; from the same one it is the same note", async () => {
  const host = await memoryHost();
  const first = await host.as<Noted>(rin, "memory.note", { text: "Releases go out on Fridays.", source: { kind: "session", session: "claude s-1", upto: "l-2" } });
  expect(first.corroborated).toBe(false);
  const again = await host.as<Noted>(rin, "memory.note", { text: "releases go out on fridays", source: { kind: "session", session: "claude s-2", upto: "l-7" } });
  expect(again).toEqual({ memory: "rin", note: first.note, corroborated: true });
  const same = await host.as<Noted>(owner, "memory.note", { memory: "rin", text: "Releases go out on Fridays.", source: { kind: "session", session: "claude s-1", upto: "l-2" } });
  expect(same).toEqual({ memory: "rin", note: first.note, corroborated: true });
  // Her own conclusion, said twice, is still one source.
  await host.as(rin, "memory.note", { text: "Releases go out on Fridays." });
  await host.as(rin, "memory.note", { text: "Releases go out on Fridays!" });
  const records = await host.records();
  expect(dataOf(records, "memory.note.written")).toHaveLength(1);
  expect(dataOf(records, "memory.note.corroborated")).toHaveLength(2);
  expect(await host.as(rin, "memory.get", { note: first.note })).toMatchObject({ sources: 3 });
});

test("only a note that holds, about the same and for the same project, is corroborated", async () => {
  const host = await memoryHost();
  const billing = await host.as<Noted>(rin, "memory.note", { text: "Deploys need a review.", project: "/work/billing" });
  expect((await host.as<Noted>(rin, "memory.note", { text: "Deploys need a review.", project: "/work/site" })).note).not.toBe(billing.note);
  expect((await host.as<Noted>(rin, "memory.note", { text: "Deploys need a review.", about: "owner" })).note).not.toBe(billing.note);
  await host.as(rin, "memory.retract", { note: billing.note });
  const after = await host.as<Noted>(rin, "memory.note", { text: "Deploys need a review.", project: "/work/billing" });
  expect(after.corroborated).toBe(false);
  expect(after.note).not.toBe(billing.note);
});
