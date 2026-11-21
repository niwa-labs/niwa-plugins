// The memories as the journal holds them: the records of the module folded, in order, into the notes of
// every memory. A fold can stop at any position, which is how a memory is read as it stood then.

import type { StoredRecord } from "@niwa-labs/core";

import { NoteConfirmed, NoteCorrected, NoteErased, NoteRetracted, NoteWritten, PageWritten } from "./records.ts";
import type { MemoryName, NoteId, NoteView, PageName, PageView } from "./records.ts";

/** A record type with its schema: what the fold parses a stored record with. */
interface Typed<T> {
  readonly name: string;
  readonly schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
}

/** The data of a stored record of a type, or undefined when it is of another type or does not parse. */
export function dataAs<T>(stored: StoredRecord, type: Typed<T>): T | undefined {
  if (stored.type !== type.name) return undefined;
  const parsed = type.schema.safeParse(stored.data);
  return parsed.success ? parsed.data : undefined;
}

/** The notes of every memory, as far as the records folded so far say. */
export class Memories {
  readonly #notes = new Map<MemoryName, Map<NoteId, NoteView>>();
  readonly #pages = new Map<MemoryName, Map<PageName, PageView>>();
  /** The position of the last record folded. */
  seq = 0;

  /** The record types a fold reads. */
  static readonly TYPES: readonly string[] = [NoteWritten, NoteConfirmed, NoteCorrected, NoteRetracted, NoteErased, PageWritten].map((type) => type.name);

  /** The notes of one memory, in the order they were written. */
  notesOf(memory: MemoryName): NoteView[] {
    return [...(this.#notes.get(memory)?.values() ?? [])];
  }

  /** How many notes hold in all memories. */
  count(): number {
    let held = 0;
    for (const notes of this.#notes.values()) for (const note of notes.values()) if (note.status === "live") held += 1;
    return held;
  }

  note(memory: MemoryName, note: NoteId): NoteView | undefined {
    return this.#notes.get(memory)?.get(note);
  }

  /** The pages of one memory, by name. */
  pagesOf(memory: MemoryName): PageView[] {
    return [...(this.#pages.get(memory)?.values() ?? [])];
  }

  page(memory: MemoryName, page: PageName): PageView | undefined {
    return this.#pages.get(memory)?.get(page);
  }

  /** Fold one more record. Records come in the order of the journal. */
  apply(stored: StoredRecord): void {
    this.seq = Math.max(this.seq, Number(stored.seq));
    const at = Number(stored.seq);
    const written = dataAs(stored, NoteWritten);
    if (written !== undefined) {
      const notes = this.#notes.get(written.memory) ?? new Map<NoteId, NoteView>();
      this.#notes.set(written.memory, notes);
      if (notes.has(written.note)) return;
      const ownersWord = written.source.kind === "owner" && written.by.kind === "owner";
      notes.set(written.note, {
        memory: written.memory,
        note: written.note,
        text: written.text,
        ...(written.detail === undefined ? {} : { detail: written.detail }),
        about: written.about,
        ...(written.project === undefined ? {} : { project: written.project }),
        source: written.source,
        by: written.by,
        status: "live",
        confirmed: ownersWord,
        revision: 1,
        written: at,
        seq: at,
      });
      return;
    }
    const page = dataAs(stored, PageWritten);
    if (page !== undefined) {
      const pages = this.#pages.get(page.memory) ?? new Map<PageName, PageView>();
      this.#pages.set(page.memory, pages);
      pages.set(page.page, {
        memory: page.memory,
        page: page.page,
        title: page.title,
        text: page.text,
        ...(page.project === undefined ? {} : { project: page.project }),
        revision: page.revision,
        by: page.by,
        seq: at,
      });
      return;
    }
    const confirmed = dataAs(stored, NoteConfirmed);
    if (confirmed !== undefined) {
      this.#change(confirmed.memory, confirmed.note, at, (note) => ({ ...note, confirmed: true }));
      return;
    }
    const corrected = dataAs(stored, NoteCorrected);
    if (corrected !== undefined) {
      this.#change(corrected.memory, corrected.note, at, (note) => {
        const { detail: _dropped, ...rest } = note;
        return {
          ...rest,
          text: corrected.text,
          ...(corrected.detail === undefined ? {} : { detail: corrected.detail }),
          revision: note.revision + 1,
          confirmed: corrected.by.kind === "owner",
        };
      });
      return;
    }
    const retracted = dataAs(stored, NoteRetracted);
    if (retracted !== undefined) {
      this.#change(retracted.memory, retracted.note, at, (note) => (note.status === "live" ? { ...note, status: "retracted" } : note));
      return;
    }
    const erased = dataAs(stored, NoteErased);
    if (erased !== undefined) {
      this.#change(erased.memory, erased.note, at, (note) => {
        const { detail: _dropped, ...rest } = note;
        return { ...rest, text: "", status: "erased" };
      });
    }
  }

  #change(memory: MemoryName, id: NoteId, at: number, fn: (note: NoteView) => NoteView): void {
    const notes = this.#notes.get(memory);
    const note = notes?.get(id);
    if (notes === undefined || note === undefined || note.status === "erased") return;
    notes.set(id, { ...fn(note), seq: at });
  }
}
