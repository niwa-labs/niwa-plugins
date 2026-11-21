/**
 * The memory module: one memory implementation on a host, and a memory in it for every agent.
 *
 * A note is one conclusion with its source: whom it is about, the project it holds for, and whether the
 * owner stands behind it. Everything the module knows is a record of the journal, folded when it is read,
 * so a memory can be read as it stood at any position.
 *
 * An agent reaches its memory with its own address: the binding says which address a caller speaks as,
 * and a caller bound to an agent reaches that agent's memory and no other. The owner reaches every
 * memory; the host and the handlers of other plugins name the memory they mean.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { z } from "zod";

import { action, agent as agentAddress, addressText, confirmOptions, isYes, owner, recordId, recordTypeName, seq, stableJson } from "@niwa-labs/core";
import type { ActionContext, Address, Caller, JournalReader, Step } from "@niwa-labs/core";
import { COCKPIT_MODULE, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AgentAttached, AgentDetached, AgentTurnQueued, SessionDigestTaken, agentGet } from "@niwa-labs/agent/records";
import type { TurnAuthor } from "@niwa-labs/agent/records";

import { QuestionName, RequestAnswered, requestAsk, requestCancel, requestFind, requestGet } from "@niwa-labs/requests/records";

import { consolidate } from "./consolidate.ts";
import type { ConsolidationLimits } from "./consolidate.ts";
import { conclusion, standing } from "./context.ts";
import type { Reader } from "./context.ts";
import { Memories, dataAs, sourceKey } from "./fold.ts";
import type { TakenDigest } from "./fold.ts";
import {
  MEMORY_TYPES,
  Consolidated,
  DigestTaken,
  NoteConfirmed,
  NoteCorroborated,
  NoteCorrected,
  NoteDropped,
  NoteErased,
  NoteLifted,
  NoteRetracted,
  NoteWritten,
  PageWritten,
  ShareAnswered,
  ShareWanted,
  memoryBrief,
  memoryConfirm,
  memoryConsolidate,
  memoryContext,
  memoryCorrect,
  memoryDrop,
  memoryErase,
  memoryGet,
  memoryLift,
  memoryList,
  memoryNote,
  memoryPageGet,
  memoryPageList,
  memoryPageWrite,
  memoryRetract,
  memorySearch,
  memoryShare,
  memoryTop,
  canonicalDirectory,
} from "./records.ts";
import type { ContextItem, MemoryName, NoteId, NoteView, PageView, SearchHit, Withheld } from "./records.ts";
import { holds, holdsFor } from "./holds.ts";
import { rank } from "./search.ts";
import { SHARE_QUESTION, shareDetail } from "./share-question.ts";
import { same } from "./same.ts";
import { topLayer } from "./top.ts";

export * from "./records.ts";

/** What the module is given. */
export interface MemoryOptions {
  /**
   * The address a caller speaks as: the binding the composition gives the messages module, so a session
   * of an agent speaks as the agent. Default: a client with the owner's token speaks as the owner, and
   * nobody else speaks as anybody.
   */
  readonly bind?: CallerBinding;
  /** How much a memory holds and shows. */
  readonly limits?: Partial<MemoryLimits>;
}

