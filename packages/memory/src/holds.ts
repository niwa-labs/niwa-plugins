// What holds where: the two questions every reader of a memory asks of a note.

import type { NoteView } from "./records.ts";

/** Whether a note holds now: neither taken back nor erased. */
export function holds(note: NoteView): boolean {
  return note.status === "live";
}

/** Whether what holds for `scope` (a project, or none for every project) holds where `project` is asked for. */
export function holdsFor(scope: string | undefined, project: string | undefined): boolean {
  return scope === undefined || project === undefined || scope === project;
}
