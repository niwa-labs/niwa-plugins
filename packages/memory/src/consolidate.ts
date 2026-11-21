// What a consolidation does to the notes of one memory. Notes that came to say the same are merged; the
// notes the owner confirmed or that have enough sources are lifted into the top layer while its part has
// room, the strongest first, and a weaker one lifted before gives way; unconfirmed notes of one source
// that went stale are retired, and so are the oldest unplaced notes past the limit. A note put in or out
// of the top layer by hand is never moved, merged away or retired; a confirmed note is never retired.

import { holds } from "./holds.ts";
import type { NoteView } from "./records.ts";
import { similar } from "./similar.ts";

/** The limits a consolidation keeps. */
export interface ConsolidationLimits {
  /** How many sources lift an unconfirmed note into the top layer. */
  readonly liftAfter: number;
  /** How many notes each part of the top layer holds: about the owner, each project, in general. */
  readonly topNotes: number;
  /** How many notes hold in one memory. */
  readonly notes: number;
  /** How long an unconfirmed note of one source holds without a change, in milliseconds. */
  readonly staleAfter: number;
}

/** What a consolidation does. */
export interface Consolidation {
  readonly merged: Array<{ note: string; into: string }>;
  readonly lifted: string[];
  readonly dropped: string[];
  readonly retired: string[];
}

/** The part of the top layer a note belongs to. */
function partOf(note: NoteView): string {
  return note.about === "owner" ? "owner" : `work ${note.project ?? ""}`;
}

/** The stronger first: confirmed, then with more sources, then the one changed or written later. */
function stronger(a: NoteView, b: NoteView): number {
  return Number(b.confirmed) - Number(a.confirmed) || b.sources - a.sources || b.changed - a.changed || b.written - a.written;
}

/**
 * What to do with the notes of one memory, in the order they were written, at the moment `now`.
 * `sourcesOf` is how many sources a note has once the notes merged into it are counted.
 */
export function consolidate(
  notes: readonly NoteView[],
  limits: ConsolidationLimits,
  now: number,
  sourcesOf: (note: NoteView, merged: readonly NoteView[]) => number,
): Consolidation {
  const live = notes.filter(holds);
  const merged: Array<{ note: string; into: string }> = [];
  const gone = new Set<string>();
  const into = new Map<string, NoteView[]>();
  for (const [at, one] of live.entries()) {
    if (gone.has(one.note)) continue;
    for (const other of live.slice(at + 1)) {
      if (gone.has(other.note) || gone.has(one.note) || one.about !== other.about || one.project !== other.project || !similar(one.text, other.text)) continue;
      // The older is kept, unless only the newer has the owner behind it; a note placed by hand is never merged away.
      const keepNewer = (other.confirmed && !one.confirmed) || (other.pinned && !one.pinned);
      const [kept, away] = keepNewer ? [other, one] : [one, other];
      if (away.pinned) continue;
      merged.push({ note: away.note, into: kept.note });
      gone.add(away.note);
      into.set(kept.note, [...(into.get(kept.note) ?? []), away]);
    }
  }
  const held = live
    .filter((note) => !gone.has(note.note))
    .map((note) => ({ ...note, sources: sourcesOf(note, into.get(note.note) ?? []), confirmed: note.confirmed || (into.get(note.note) ?? []).some((one) => one.confirmed) }));

  // Each part of the top layer: what is placed by hand stays, and the rest of the room goes to the strongest.
  const lifted: string[] = [];
  const dropped: string[] = [];
  const top = new Set(held.filter((note) => note.top).map((note) => note.note));
  const parts = new Map<string, typeof held>();
  for (const note of held) parts.set(partOf(note), [...(parts.get(partOf(note)) ?? []), note]);
  for (const part of parts.values()) {
    const placed = part.filter((note) => note.pinned && note.top);
    const earned = part.filter((note) => !note.pinned && (note.top || note.confirmed || note.sources >= limits.liftAfter)).sort(stronger);
    const room = Math.max(0, limits.topNotes - placed.length);
    earned.forEach((note, rank) => {
      if (rank < room && !note.top) {
        lifted.push(note.note);
        top.add(note.note);
      }
      if (rank >= room && note.top) {
        dropped.push(note.note);
        top.delete(note.note);
      }
    });
  }

  // Retire what went stale, then the oldest of what is left unplaced past the limit.
  const retired: string[] = [];
  const movable = (note: (typeof held)[number]) => !note.pinned && !note.confirmed && !top.has(note.note);
  for (const note of held) {
    if (movable(note) && note.sources <= 1 && now - note.changed > limits.staleAfter) retired.push(note.note);
  }
  let holding = held.length - retired.length;
  for (const note of held) {
    if (holding <= limits.notes) break;
    if (!movable(note) || retired.includes(note.note)) continue;
    retired.push(note.note);
    holding -= 1;
  }
  return { merged, lifted: lifted.sort((a, b) => order(held, a) - order(held, b)), dropped, retired };
}

/** Where a note stands among the notes, by when it was written. */
function order(notes: readonly NoteView[], note: string): number {
  return notes.findIndex((one) => one.note === note);
}