/** How much a memory holds and shows, and when it consolidates. */
export interface MemoryLimits extends ConsolidationLimits {
  /** The most characters the top layer of a memory shows, headings included. Default 4000, about a thousand tokens. */
  readonly top: number;
  /** How many of the latest digests of sessions a search reads. Default 200. */
  readonly sessions: number;
  /** How many records change a memory before a digest coming in consolidates it. Default 20. */
  readonly consolidateEvery: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The limits a memory keeps unless the composition says otherwise: three sources lift a note, each part
 * of the top layer holds twelve, a memory holds five hundred notes, and an unconfirmed note of one source
 * goes stale after thirty days without a change.
 */
export const DEFAULT_LIMITS: MemoryLimits = { top: 4_000, sessions: 200, consolidateEvery: 20, liftAfter: 3, topNotes: 12, notes: 500, staleAfter: 30 * DAY_MS };

/** A refusal of the memory module: a memory the caller may not reach, a note it may not change. */
export class MemoryRefusal extends Error {
  override name = "MemoryRefusal";
  constructor(
    readonly code: "not-yours" | "no-memory" | "not-owner" | "no-note" | "no-page" | "stale-page" | "erased" | "unbound" | "no-addressee",
    message: string,
  ) {
    super(message);
  }
}

/** The default binding: a client with the owner's token is the owner; nobody else is anybody. */
function ownerOnly(caller: Caller): Address | undefined {
  return caller.kind === "client" && caller.principal?.kind === "owner" ? owner : undefined;
}

/** The id of a note: a hash of the operation that wrote it, so a call made again names the same note. */
function noteIdOf(operation: string): NoteId {
  return `note-${createHash("sha256").update(operation).digest("hex").slice(0, 12)}`;
}



/** The canonical form of a directory another module names, when it names one. */
function directoryOf(path: string | undefined): string | undefined {
  return path === undefined ? undefined : canonicalDirectory(path);
}

/** The start of a long text, cut at a word. */
function opening(text: string, max = 280): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A digest a search reads, with its text when the journal still has it. */
export interface ReadDigest extends TakenDigest {
  readonly text: string;
}

/** The notes that hold, the pages and the digests of a memory, as a search ranks them. */
export function searchable(
  notes: readonly NoteView[],
  pages: readonly PageView[],
  digests: readonly ReadDigest[],
  project: string | undefined,
): Array<{ text: string; value: SearchHit }> {
  const ofNotes = notes
    .filter((note) => holds(note) && holdsFor(note.project, project))
    .map((note) => ({
      order: note.written,
      text: `${note.text}\n${note.detail ?? ""}`,
      value: {
        kind: "note" as const,
        id: note.note,
        text: note.text,
        about: note.about,
        ...(note.project === undefined ? {} : { project: note.project }),
        score: 0,
        seq: note.seq,
      },
    }));
  const ofPages = pages
    .filter((page) => holdsFor(page.project, project))
    .map((page) => ({
      order: page.seq,
      text: `${page.title}\n${page.text}`,
      value: { kind: "page" as const, id: page.page, title: page.title, text: opening(page.text), ...(page.project === undefined ? {} : { project: page.project }), score: 0, seq: page.seq },
    }));
  const ofDigests = digests
    .filter((digest) => holdsFor(digest.project, project))
    .map((digest) => ({
      order: digest.seq,
      text: digest.text,
      value: {
        kind: "session" as const,
        id: digest.turn,
        title: digest.session,
        text: opening(digest.text),
        ...(digest.project === undefined ? {} : { project: digest.project }),
        score: 0,
        seq: digest.seq,
      },
    }));
  return [...ofNotes, ...ofPages, ...ofDigests].sort((a, b) => a.order - b.order).map(({ text, value }) => ({ text, value }));
}

/** The name of the question that asks the owner whether a note about him may leave a memory. */
const SHARE_QUESTION_NAME = QuestionName.parse(SHARE_QUESTION);

/** The memory module. */
export function memory(options: MemoryOptions = {}): Plugin {
  const bind = options.bind ?? ownerOnly;
  const limits: MemoryLimits = { ...DEFAULT_LIMITS, ...options.limits };

  return plugin("memory", (api) => {
    api.declare(...MEMORY_TYPES);
    // The page of this plugin in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "memory", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });

    const journal = (): JournalReader => {
      const reader = api.journal?.();
      if (reader === undefined) throw new Error("the memory is read from the journal, and the host is not serving it");
      return reader;
    };
    const types = Memories.TYPES.map((name) => recordTypeName(name));

    // The clock of the host: what a consolidation measures staleness by.
    let clock: () => number = Date.now;
    api.service((ctx) => {
      clock = () => ctx.now();
      return () => {};
    });

    // The memories as they stand now, folded on from where the last read stopped.
    const live = new Memories();
    const now = (): Memories => {
      for (const stored of journal().since(seq(live.seq), types)) live.apply(stored);
      return live;
    };
    /** The memories as they stood right after the record at `at`. */
    const asOf = (at: number | undefined): Memories => {
      if (at === undefined) return now();
      const then = new Memories();
      for (const stored of journal().since(seq(0), types)) {
        if (Number(stored.seq) > at) break;
        then.apply(stored);
      }
      then.eraseAsIn(now());
      return then;
    };

    /** Who writes, as a note says it: the address the caller speaks as, or niwa itself. */
    const authorOf = (caller: Caller): TurnAuthor => {
      const bound = bind(caller);
      if (bound !== undefined) return bound;
      if (caller.kind === "handler") return { kind: "niwa", by: String(caller.handler) };
      if (caller.kind === "host") return { kind: "niwa", by: "host" };
      throw new MemoryRefusal("unbound", "the caller is not bound to an address, so it reaches no memory");
    };

    /**
     * The memory a call reaches, and who makes it. An agent reaches its own; the owner and niwa itself
     * name the one they mean; any other address reaches none.
     */
    const reach = (ctx: ActionContext, named: MemoryName | undefined): { memory: MemoryName; by: TurnAuthor } => {
      const by = authorOf(ctx.caller);
      if (by.kind === "agent") {
        if (named !== undefined && named !== by.id) {
          throw new MemoryRefusal("not-yours", `agent ${by.id} reaches only its own memory, not the memory of ${named}`);
        }
        return { memory: by.id as MemoryName, by };
      }
      if (by.kind !== "owner" && by.kind !== "niwa") {
        throw new MemoryRefusal("not-yours", `${by.kind} ${"id" in by ? by.id : ""} has no memory of its own and reaches no other`);
      }
      if (named === undefined) throw new MemoryRefusal("no-memory", "name the memory: the agent whose memory it is");
      return { memory: named, by };
    };

    const noteOf = (memories: Memories, memory: MemoryName, note: NoteId): NoteView => {
      const found = memories.note(memory, note);
      if (found === undefined) throw new MemoryRefusal("no-note", `the memory of ${memory} has no note ${note}`);
      return found;
    };
    const changeable = (memory: MemoryName, note: NoteId): NoteView => {
      const found = noteOf(now(), memory, note);
      if (found.status === "erased") throw new MemoryRefusal("erased", `the note ${note} was erased`);
      return found;
    };

    /**
     * What this operation wrote as its `n`-th record, when it is being made again after the record was written and
     * before its result was saved. The id of a record follows the operation, so the record is found by it: the repeat
     * answers from what was written, and does not plan again against a memory its own first run has changed.
     */
    const wrote = <T>(ctx: ActionContext, type: { readonly name: string; readonly schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } } }, n = 1): { data: T; seq: number } | undefined => {
      const stored = journal().get(recordId(`${ctx.operationId}/emit/${String(n)}`));
      const data = stored === undefined ? undefined : dataAs(stored, type);
      return stored === undefined || data === undefined ? undefined : { data, seq: Number(stored.seq) };
    };

    api.action(
      action(memoryNote, {
        // The id follows the operation: a call made again writes the same note once.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const { memory, by } = reach(ctx, input.memory);
          if (input.source.kind === "owner" && by.kind !== "owner") {
            throw new MemoryRefusal("not-owner", "only the owner gives a note the owner as its source: what someone else says of him is their word");
          }
          const written = wrote(ctx, NoteWritten);
          if (written !== undefined) return { memory: written.data.memory, note: written.data.note, corroborated: false };
          const joined = wrote(ctx, NoteCorroborated);
          if (joined !== undefined) return { memory: joined.data.memory, note: joined.data.note, corroborated: true };
          // The memory holds it already, in the same words: it gains a source, not a copy.
          const memories = now();
          const held = memories
            .notesOf(memory)
            .find((one) => holds(one) && one.about === input.about && one.project === input.project && same(one.text, input.text));
          if (held !== undefined) {
            if (!memories.counts(memory, held.note, sourceKey(input.source, by))) {
              await ctx.emit(NoteCorroborated, { memory, note: held.note, source: input.source, by });
            }
            return { memory, note: held.note, corroborated: true };
          }
          const note = noteIdOf(String(ctx.operationId));
          await ctx.emit(NoteWritten, {
            memory,
            note,
            text: input.text,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
            about: input.about,
            ...(input.project === undefined ? {} : { project: input.project }),
            source: input.source,
            by,
          });
          return { memory, note, corroborated: false };
        },
      }),
    );

