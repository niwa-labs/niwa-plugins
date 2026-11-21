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
import { RequestId } from "@niwa-labs/requests/records";
import { AgentName, BriefingSectionInput, BriefingSectionOutput, SessionRefText, TurnAuthor } from "@niwa-labs/agent/records";

/** Whose memory: the name of the agent it belongs to. */
export const MemoryName = AgentName;
export type MemoryName = z.output<typeof MemoryName>;

/** The id of a note, `note-<hex>`: the module issues it. */
export const NoteId = z.string().regex(/^note-[0-9a-f]{8,16}$/, "a note is named `note-<hex>`");
export type NoteId = z.output<typeof NoteId>;

/**
 * The directory a path names, written one way: absolute, with no `.`, `..`, doubled or trailing slash.
 * A relative path names no directory, so it has none.
 */
export function canonicalDirectory(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A directory as it is read back: already in its canonical form. */
const Directory = z.string().min(1).max(512);

/**
 * The project a note holds for: the directory the project lives in, the key attached sessions carry. However
 * it is spelled, it is the canonical form of the directory, so two spellings of one directory are one project.
 */
export const Project = Directory.refine((path) => path.startsWith("/"), "a project is an absolute directory").transform((path) => canonicalDirectory(path) ?? path);

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

/**
 * A note was written again, in other words or from another source: the memory counts it as one more
 * source of the note it holds, instead of keeping a second copy.
 */
export const NoteCorroborated = record(
  "memory.note.corroborated",
  z.object({ memory: MemoryName, note: NoteId, source: NoteSource, by: TurnAuthor }),
);

/** The owner confirmed a note: it is his word from now on, until it is changed by someone else. */
export const NoteConfirmed = record("memory.note.confirmed", z.object({ memory: MemoryName, note: NoteId, by: Address }));

/**
 * A note was corrected: its text (and detail) are these from now on. The new text is a claim of its own: the
 * corrector is its only source, and a place in the top layer earned by the old text is not kept.
 */
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

/**
 * A note was lifted into the top layer of its memory: what the agent is shown first, in its briefing and
 * its prompt. A note lifted or dropped by hand stays where it was put: consolidation leaves it alone.
 */
export const NoteLifted = record("memory.note.lifted", z.object({ memory: MemoryName, note: NoteId, by: TurnAuthor }));

/** A note was dropped from the top layer: it is no longer shown first, and still holds and is found. */
export const NoteDropped = record("memory.note.dropped", z.object({ memory: MemoryName, note: NoteId, by: TurnAuthor }));

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

/** The id of a turn of an agent's inbox, as the agents module names it. */
const TurnId = z.string().regex(/^(msg|fact)-[0-9a-f]{6,16}$/);

/**
 * The digest of a session attached to an agent was taken into its memory. The digest stays where it is,
 * in the agent's inbox; the memory keeps where it is (`record`, `turn`), which session it tells of and from
 * where up to where, and the project the session works in.
 */
export const DigestTaken = record(
  "memory.digest.taken",
  z.object({
    memory: MemoryName,
    turn: TurnId,
    record: z.string().min(1),
    session: SessionRefText,
    from: z.string().min(1).optional(),
    upto: z.string().min(1),
    project: Project.optional(),
  }),
);

/**
 * A note about the owner was wanted by another address, for a purpose: it leaves the memory only on the
 * owner's own answer, which is asked for once for each revision of the note and each address.
 */
export const ShareWanted = record(
  "memory.share.wanted",
  z.object({ memory: MemoryName, note: NoteId, revision: z.number().int().positive(), for: Address, purpose: z.string().min(1) }),
);

/**
 * Whether a note about the owner may leave the memory for an address: the owner's answer to the question
 * (`request`), or his word given directly. An answer that is not the owner's own, such as one a resolver
 * found, lets nothing leave: `reason` says so.
 */
export const ShareAnswered = record(
  "memory.share.answered",
  z.object({
    memory: MemoryName,
    note: NoteId,
    revision: z.number().int().positive(),
    for: Address,
    allowed: z.boolean(),
    request: RequestId.optional(),
    reason: z.enum(["not-the-owner", "unanswered"]).optional(),
  }),
);

/**
 * A memory was consolidated: notes that say the same were merged into one, the notes that earned it were
 * lifted into the top layer and the weakest dropped out of a part grown too long, and notes that went
 * stale or did not fit were retired. A note put in or out of the top layer by hand is left where it is.
 */
export const Consolidated = record(
  "memory.consolidated",
  z.object({
    memory: MemoryName,
    merged: z.array(z.object({ note: NoteId, into: NoteId })),
    lifted: z.array(NoteId),
    dropped: z.array(NoteId),
    retired: z.array(NoteId),
  }),
);

/** The record types the module declares. */
export const MEMORY_TYPES = [NoteWritten, NoteCorroborated, NoteConfirmed, NoteCorrected, NoteRetracted, NoteErased, NoteLifted, NoteDropped, PageWritten, DigestTaken, ShareWanted, ShareAnswered, Consolidated] as const;

/** Where a note stands. */
export const NoteStatus = z.enum(["live", "retracted", "merged", "retired", "erased"]);
export type NoteStatus = z.output<typeof NoteStatus>;

/** A note as the memory holds it at a position of the journal. */
export const NoteView = z.object({
  memory: MemoryName,
  note: NoteId,
  /** Empty once the note is erased. */
  text: z.string(),
  detail: z.string().optional(),
  about: NoteAbout,
  project: Directory.optional(),
  source: NoteSource,
  by: TurnAuthor,
  status: NoteStatus,
  /** Whether the owner stands behind it: he wrote it as his word, confirmed it, or corrected it last. */
  confirmed: z.boolean(),
  /** How many sources it has: the same source, or the same writer's own conclusion, counts once. */
  sources: z.number().int().positive(),
  /** Whether it is in the top layer of its memory. */
  top: z.boolean(),
  /** Whether it was put in or out of the top layer by hand: consolidation leaves it where it is. */
  pinned: z.boolean(),
  /** How many times its text was written: 1, and one more for each correction. */
  revision: z.number().int().positive(),
  /** When the last record that changed it was written, in milliseconds since the epoch. */
  changed: z.number().int().nonnegative(),
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
  project: Directory.optional(),
  revision: z.number().int().positive(),
  by: TurnAuthor,
  /** The position of the journal where this revision was written. */
  seq: z.number().int().nonnegative(),
});
export type PageView = z.output<typeof PageView>;

/** One thing a search found: a note, a page or the digest of a session, with where it stands in the journal. */
export const SearchHit = z.object({
  kind: z.enum(["note", "page", "session"]),
  /** The note's id, the page's name, or the turn that told the digest. */
  id: z.string(),
  /** The page's title, or the session a digest tells of; the text of a note, or the start of a longer text. */
  title: z.string().optional(),
  text: z.string(),
  about: NoteAbout.optional(),
  project: Directory.optional(),
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
    "Writes a note to a memory: one conclusion (`text`), what backs it (`detail`, kept home), whom it is about (the owner or the work), the project it holds for, and its source. An agent writes to its own memory; a source of `owner` is only the owner's to give. A note the memory already holds in the same words gains a source instead of a copy (`corroborated`).",
  input: z.object({
    ...Named,
    text: NoteText,
    detail: NoteDetail.optional(),
    about: NoteAbout.default("work"),
    project: Project.optional(),
    source: NoteSource.default({ kind: "inferred" }),
  }),
  output: z.object({ memory: MemoryName, note: NoteId, corroborated: z.boolean() }),
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
    "Corrects a note: its text (and detail) are these from now on. A correction by the owner is his word; one by the agent leaves the note unconfirmed. The new text has the corrector as its only source, and earns its place in the top layer again.",
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

/** What a page list shows of each page: where it stands, not its text. */
export const PageSummary = PageView.omit({ text: true });
export type PageSummary = z.output<typeof PageSummary>;

export const memoryPageList = actionRef("memory.page.list", {
  description:
    "Lists the pages of a memory as they stand now, by name: the title, the project, the revision and who wrote it, without the text. With `project`, those of that project and the general ones.",
  input: z.object({ ...Named, project: Project.optional() }),
  output: z.object({ memory: MemoryName, pages: z.array(PageSummary) }),
});

export const memorySearch = actionRef("memory.search", {
  description:
    "Searches a memory by words: the notes that hold, the pages and the digests of attached sessions, best first. With `project`, only what holds for that project and in general. Words match whole or as the start of a longer word; nothing leaves the host.",
  input: z.object({
    ...Named,
    query: z.string().min(1).max(500),
    project: Project.optional(),
    limit: z.number().int().positive().max(50).default(10),
    at: At.optional(),
  }),
  output: z.object({ memory: MemoryName, hits: z.array(SearchHit) }),
});

export const memoryLift = actionRef("memory.lift", {
  description: "Lifts a note into the top layer of its memory: it is shown first, in the agent's briefing. Consolidation will not drop it.",
  input: z.object({ ...Named, note: NoteId }),
  output: z.object({ note: NoteId, top: z.boolean() }),
});

export const memoryDrop = actionRef("memory.drop", {
  description:
    "Drops a note from the top layer: it is no longer shown first, but still holds and is found by a search. Consolidation will not lift it again.",
  input: z.object({ ...Named, note: NoteId }),
  output: z.object({ note: NoteId, top: z.boolean() }),
});

export const memoryTop = actionRef("memory.top", {
  description:
    "The top layer of a memory for a project: the notes shown first, about the owner, for the project and in general, within the size the module allows.",
  input: z.object({ ...Named, project: Project.optional() }),
  output: z.object({ memory: MemoryName, text: z.string(), notes: z.array(NoteId), left: z.number().int().nonnegative() }),
});

/** The section of an agent's briefing the module writes: the top layer of its memory, for its project. */
export const memoryBrief = actionRef("memory.brief", {
  description:
    "The memory's section of an agent's briefing: the top layer of its memory for the project it works on (its own, or the directory of the session attached last).",
  input: BriefingSectionInput,
  output: BriefingSectionOutput,
});

/**
 * Where a conclusion told by a memory comes from: whose memory it is (the data owner's address), the note,
 * and the position of the journal it stood at, so a later look at an answer reads the memory as it was.
 */
export const SourceRef = z.object({
  owner: z.object({ kind: z.literal("agent"), id: MemoryName }),
  note: NoteId,
  seq: z.number().int().nonnegative(),
});
export type SourceRef = z.output<typeof SourceRef>;

/** One conclusion a context answer tells: its text, whom it is about and where it holds, and its source. */
export const ContextItem = z.object({
  note: NoteId,
  text: z.string(),
  about: NoteAbout,
  project: Directory.optional(),
  /** What backs it: told only to the memory's own agent and to the owner. */
  detail: z.string().optional(),
  confirmed: z.boolean(),
  source: SourceRef,
});
export type ContextItem = z.output<typeof ContextItem>;

/** A note that was relevant and did not leave, and why: it is about the owner, or holds for another project. */
export const Withheld = z.object({
  note: NoteId,
  reason: z.enum(["about-the-owner", "another-project"]),
  /** For a note about the owner: the owner was asked and has not answered, or he said no. */
  status: z.enum(["asked", "refused"]).optional(),
});
export type Withheld = z.output<typeof Withheld>;

export const memoryContext = actionRef("memory.context", {
  description:
    "Asks a memory for context: what it holds that bears on `query`, for an addressee and a purpose. Another agent is told only the conclusions with whom they are about and where they hold, never what backs them; a project's notes go to that project's agents; a note about the owner leaves only once the owner said yes, and he is asked. Every conclusion carries its source: the memory's address, the note and the position of the journal; give `at` to read the memory as it stood then.",
  input: z.object({
    memory: MemoryName,
    query: z.string().min(1).max(500),
    purpose: z.string().min(1).max(500),
    /** Whom the context is for. A caller bound to an address asks for itself; a handler names the addressee. */
    for: Address.optional(),
    project: Project.optional(),
    limit: z.number().int().positive().max(20).default(5),
    at: At.optional(),
  }),
  output: z.object({
    memory: z.object({ kind: z.literal("agent"), id: MemoryName }),
    for: Address,
    /** The position of the journal the answer was read at. */
    at: z.number().int().nonnegative(),
    items: z.array(ContextItem),
    withheld: z.array(Withheld),
  }),
});

export const memoryShare = actionRef("memory.share", {
  description:
    "The owner says whether a note about him may leave a memory for an address, without being asked. Only the owner may; his word holds for the note as it is now.",
  input: z.object({ memory: MemoryName, note: NoteId, for: Address, allowed: z.boolean() }),
  output: z.object({ note: NoteId, allowed: z.boolean() }),
});

export const memoryConsolidate = actionRef("memory.consolidate", {
  description:
    "Consolidates a memory: merges notes that say the same, lifts into the top layer the notes the owner confirmed or that have enough sources, drops the weakest from a part of the top layer grown too long, and retires notes that went stale unconfirmed or do not fit. Notes placed by hand are left where they are.",
  input: z.object({ ...Named }),
  output: z.object({
    memory: MemoryName,
    merged: z.array(z.object({ note: NoteId, into: NoteId })),
    lifted: z.array(NoteId),
    dropped: z.array(NoteId),
    retired: z.array(NoteId),
  }),
});
