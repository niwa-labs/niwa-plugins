// What a memory tells an addressee of a context request. Its own agent and the owner are told a note
// whole. Another address is told only the conclusion and where it holds: a project's note goes to the
// agents of that project, a note about the owner only once the owner said yes for that address.

import type { ShareState } from "./fold.ts";
import type { ContextItem, NoteView, Withheld } from "./records.ts";

/** Who reads: the memory's own agent or the owner, or another address and the project it works in. */
export type Reader = { readonly kind: "home" } | { readonly kind: "other"; readonly project?: string };

/** What becomes of one note: told, or withheld, and whether the owner must now be asked. */
export type Release = { readonly item: ContextItem } | { readonly withheld: Withheld; readonly ask: boolean };

/** Whether a project lies in the project an agent works in: the same directory, or one under it. */
export function within(project: string, home: string): boolean {
  const root = home.endsWith("/") ? home : `${home}/`;
  return project === home || project.startsWith(root);
}

/** What becomes of a note that bears on a request, for a reader; `share` is the owner's word on it so far. */
export function release(note: NoteView, reader: Reader, share: ShareState | undefined): Release {
  const source = { owner: { kind: "agent" as const, id: note.memory }, note: note.note, seq: note.seq };
  const told: ContextItem = {
    note: note.note,
    text: note.text,
    about: note.about,
    ...(note.project === undefined ? {} : { project: note.project }),
    confirmed: note.confirmed,
    source,
  };
  if (reader.kind === "home") return { item: { ...told, ...(note.detail === undefined ? {} : { detail: note.detail }) } };
  if (note.about === "owner") {
    if (share === "allowed") return { item: told };
    return { withheld: { note: note.note, reason: "about-the-owner", status: share === "refused" ? "refused" : "asked" }, ask: share === undefined };
  }
  if (note.project !== undefined && (reader.project === undefined || !within(note.project, reader.project))) {
    return { withheld: { note: note.note, reason: "another-project" }, ask: false };
  }
  return { item: told };
}
