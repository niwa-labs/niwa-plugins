// The top layer of a memory: the notes it shows first. For a project it holds the lifted notes about the
// owner, those for the project and those that hold in general, in that order and the newest first in
// each part, as many as fit in its size.

import { holds, holdsFor } from "./holds.ts";
import type { NoteView } from "./records.ts";

/** The top layer as it is shown: its text, the notes in it, and how many lifted notes did not fit. */
export interface TopLayer {
  readonly text: string;
  readonly notes: string[];
  readonly left: number;
}

/** The top layer of the notes of one memory, for a project (none: the owner and what holds in general). */
export function topLayer(notes: readonly NoteView[], project: string | undefined, size: number): TopLayer {
  const lifted = notes.filter((note) => holds(note) && note.top).reverse();
  const parts: Array<{ heading: string; notes: NoteView[] }> = [
    { heading: "About the owner:", notes: lifted.filter((note) => note.about === "owner" && holdsFor(note.project, project)) },
    ...(project === undefined ? [] : [{ heading: `For ${project}:`, notes: lifted.filter((note) => note.about === "work" && note.project === project) }]),
    { heading: "In general:", notes: lifted.filter((note) => note.about === "work" && note.project === undefined) },
  ];
  const lines: string[] = [];
  const shown: string[] = [];
  let length = -1;
  let left = 0;
  for (const part of parts) {
    let headed = false;
    for (const note of part.notes) {
      const line = `- ${note.text} (${note.note})`;
      const adds = line.length + 1 + (headed ? 0 : part.heading.length + 1);
      if (length + adds > size) {
        left += 1;
        continue;
      }
      if (!headed) lines.push(part.heading);
      headed = true;
      lines.push(line);
      shown.push(note.note);
      length += adds;
    }
  }
  return { text: lines.join("\n"), notes: shown, left };
}