    api.action(
      action(memoryGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          return noteOf(asOf(input.at), memory, input.note);
        },
      }),
    );

    api.action(
      action(memoryList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          const notes = asOf(input.at)
            .notesOf(memory)
            .filter(holds)
            .filter((note) => input.about === undefined || note.about === input.about)
            .filter((note) => holdsFor(note.project, input.project))
            .reverse()
            .slice(0, input.limit);
          return { memory, notes };
        },
      }),
    );

    api.action(
      action(memoryConfirm, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        run: async (input, ctx) => {
          if (bind(ctx.caller)?.kind !== "owner") throw new MemoryRefusal("not-owner", "only the owner confirms a note: a confirmation is his word");
          const found = changeable(input.memory, input.note);
          if (!found.confirmed) await ctx.emit(NoteConfirmed, { memory: input.memory, note: input.note, by: owner });
          return { note: input.note, confirmed: true };
        },
      }),
    );

    api.action(
      action(memoryCorrect, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const { memory, by } = reach(ctx, input.memory);
          const corrected = wrote(ctx, NoteCorrected);
          if (corrected !== undefined) return { note: input.note, revision: asOf(corrected.seq).note(memory, input.note)?.revision ?? 0 };
          const found = changeable(memory, input.note);
          await ctx.emit(NoteCorrected, { memory, note: input.note, text: input.text, ...(input.detail === undefined ? {} : { detail: input.detail }), by });
          return { note: input.note, revision: found.revision + 1 };
        },
      }),
    );

    api.action(
      action(memoryRetract, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        run: async (input, ctx) => {
          const { memory, by } = reach(ctx, input.memory);
          const found = changeable(memory, input.note);
          if (found.status === "live") await ctx.emit(NoteRetracted, { memory, note: input.note, ...(input.reason === undefined ? {} : { reason: input.reason }), by });
          return { note: input.note };
        },
      }),
    );

    api.action(
      action(memoryErase, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        destructive: true,
        run: async (input, ctx) => {
          const { memory, by } = reach(ctx, input.memory);
          const found = noteOf(now(), memory, input.note);
          if (found.status !== "erased") await ctx.emit(NoteErased, { memory, note: input.note, by });
          return { note: input.note };
        },
      }),
    );

    api.action(
      action(memoryPageWrite, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const { memory, by } = reach(ctx, input.memory);
          const done = wrote(ctx, PageWritten);
          if (done !== undefined) return { page: done.data.page, revision: done.data.revision };
          const current = now().page(memory, input.page)?.revision ?? 0;
          if (input.revision !== undefined && input.revision !== current) {
            throw new MemoryRefusal("stale-page", `the page ${input.page} is at revision ${String(current)}, not ${String(input.revision)}: read it again`);
          }
          const revision = current + 1;
          await ctx.emit(PageWritten, {
            memory,
            page: input.page,
            title: input.title,
            text: input.text,
            ...(input.project === undefined ? {} : { project: input.project }),
            revision,
            by,
          });
          return { page: input.page, revision };
        },
      }),
    );

    api.action(
      action(memoryPageGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          const found = asOf(input.at).page(memory, input.page);
          if (found === undefined) throw new MemoryRefusal("no-page", `the memory of ${memory} has no page ${input.page}`);
          return found;
        },
      }),
    );

    api.action(
      action(memoryPageList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          const pages = now()
            .pagesOf(memory)
            .filter((page) => holdsFor(page.project, input.project))
            .map(({ text: _text, ...summary }) => summary)
            .sort((a, b) => a.page.localeCompare(b.page));
          return { memory, pages };
        },
      }),
    );

    /** The latest digests, within the limit, with their texts read from the turns that told them. */
    const readDigests = (digests: readonly TakenDigest[]): ReadDigest[] =>
      digests.slice(-limits.sessions).flatMap((digest) => {
        const told = journal().get(recordId(digest.record));
        const parsed = told === undefined ? undefined : AgentTurnQueued.schema.safeParse(told.data);
        return parsed?.success === true ? [{ ...digest, text: parsed.data.text }] : [];
      });

    api.action(
      action(memorySearch, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          const memories = asOf(input.at);
          const found = rank(input.query, searchable(memories.notesOf(memory), memories.pagesOf(memory), readDigests(memories.digestsOf(memory)), input.project), input.limit);
          return { memory, hits: found.map(({ value, score }) => ({ ...value, score })) };
        },
      }),
    );

    /** Put a note in or out of the top layer by hand. */
    const place = async (ctx: ActionContext, named: MemoryName | undefined, note: NoteId, top: boolean) => {
      const { memory, by } = reach(ctx, named);
      const found = changeable(memory, note);
      if (found.status !== "live") throw new MemoryRefusal("no-note", `the note ${note} no longer holds`);
      if (found.top !== top || !found.pinned) await ctx.emit(top ? NoteLifted : NoteDropped, { memory, note, by });
      return { note, top };
    };

    api.action(
      action(memoryLift, { recovery: "repeat", effect: "record", world: "niwa", idempotent: true, run: (input, ctx) => place(ctx, input.memory, input.note, true) }),
    );
    api.action(
      action(memoryDrop, { recovery: "repeat", effect: "record", world: "niwa", idempotent: true, run: (input, ctx) => place(ctx, input.memory, input.note, false) }),
    );

    api.action(
      action(memoryTop, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          return { memory, ...topLayer(now().notesOf(memory), input.project, limits.top) };
        },
      }),
    );

    /** The directory the session attached to an agent last works in. */
    const attachedLast = (agent: string): string | undefined => {
      let cwd: string | undefined;
      for (const stored of journal().since(seq(0), [recordTypeName(AgentAttached.name)])) {
        const parsed = AgentAttached.schema.safeParse(stored.data);
        if (parsed.success && parsed.data.agent === agent) cwd = parsed.data.cwd;
      }
      return directoryOf(cwd);
    };

    /**
     * The directory a session was attached to an agent in when the record at `before` was written: its latest
     * attachment up to there, none when it was attached to another agent since, or let go of.
     */
    const attachedAt = (agent: string, session: string, before: number): string | undefined => {
      let attached: { agent: string; cwd: string } | undefined;
      for (const stored of journal().since(seq(0), [recordTypeName(AgentAttached.name), recordTypeName(AgentDetached.name)])) {
        if (Number(stored.seq) >= before) break;
        const was = dataAs(stored, AgentAttached);
        if (was !== undefined && was.session === session) attached = { agent: was.agent, cwd: was.cwd };
        const gone = dataAs(stored, AgentDetached);
        if (gone !== undefined && gone.session === session && gone.agent === attached?.agent) attached = undefined;
      }
      return attached?.agent === agent ? directoryOf(attached.cwd) : undefined;
    };

    // The digests of attached sessions reach the memory of their agent: where the digest is, not a copy.
    api.on(SessionDigestTaken, { id: "digest-intake", from: "start" }, async (turn, step, told) => {
      if (turn.source?.kind !== "session-digest") return;
      const project = attachedAt(turn.agent, turn.source.session, Number(told.seq));
      await step.emit(
        DigestTaken,
        {
          memory: turn.agent,
          turn: turn.turn,
          record: String(told.id),
          session: turn.source.session,
          ...(turn.source.from === undefined ? {} : { from: turn.source.from }),
          upto: turn.source.upto,
          ...(project === undefined ? {} : { project }),
        },
        { key: "taken" },
      );
      // Enough has changed in the memory since it was last consolidated: it consolidates now.
      if (now().changesOf(turn.agent) >= limits.consolidateEvery) await step(memoryConsolidate, { memory: turn.agent }, { key: "consolidate" });
    });

    api.offer(AGENT_BRIEFING, { title: "What it remembers", action: memoryBrief.name });
    api.action(
      action(memoryBrief, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input, ctx) => {
          const { memory } = reach(ctx, input.agent);
          // The project the agent is bound to; without one, where the session attached to it last works.
          const got = await ctx.step.outcome(agentGet, { agent: input.agent });
          const project = directoryOf(got.status === "completed" ? got.value.definition.project?.cwd : undefined) ?? attachedLast(input.agent);
          return { text: topLayer(now().notesOf(memory), project, limits.top).text };
        },
      }),
    );

    api.action(
      action(memoryConsolidate, {
        // A consolidation made again finds its work done: it is planned from the memory as it stands.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const { memory } = reach(ctx, input.memory);
          const recorded = wrote(ctx, Consolidated);
          if (recorded !== undefined) return recorded.data;
          const memories = now();
          const done = consolidate(memories.notesOf(memory), limits, clock(), (note, merged) =>
            memories.sourcesWith(memory, note.note, merged.map((one) => one.note)),
          );
          await ctx.emit(Consolidated, { memory, ...done });
          return { memory, ...done };
        },
      }),
    );

    /** Whom a context request is for: the address the caller speaks as, or the one a handler names. */
    const addresseeOf = (ctx: ActionContext, named: Address | undefined): Address => {
      const bound = bind(ctx.caller);
      if (bound !== undefined) {
        if (named !== undefined && stableJson(named) !== stableJson(bound)) {
          throw new MemoryRefusal("not-yours", `${addressText(bound)} asks for itself: a caller bound to an address names no other addressee`);
        }
        return bound;
      }
      if (ctx.caller.kind === "client") throw new MemoryRefusal("unbound", "the caller is not bound to an address, so it is told nothing");
      if (named === undefined) throw new MemoryRefusal("no-addressee", "name the addressee: whom the context is for");
      return named;
    };

    api.action(
      action(memoryContext, {
        // It reads, and may write that a note about the owner is wanted: written once for each note and address.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const reader = addresseeOf(ctx, input.for);
          const home = reader.kind === "owner" || (reader.kind === "agent" && reader.id === input.memory);
          // What the addressee works on is awaited first. From here to the answer nothing waits: the memory is
          // read once, at one position, and every choice below is made of that one reading.
          let project: string | undefined;
          if (!home && reader.kind === "agent") {
            const got = await ctx.step.outcome(agentGet, { agent: reader.id });
            project = directoryOf(got.status === "completed" ? got.value.definition.project?.cwd : undefined);
          }
          const at = input.at ?? Number(journal().last());
          const memories = asOf(at);
          const who: Reader = home ? { kind: "home" } : { kind: "other", ...(project === undefined ? {} : { project }) };
          const holding = memories.notesOf(input.memory).filter((note) => holds(note) && holdsFor(note.project, input.project));
          const stands = holding.map((note) => ({ note, standing: standing(note, who, memories.share(input.memory, note.note, note.revision, reader, input.purpose)) }));
          // What backs a note is searched only for its own readers: a match on it would tell of it.
          const readable = stands.filter((one) => one.standing === "told").map(({ note }) => ({ text: home ? `${note.text}\n${note.detail ?? ""}` : note.text, value: note }));
          const items = rank(input.query, readable, input.limit).map(({ value }) => conclusion(value, who));
          // The notes about the owner that match are ranked apart: they do not use up the room of what may be told.
          const aboutOwner = stands.filter((one) => one.standing === "private").map(({ note }) => ({ text: note.text, value: note }));
          const matched = rank(input.query, aboutOwner, input.limit).map(({ value }) => value);
          const withheld: Withheld[] = [];
          const asks: NoteView[] = [];
          // An answer read again at its position asks nobody: it says only whether the owner had been asked.
          const asking = input.at === undefined;
          for (const note of matched) {
            const share = memories.share(input.memory, note.note, note.revision, reader, input.purpose);
            const status = share === "refused" ? "refused" : share === "asked" || (share === undefined && asking) ? "asked" : "not-asked";
            withheld.push({ note: note.note, reason: "about-the-owner", status });
            if (share === undefined && asking) asks.push(note);
          }
          // Made again after a cut, it writes what it wrote before, in the same order, and then what is still to ask.
          const before: Array<z.output<typeof ShareWanted.schema>> = [];
          for (let n = 1, again = wrote(ctx, ShareWanted, n); again !== undefined; again = wrote(ctx, ShareWanted, ++n)) before.push(again.data);
          for (const wanted of before) await ctx.emit(ShareWanted, wanted);
          for (const note of asks) {
            if (before.some((wanted) => wanted.note === note.note && wanted.revision === note.revision)) continue;
            await ctx.emit(ShareWanted, { memory: input.memory, note: note.note, revision: note.revision, for: reader, purpose: input.purpose });
          }
          // A note erased while the answer was being written is not told.
          const erased = now();
          return { memory: agentAddress(input.memory), for: reader, at, items: items.filter((item) => erased.note(input.memory, item.note)?.status !== "erased"), withheld };
        },
      }),
    );

    api.action(
      action(memoryShare, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        run: async (input, ctx) => {
          if (bind(ctx.caller)?.kind !== "owner") throw new MemoryRefusal("not-owner", "only the owner says whether a note about him may leave");
          const found = changeable(input.memory, input.note);
          await ctx.emit(ShareAnswered, { memory: input.memory, note: input.note, revision: found.revision, for: input.for, ...(input.purpose === undefined ? {} : { purpose: input.purpose }), allowed: input.allowed });
          return { note: input.note, allowed: input.allowed };
        },
      }),
    );

    /** Whether the answer of a request is the owner's own: given by him, not found for him by a resolver. */
    const ownersOwn = (request: string): boolean =>
      journal()
        .since(seq(0), [recordTypeName(RequestAnswered.name)])
        .some((stored) => {
          const parsed = RequestAnswered.schema.safeParse(stored.data);
          return parsed.success && parsed.data.id === request && parsed.data.by?.kind === "owner" && parsed.data.how === undefined;
        });

    // A note about the owner that is wanted is asked of him, once for each revision and address; the
    // asks wait apart, so one he leaves open holds up no other.
    api.on(ShareWanted, { id: "share-ask", concurrency: Number.POSITIVE_INFINITY }, async (wanted, step) => {
      const note = now().note(wanted.memory, wanted.note);
      // Changed since it was wanted: the next request asks for it as it is then.
      if (note === undefined || note.status !== "live" || note.revision !== wanted.revision) return;
      const asked = await step.outcome(requestAsk, {
        to: owner,
        question: SHARE_QUESTION_NAME,
        from: agentAddress(wanted.memory),
        input: {
          kind: "confirm",
          title: `May ${addressText(wanted.for)} be told what ${addressText(agentAddress(wanted.memory))} remembers about you?`,
          // The note itself is not in the question: whoever reads the open requests would read it. The owner's page
          // reads the note by its reference, and shows it only while it holds as it was when he was asked.
          detail: shareDetail({ memory: wanted.memory, note: wanted.note, revision: wanted.revision }, wanted.purpose),
          options: confirmOptions(),
        },
      });
      const decided = { memory: wanted.memory, note: wanted.note, revision: wanted.revision, for: wanted.for, purpose: wanted.purpose };
      if (asked.status !== "completed" || !("answer" in asked.value)) {
        await step.emit(ShareAnswered, { ...decided, allowed: false, reason: "unanswered" }, { key: "answered" });
        return;
      }
      const { id, answer } = asked.value;
      const his = ownersOwn(id);
      await step.emit(
        ShareAnswered,
        { ...decided, allowed: his && isYes(answer), request: id, ...(his ? {} : { reason: "not-the-owner" as const }) },
        { key: "answered" },
      );
    });

    // A question about a note that no longer holds as it was asked is closed: the owner is not left to answer for
    // a text he can no longer be shown, nor for one that was erased.
    const closeStale = (id: string) => async (changed: { memory: MemoryName; note: NoteId }, step: Step) => {
      const note = now().note(changed.memory, changed.note);
      for (const stored of journal().since(seq(0), [recordTypeName(ShareWanted.name)])) {
        const wanted = dataAs(stored, ShareWanted);
        if (wanted === undefined || wanted.memory !== changed.memory || wanted.note !== changed.note) continue;
        if (note !== undefined && note.status === "live" && note.revision === wanted.revision) continue;
        const key = `${id}-${String(stored.seq)}`;
        const found = await step.outcome(requestFind, { cause: String(stored.id), question: SHARE_QUESTION_NAME }, { key: `find:${key}` });
        if (found.status !== "completed" || found.value.id === undefined) continue;
        const asked = await step.outcome(requestGet, { id: found.value.id }, { key: `get:${key}` });
        if (asked.status !== "completed" || asked.value.status !== "open") continue;
        await step.outcome(requestCancel, { id: found.value.id, by: agentAddress(changed.memory), reason: "the note changed since it was asked" }, { key: `cancel:${key}` });
      }
    };
    api.on(NoteErased, { id: "share-close-erased" }, closeStale("erased"));
    api.on(NoteCorrected, { id: "share-close-corrected" }, closeStale("corrected"));
    api.on(NoteRetracted, { id: "share-close-retracted" }, closeStale("retracted"));

    api.summarize(() => {
      const memories = api.journal?.() === undefined ? undefined : now();
      return { notes: memories === undefined ? 0 : memories.count() };
    });
  });
}
