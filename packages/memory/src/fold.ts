// The memories as the journal holds them: the records of the module folded, in order, into the notes of
// every memory. A fold can stop at any position, which is how a memory is read as it stood then.

import { stableJson } from "@niwa-labs/core";
import type { Address, StoredRecord } from "@niwa-labs/core";
import type { TurnAuthor } from "@niwa-labs/agent/records";

import { Consolidated, DigestTaken, NoteConfirmed, NoteCorroborated, NoteCorrected, NoteDropped, NoteErased, NoteLifted, NoteRetracted, NoteWritten, PageWritten, ShareAnswered, ShareWanted } from "./records.ts";
import type { MemoryName, NoteId, NoteSource, NoteView, PageName, PageView } from "./records.ts";

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

/** A digest taken into a memory: where it is in the journal, and what it tells of. */
export interface TakenDigest {
  readonly turn: string;
  readonly record: string;
  readonly session: string;
  readonly project?: string;
  /** The position where it was taken. */
  readonly seq: number;
}

/**
 * What a source counts as: a session or a record is one source whoever read it; a conclusion is one
 * source for each writer who drew it; the owner's word is one.
 */
export function sourceKey(source: NoteSource, by: TurnAuthor): string {
  switch (source.kind) {
    case "owner":
      return "owner";
    case "inferred":
      return stableJson(["inferred", by]);
    case "session":
      return stableJson(["session", source.session]);
    case "record":
      return stableJson(["record", source.record]);
  }
}

/** Where the owner's word on a note leaving for an address stands: asked, or answered. */
export type ShareState = "asked" | "allowed" | "refused";

/** The key of the owner's word on one revision of one note for one address. */
function shareKey(memory: MemoryName, note: NoteId, revision: number, to: Address): string {
  return `${memory} ${note} ${String(revision)} ${stableJson(to)}`;
}

/** The notes of every memory, as far as the records folded so far say. */
export class Memories {
  readonly #notes = new Map<MemoryName, Map<NoteId, NoteView>>();
  readonly #pages = new Map<MemoryName, Map<PageName, PageView>>();
  readonly #digests = new Map<MemoryName, TakenDigest[]>();
  readonly #shares = new Map<string, ShareState>();
  /** The sources each note counts, by memory and note. */
  readonly #sources = new Map<string, Set<string>>();
  /** How many records changed each memory since it was last consolidated. */
  readonly #changes = new Map<MemoryName, number>();
  /** The position of the last record folded. */
  seq = 0;

  /** The record types a fold reads. */
  static readonly TYPES: readonly string[] = [NoteWritten, NoteCorroborated, NoteConfirmed, NoteCorrected, NoteRetracted, NoteErased, NoteLifted, NoteDropped, PageWritten, DigestTaken, ShareWanted, ShareAnswered, Consolidated].map((type) => type.name);

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

  /** The digests taken into one memory, oldest first. */
  digestsOf(memory: MemoryName): readonly TakenDigest[] {
    return this.#digests.get(memory) ?? [];
  }

  /** Where the owner's word on a note leaving for an address stands, for the note's revision now. */
  share(memory: MemoryName, note: NoteId, revision: number, to: Address): ShareState | undefined {
    return this.#shares.get(shareKey(memory, note, revision, to));
  }

  /** Erase here what `later` erased: an erased note is not read back at any position. */
  eraseAsIn(later: Memories): void {
    for (const [memory, notes] of this.#notes) {
      for (const [id, note] of notes) {
        if (later.note(memory, id)?.status !== "erased") continue;
        const { detail: _dropped, ...rest } = note;
        notes.set(id, { ...rest, text: "", status: "erased", top: false });
      }
    }
  }

  /** How many records changed a memory since it was last consolidated. */
  changesOf(memory: MemoryName): number {
    return this.#changes.get(memory) ?? 0;
  }

