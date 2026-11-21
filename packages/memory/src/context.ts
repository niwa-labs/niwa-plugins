// What a memory tells an addressee of a context request. Its own agent and the owner are told a note
// whole. Another address is told only the conclusion and where it holds: a project's note goes to the
// agents of that project, a note about the owner only once the owner said yes for that address.

import type { ShareState } from "./fold.ts";
import type { ContextItem, NoteView } from "./records.ts";

/** Who reads: the memory's own agent or the owner, or another address and the project it works in. */
export type Reader = { readonly kind: "home" } | { readonly kind: "other"; readonly project?: string };

/**
 * Where a note stands for a reader: `told` (it may be said), `private` (it is about the owner and he has not said
 * yes), or `elsewhere` (it holds for a project the reader is not in, and is not so much as named to it).
 */
export type Standing = "told" | "private" | "elsewhere";

/** Whether a project lies in the project an agent works in: the same directory, or one under it. */
export function within(project: string, home: string): boolean {
  const root = home.endsWith("/") ? home : `${home}/`;
  return project === home || project.startsWith(root);
}

/** Where a note stands for a reader; `share` is the owner's word on it so far. */
export function standing(note: NoteView, reader: Reader, share: ShareState | undefined): Standing {
  if (reader.kind === "home") return "told";
  if (note.project !== undefined && (reader.project === undefined || !within(note.project, reader.project))) return "elsewhere";
  return note.about === "owner" && share !== "allowed" ? "private" : "told";
}

/** What a context answer tells of a note: the conclusion and where it holds; what backs it only to its own readers. */
export function conclusion(note: NoteView, reader: Reader): ContextItem {
  return {
    note: note.note,
    text: note.text,
    about: note.about,
    ...(note.project === undefined ? {} : { project: note.project }),
    ...(reader.kind === "home" && note.detail !== undefined ? { detail: note.detail } : {}),
    confirmed: note.confirmed,
    source: { owner: { kind: "agent", id: note.memory }, note: note.note, seq: note.seq },
  };
}
