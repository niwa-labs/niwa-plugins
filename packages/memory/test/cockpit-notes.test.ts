// The memory page: the top layer by part, how a note reads, which memory is shown, and which questions are the memory's.

import { expect, test } from "bun:test";

import type { Note, Open } from "../src/cockpit/actions.ts";
import { memoryChoice, newestFirst, shareQuestions, shownText, sourceText, standingText, topParts } from "../src/cockpit/notes.ts";
import { shareDetail, shareReferenceOf } from "../src/share-question.ts";

let counter = 0;
function note(text: string, extra: Partial<Note> = {}): Note {
  counter += 1;
  return { note: `note-${String(counter)}`, text, about: "work", source: { kind: "inferred" }, confirmed: false, sources: 1, top: false, pinned: false, revision: 1, written: counter, ...extra };
}

test("the top layer is by part: the owner first, then each project, then what holds in general, the newest first", () => {
  const parts = topParts([
    note("tea", { about: "owner", top: true }),
    note("old general", { top: true }),
    note("billing", { project: "/work/billing", top: true }),
    note("not lifted", { about: "owner" }),
    note("new general", { top: true }),
    note("payroll", { project: "/work/payroll", top: true }),
    note("coffee", { about: "owner", project: "/work/billing", top: true }),
  ]);
  expect(parts.map((part) => [part.heading, part.notes.map((one) => one.text)])).toEqual([
    ["About the owner", ["coffee", "tea"]],
    ["For /work/billing", ["billing"]],
    ["For /work/payroll", ["payroll"]],
    ["In general", ["new general", "old general"]],
  ]);
});

test("a part with nothing lifted is not shown", () => {
  expect(topParts([note("a"), note("b", { about: "owner" })])).toEqual([]);
  expect(topParts([note("a", { top: true })]).map((part) => part.heading)).toEqual(["In general"]);
});

test("notes are listed newest first", () => {
  expect(newestFirst([note("a"), note("b"), note("c")]).map((one) => one.text)).toEqual(["c", "b", "a"]);
});

test("a source and a note's standing read in a few words", () => {
  expect(sourceText({ kind: "owner" })).toBe("the owner's word");
  expect(sourceText({ kind: "inferred" })).toBe("the writer's conclusion");
  expect(sourceText({ kind: "session", session: "claude s-1" })).toBe("session claude s-1");
  expect(sourceText({ kind: "record", record: "r-9" })).toBe("record r-9");
  expect(standingText({ confirmed: true, sources: 1 })).toBe("confirmed by the owner");
  expect(standingText({ confirmed: false, sources: 1 })).toBe("one source");
  expect(standingText({ confirmed: false, sources: 3 })).toBe("3 sources");
});

test("the memory asked for is shown when an agent has it, else the first", () => {
  expect(memoryChoice("bob", ["rin", "bob"])).toBe("bob");
  expect(memoryChoice("nobody", ["rin", "bob"])).toBe("rin");
  expect(memoryChoice(undefined, ["rin", "bob"])).toBe("rin");
  expect(memoryChoice("rin", [])).toBeUndefined();
});

function request(id: string, question: string, from: { kind: string; id?: string } | undefined, title = "May bob be told?"): Open {
  return { id, to: { kind: "owner" }, question, input: { kind: "confirm", title, detail: "why" }, ...(from === undefined ? {} : { from }) };
}

test("a share question is one the memory asked, and nothing else that waits is", () => {
  const found = shareQuestions(
    [
      request("req-1", "memory.share", { kind: "agent", id: "rin" }),
      request("req-2", "memory.share", { kind: "agent", id: "bob" }),
      request("req-3", "deploy.approve", { kind: "agent", id: "rin" }),
      request("req-4", "memory.share", undefined),
      request("req-5", "memory.share", { kind: "session", id: "rin" }),
      { kind: "paused", invocation: "inv-1" },
    ],
    "rin",
  );
  expect(found).toEqual([{ id: "req-1", title: "May bob be told?", detail: "why", reference: undefined, purpose: undefined }]);
});

test("a share question names its note and revision and the purpose, and the text is shown only while the note holds as named", () => {
  const reference = { memory: "rin", note: "note-0123456789ab", revision: 2 };
  const detail = shareDetail(reference, "to plan the week.\nTwo lines");
  expect(shareReferenceOf(detail)).toEqual({ reference, purpose: "to plan the week.\nTwo lines" });
  expect(shareReferenceOf("why")).toBeUndefined();
  const [found] = shareQuestions([{ ...request("req-1", "memory.share", { kind: "agent", id: "rin" }), input: { kind: "confirm", title: "May bob be told?", detail } }], "rin");
  expect(found).toMatchObject({ reference, purpose: "to plan the week.\nTwo lines" });
  expect(shownText(reference, { text: "He is on leave.", revision: 2, status: "live" })).toBe("He is on leave.");
  expect(shownText(reference, { text: "He is on leave.", revision: 3, status: "live" })).toBeUndefined();
  expect(shownText(reference, { text: "", revision: 2, status: "erased" })).toBeUndefined();
  expect(shownText(reference, { text: "He is on leave.", revision: 2, status: "retracted" })).toBeUndefined();
});
