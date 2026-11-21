/**
 * The records entry of the memory module: what another plugin may import from it. The records the
 * module writes, the shapes of a note and its source, and the typed references of its actions; no
 * factory and nothing that runs.
 *
 * There is one memory module on a host, and every agent has a memory of its own in it, named by the
 * agent's name. A caller bound to an agent reaches that agent's memory; the owner reaches every one.
 */

import { z } from "zod";

import { Address, actionRef, record } from "@niwa-labs/core";
import { AgentName, SessionRefText, TurnAuthor } from "@niwa-labs/agent/records";

/** Whose memory: the name of the agent it belongs to. */
export const MemoryName = AgentName;
export type MemoryName = z.output<typeof MemoryName>;

/** The id of a note, `note-<hex>`: the module issues it. */
export const NoteId = z.string().regex(/^note-[0-9a-f]{8,16}$/, "a note is named `note-<hex>`");
export type NoteId = z.output<typeof NoteId>;

/** The project a note holds for: the directory the project lives in, the key attached sessions carry. */
export const Project = z.string().min(1).max(512);

/** Whom a note is about: the owner himself, or the work. */
export const NoteAbout = z.enum(["owner", "work"]);
export type NoteAbout = z.output<typeof NoteAbout>;

/**
 * Where a note comes from. `owner`: the owner said it to the memory himself. `inferred`: the writer
 * concluded it. `session`: it was read in the transcript of a session, up to a locator. `record`: a
 * record of the journal shows it.
 */
export const NoteSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("inferred") }).strict(),
  z
    .object({ kind: z.literal("session"), session: SessionRefText, from: z.string().min(1).optional(), upto: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("record"), record: z.string().min(1) }).strict(),
]);
export type NoteSource = z.output<typeof NoteSource>;

/** The longest text of a note: one conclusion, said in a few sentences. */
export const NOTE_TEXT_MAX = 1_000;
/** The longest detail of a note: what backs it, kept home. */
export const NOTE_DETAIL_MAX = 4_000;

const NoteText = z.string().trim().min(1).max(NOTE_TEXT_MAX);
const NoteDetail = z.string().trim().min(1).max(NOTE_DETAIL_MAX);

/**
 * A note was written. `text` is the conclusion, the part that may leave the memory; `detail` is what
 * backs it and stays home. `by` is who wrote it, which never makes it the owner's word: only a source
 * of `owner` written by the owner is.
 */
export const NoteWritten = record(
  "memory.note.written",
  z.object({
    memory: MemoryName,
    note: NoteId,
    text: NoteText,
    detail: NoteDetail.optional(),
    about: NoteAbout,
    project: Project.optional(),
    source: NoteSource,
    by: TurnAuthor,
  }),
);

/** The owner confirmed a note: it is his word from now on, until it is changed by someone else. */
export const NoteConfirmed = record("memory.note.confirmed", z.object({ memory: MemoryName, note: NoteId, by: Address }));

/** A note was corrected: its text (and detail) are these from now on. */
export const NoteCorrected = record(
  "memory.note.corrected",
  z.object({ memory: MemoryName, note: NoteId, text: NoteText, detail: NoteDetail.optional(), by: TurnAuthor }),
);

/** A note was taken back: its conclusion no longer holds. It stays in the history, never in an answer. */
export const NoteRetracted = record(
  "memory.note.retracted",
  z.object({ memory: MemoryName, note: NoteId, reason: z.string().min(1).optional(), by: TurnAuthor }),
);

/**
 * A note was erased: its text is never shown again, nor searched, nor told. The journal is written once,
 * so the record that first held the text is still there; a reader of the memory sees only that it was.
 */
export const NoteErased = record("memory.note.erased", z.object({ memory: MemoryName, note: NoteId, by: TurnAuthor }));

/** The name of a page: lowercase words joined by `-`, `_`, `.` or `/`. */
export const PageName = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/, "a page is named with lowercase letters, digits, '.', '_', '-' or '/', at most 128");
export type PageName = z.output<typeof PageName>;

/** The largest text of a page, in bytes: what the journal still holds inline in a record. */
export const PAGE_TEXT_MAX_BYTES = 16 * 1024;

const PageText = z
  .string()
  .min(1)
  .refine((text) => Buffer.byteLength(text, "utf8") <= PAGE_TEXT_MAX_BYTES, `a page holds at most ${String(PAGE_TEXT_MAX_BYTES)} bytes: split it`);

/**
 * A page was written: a longer text a memory keeps under a name, such as what a project is and how it
 * works. A page is written whole; each write is its next revision.
 */
export const PageWritten = record(
  "memory.page.written",
  z.object({
    memory: MemoryName,
    page: PageName,
    title: z.string().min(1).max(200),
    text: PageText,
    project: Project.optional(),
    revision: z.number().int().positive(),
    by: TurnAuthor,
  }),
);

/** The record types the module declares. */
export const MEMORY_TYPES = [NoteWritten, NoteConfirmed, NoteCorrected, NoteRetracted, NoteErased, PageWritten] as const;

/** Where a note stands. */
export const NoteStatus = z.enum(["live", "retracted", "erased"]);
export type NoteStatus = z.output<typeof NoteStatus>;