  /** How many sources a note has with the sources of the notes merged into it. */
  sourcesWith(memory: MemoryName, note: NoteId, merged: readonly NoteId[]): number {
    const all = new Set(this.#sources.get(`${memory} ${note}`));
    for (const one of merged) for (const key of this.#sources.get(`${memory} ${one}`) ?? []) all.add(key);
    return Math.max(all.size, 1);
  }

  /** Whether a note already counts this source. */
  counts(memory: MemoryName, note: NoteId, key: string): boolean {
    return this.#sources.get(`${memory} ${note}`)?.has(key) ?? false;
  }

  /** Fold one more record. Records come in the order of the journal. */
  apply(stored: StoredRecord): void {
    this.seq = Math.max(this.seq, Number(stored.seq));
    const at = Number(stored.seq);
    this.#when = Number(stored.at);
    const consolidated = dataAs(stored, Consolidated);
    if (consolidated !== undefined) {
      this.#consolidated(consolidated, at);
      return;
    }
    const memory = (stored.data as { memory?: unknown } | null)?.memory;
    if (typeof memory === "string" && !stored.type.startsWith("memory.share.")) this.#changes.set(memory as MemoryName, this.changesOf(memory as MemoryName) + 1);
    const written = dataAs(stored, NoteWritten);
    if (written !== undefined) {
      const notes = this.#notes.get(written.memory) ?? new Map<NoteId, NoteView>();
      this.#notes.set(written.memory, notes);
      if (notes.has(written.note)) return;
      const ownersWord = written.source.kind === "owner" && written.by.kind === "owner";
      this.#sources.set(`${written.memory} ${written.note}`, new Set([sourceKey(written.source, written.by)]));
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
        sources: 1,
        changed: Number(stored.at),
        top: false,
        pinned: false,
        revision: 1,
        written: at,
        seq: at,
      });
      return;
    }
    const taken = dataAs(stored, DigestTaken);
    if (taken !== undefined) {
      const digests = this.#digests.get(taken.memory) ?? [];
      this.#digests.set(taken.memory, digests);
      digests.push({ turn: taken.turn, record: taken.record, session: taken.session, ...(taken.project === undefined ? {} : { project: taken.project }), seq: at });
      return;
    }
    const wanted = dataAs(stored, ShareWanted);
    if (wanted !== undefined) {
      const key = shareKey(wanted.memory, wanted.note, wanted.revision, wanted.for);
      if (!this.#shares.has(key)) this.#shares.set(key, "asked");
      return;
    }
    const answered = dataAs(stored, ShareAnswered);
    if (answered !== undefined) {
      this.#shares.set(shareKey(answered.memory, answered.note, answered.revision, answered.for), answered.allowed ? "allowed" : "refused");
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
    const corroborated = dataAs(stored, NoteCorroborated);
    if (corroborated !== undefined) {
      const counted = this.#sources.get(`${corroborated.memory} ${corroborated.note}`);
      if (counted === undefined) return;
      counted.add(sourceKey(corroborated.source, corroborated.by));
      const ownersWord = corroborated.source.kind === "owner" && corroborated.by.kind === "owner";
      this.#change(corroborated.memory, corroborated.note, at, (note) => ({ ...note, sources: counted.size, confirmed: note.confirmed || ownersWord }));
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
    const lifted = dataAs(stored, NoteLifted);
    if (lifted !== undefined) {
      this.#change(lifted.memory, lifted.note, at, (note) => ({ ...note, top: true, pinned: true }));
      return;
    }
    const dropped = dataAs(stored, NoteDropped);
    if (dropped !== undefined) {
      this.#change(dropped.memory, dropped.note, at, (note) => ({ ...note, top: false, pinned: true }));
      return;
    }
    const erased = dataAs(stored, NoteErased);
    if (erased !== undefined) {
      this.#change(erased.memory, erased.note, at, (note) => {
        const { detail: _dropped, ...rest } = note;
        return { ...rest, text: "", status: "erased", top: false };
      });
    }
  }

  /** When the record folded last was written. */
  #when = 0;

  #change(memory: MemoryName, id: NoteId, at: number, fn: (note: NoteView) => NoteView): void {
    const notes = this.#notes.get(memory);
    const note = notes?.get(id);
    if (notes === undefined || note === undefined || note.status === "erased") return;
    notes.set(id, { ...fn(note), seq: at, changed: this.#when });
  }

  #consolidated(done: { memory: MemoryName; merged: Array<{ note: NoteId; into: NoteId }>; lifted: NoteId[]; dropped: NoteId[]; retired: NoteId[] }, at: number): void {
    const { memory } = done;
    this.#changes.set(memory, 0);
    for (const { note, into } of done.merged) {
      const away = this.note(memory, note);
      const kept = this.#sources.get(`${memory} ${into}`);
      for (const key of this.#sources.get(`${memory} ${note}`) ?? []) kept?.add(key);
      this.#change(memory, note, at, (one) => ({ ...one, status: "merged", top: false }));
      this.#change(memory, into, at, (one) => ({ ...one, sources: kept?.size ?? one.sources, confirmed: one.confirmed || away?.confirmed === true }));
    }
    for (const note of done.lifted) this.#change(memory, note, at, (one) => ({ ...one, top: true }));
    for (const note of done.dropped) this.#change(memory, note, at, (one) => ({ ...one, top: false }));
    for (const note of done.retired) this.#change(memory, note, at, (one) => ({ ...one, status: "retired", top: false }));
  }
}
