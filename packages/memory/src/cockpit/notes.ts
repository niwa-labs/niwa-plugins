/** What the memory page makes of notes and of the questions that wait: the top layer by part, sources, and share questions. */

import { SHARE_QUESTION, shareReferenceOf } from "../share-question.ts";
import type { ShareReference } from "../share-question.ts";
import type { Note, NoteSource, Open, OpenRequest } from "./actions.ts";

export { SHARE_QUESTION };

/** A part of the top layer: what it is called and the notes in it. */
export type TopPart = { heading: string; notes: Note[] };

/**
 * The top layer by part, as the memory shows it to an agent: the lifted notes about the owner, then those for one project
 * each, then the ones that hold in general; the newest first in each part. A part with no note is left out.
 */
export function topParts(notes: readonly Note[]): TopPart[] {
  const lifted = notes.filter((note) => note.top).sort((a, b) => b.written - a.written);
  const projects = [...new Set(lifted.filter((note) => note.about === "work" && note.project !== undefined).map((note) => note.project!))].sort();
  const parts: TopPart[] = [
    { heading: "О владельце", notes: lifted.filter((note) => note.about === "owner") },
    ...projects.map((project) => ({ heading: `Проект ${project}`, notes: lifted.filter((note) => note.about === "work" && note.project === project) })),
    { heading: "Общее", notes: lifted.filter((note) => note.about === "work" && note.project === undefined) },
  ];
  return parts.filter((part) => part.notes.length > 0);
}

/** The notes in the order of the page: newest first. */
export function newestFirst(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => b.written - a.written);
}

/** Where a note comes from, in a few words. */
export function sourceText(source: NoteSource): string {
  switch (source.kind) {
    case "owner":
      return "слова владельца";
    case "inferred":
      return "вывод автора";
    case "session":
      return `сессия ${source.session}`;
    case "record":
      return `запись ${source.record}`;
  }
}

/** How much a note stands on: подтверждено владельцем, or by how many sources. */
export function standingText(note: Pick<Note, "confirmed" | "sources">): string {
  if (note.confirmed) return "подтверждено владельцем";
  return note.sources === 1 ? "один источник" : `источников: ${String(note.sources)}`;
}

/** The memory the page shows: the one asked for when it is one of the agents', else the first. */
export function memoryChoice(asked: string | undefined, names: readonly string[]): string | undefined {
  return asked !== undefined && names.includes(asked) ? asked : names[0];
}

/** A question waiting for the owner about what a memory may tell: the note it is about, when its detail names one. */
export type ShareQuestion = { id: string; title: string; detail: string | undefined; reference: ShareReference | undefined; purpose: string | undefined };

function isOpenRequest(open: Open): open is OpenRequest {
  return "question" in open;
}

/** The share questions that wait for one memory: those it asked, which name it as the asker. */
export function shareQuestions(open: readonly Open[], memory: string): ShareQuestion[] {
  return open
    .filter(isOpenRequest)
    .filter((one) => one.question === SHARE_QUESTION && one.from?.kind === "agent" && one.from.id === memory)
    .map((one) => {
      const named = shareReferenceOf(one.input.detail);
      return { id: one.id, title: one.input.title, detail: one.input.detail, reference: named?.reference, purpose: named?.purpose };
    });
}

/** What a question's note shows now: the owner is shown its text only while the note still holds as the question named it. */
export function shownText(reference: ShareReference, note: Pick<Note, "text" | "revision"> & { status: string }): string | undefined {
  return note.status === "live" && note.revision === reference.revision ? note.text : undefined;
}