/** A note as the memory holds it at a position of the journal. */
export const NoteView = z.object({
  memory: MemoryName,
  note: NoteId,
  /** Empty once the note is erased. */
  text: z.string(),
  detail: z.string().optional(),
  about: NoteAbout,
  project: Project.optional(),
  source: NoteSource,
  by: TurnAuthor,
  status: NoteStatus,
  /** Whether the owner stands behind it: he wrote it as his word, confirmed it, or corrected it last. */
  confirmed: z.boolean(),
  /** How many times its text was written: 1, and one more for each correction. */
  revision: z.number().int().positive(),
  /** The position of the journal where it was written, and of the last record that changed it. */
  written: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
});
export type NoteView = z.output<typeof NoteView>;

/** A page as the memory holds it. */
export const PageView = z.object({
  memory: MemoryName,
  page: PageName,
  title: z.string(),
  text: z.string(),
  project: Project.optional(),
  revision: z.number().int().positive(),
  by: TurnAuthor,
  /** The position of the journal where this revision was written. */
  seq: z.number().int().nonnegative(),
});
export type PageView = z.output<typeof PageView>;

/** One thing a search found: a note or a page, with where it stands in the journal. */
export const SearchHit = z.object({
  kind: z.enum(["note", "page"]),
  /** The note's id, or the page's name. */
  id: z.string(),
  /** The page's title; the text of a note, or the start of a page's text. */
  title: z.string().optional(),
  text: z.string(),
  about: NoteAbout.optional(),
  project: Project.optional(),
  score: z.number(),
  seq: z.number().int().nonnegative(),
});
export type SearchHit = z.output<typeof SearchHit>;

/** The memory a call names. A caller bound to an agent may leave it out, or name its own. */
const Named = { memory: MemoryName.optional() };

/** A position of the journal: the memory as it was right after that record. */
const At = z.number().int().nonnegative();

export const memoryNote = actionRef("memory.note", {
  description:
    "Writes a note to a memory: one conclusion (`text`), what backs it (`detail`, kept home), whom it is about (the owner or the work), the project it holds for, and its source. An agent writes to its own memory; a source of `owner` is only the owner's to give.",
  input: z.object({
    ...Named,
    text: NoteText,
    detail: NoteDetail.optional(),
    about: NoteAbout.default("work"),
    project: Project.optional(),
    source: NoteSource.default({ kind: "inferred" }),
  }),
  output: z.object({ memory: MemoryName, note: NoteId }),
});

export const memoryGet = actionRef("memory.get", {
  description: "Gets one note of a memory, as it stands now or as it stood at a position of the journal (`at`).",
  input: z.object({ ...Named, note: NoteId, at: At.optional() }),
  output: NoteView,
});

export const memoryList = actionRef("memory.list", {
  description: "Lists the notes of a memory that hold now, newest first; with `project`, those of that project and the general ones.",
  input: z.object({ ...Named, project: Project.optional(), about: NoteAbout.optional(), limit: z.number().int().positive().max(500).default(50) }),
  output: z.object({ memory: MemoryName, notes: z.array(NoteView) }),
});

export const memoryConfirm = actionRef("memory.confirm", {
  description: "The owner confirms a note of a memory: it is his word from now on. Only the owner may.",
  input: z.object({ memory: MemoryName, note: NoteId }),
  output: z.object({ note: NoteId, confirmed: z.boolean() }),
});

export const memoryCorrect = actionRef("memory.correct", {
  description:
    "Corrects a note: its text (and detail) are these from now on. A correction by the owner is his word; one by the agent leaves the note unconfirmed.",
  input: z.object({ ...Named, note: NoteId, text: NoteText, detail: NoteDetail.optional() }),
  output: z.object({ note: NoteId, revision: z.number().int().positive() }),
});

export const memoryRetract = actionRef("memory.retract", {
  description: "Takes a note back: its conclusion no longer holds. It stays in the history and never reaches an answer again.",
  input: z.object({ ...Named, note: NoteId, reason: z.string().min(1).optional() }),
  output: z.object({ note: NoteId }),
});

export const memoryErase = actionRef("memory.erase", {
  description:
    "Erases a note: its text is never shown, searched or told again. Stronger than a retraction; an answer that once rested on it can no longer be read back.",
  input: z.object({ ...Named, note: NoteId }),
  output: z.object({ note: NoteId }),
});

export const memoryPageWrite = actionRef("memory.page.write", {
  description:
    "Writes a page of a memory whole: a longer text under a name, such as what a project is and how it works. Give the revision it was read at to refuse a write over a change made since.",
  input: z.object({
    ...Named,
    page: PageName,
    title: z.string().min(1).max(200),
    text: PageText,
    project: Project.optional(),
    /** The revision the page was read at; 0 for a page that must be new. */
    revision: z.number().int().nonnegative().optional(),
  }),
  output: z.object({ page: PageName, revision: z.number().int().positive() }),
});

export const memoryPageGet = actionRef("memory.page.get", {
  description: "Gets a page of a memory, as it stands now or at a position of the journal (`at`).",
  input: z.object({ ...Named, page: PageName, at: At.optional() }),
  output: PageView,
});

export const memorySearch = actionRef("memory.search", {
  description:
    "Searches a memory by words: the notes that hold and the pages, best first. With `project`, only what holds for that project and in general. Words match whole or as the start of a longer word; nothing leaves the host.",
  input: z.object({
    ...Named,
    query: z.string().min(1).max(500),
    project: Project.optional(),
    limit: z.number().int().positive().max(50).default(10),
    at: At.optional(),
  }),
  output: z.object({ memory: MemoryName, hits: z.array(SearchHit) }),
});
