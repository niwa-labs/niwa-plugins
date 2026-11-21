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

import { action, owner, recordId, recordTypeName, seq } from "@niwa-labs/core";
import type { ActionContext, Address, Caller, JournalReader } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AgentAttached, AgentTurnQueued, SessionDigestTaken, agentGet } from "@niwa-labs/agent/records";
import type { TurnAuthor } from "@niwa-labs/agent/records";

import { Memories } from "./fold.ts";
import type { TakenDigest } from "./fold.ts";
import {
  MEMORY_TYPES,
  DigestTaken,
  NoteConfirmed,
  NoteCorrected,
  NoteDropped,
  NoteErased,
  NoteLifted,
  NoteRetracted,
  NoteWritten,
  PageWritten,
  memoryBrief,
  memoryConfirm,
  memoryCorrect,
  memoryDrop,
  memoryErase,
  memoryGet,
  memoryLift,
  memoryList,
  memoryNote,
  memoryPageGet,
  memoryPageWrite,
  memoryRetract,
  memorySearch,
  memoryTop,
} from "./records.ts";
import type { MemoryName, NoteId, NoteView, PageView, SearchHit } from "./records.ts";
import { holds, holdsFor } from "./holds.ts";
import { rank } from "./search.ts";
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

/** How much a memory holds and shows. */
export interface MemoryLimits {
  /** The most characters the top layer of a memory shows, headings included. Default 4000, about a thousand tokens. */
  readonly top: number;
  /** How many of the latest digests of sessions a search reads. Default 200. */
  readonly sessions: number;
}

export const DEFAULT_LIMITS: MemoryLimits = { top: 4_000, sessions: 200 };

/** A refusal of the memory module: a memory the caller may not reach, a note it may not change. */
export class MemoryRefusal extends Error {
  override name = "MemoryRefusal";
  constructor(
    readonly code: "not-yours" | "no-memory" | "not-owner" | "no-note" | "no-page" | "stale-page" | "erased" | "unbound",
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

/** The memory module. */
export function memory(options: MemoryOptions = {}): Plugin {
  const bind = options.bind ?? ownerOnly;
  const limits: MemoryLimits = { ...DEFAULT_LIMITS, ...options.limits };

  return plugin("memory", (api) => {
    api.declare(...MEMORY_TYPES);

    const journal = (): JournalReader => {
      const reader = api.journal?.();
      if (reader === undefined) throw new Error("the memory is read from the journal, and the host is not serving it");
      return reader;
    };
    const types = Memories.TYPES.map((name) => recordTypeName(name));

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
          return { memory, note };
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
          const notes = now()
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

    /** The directory the session attached to an agent last works in; with `session`, the directory of that session. */
    const attachedLast = (agent: string, session?: string): string | undefined => {
      let cwd: string | undefined;
      for (const stored of journal().since(seq(0), [recordTypeName(AgentAttached.name)])) {
        const parsed = AgentAttached.schema.safeParse(stored.data);
        if (parsed.success && parsed.data.agent === agent && (session === undefined || parsed.data.session === session)) cwd = parsed.data.cwd;
      }
      return cwd;
    };

    // The digests of attached sessions reach the memory of their agent: where the digest is, not a copy.
    api.on(SessionDigestTaken, { id: "digest-intake", from: "start" }, async (turn, step, told) => {
      if (turn.source?.kind !== "session-digest") return;
      const project = attachedLast(turn.agent, turn.source.session);
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
          const project = (got.status === "completed" ? got.value.definition.project?.cwd : undefined) ?? attachedLast(input.agent);
          return { text: topLayer(now().notesOf(memory), project, limits.top).text };
        },
      }),
    );

    api.summarize(() => {
      const memories = api.journal?.() === undefined ? undefined : now();
      return { notes: memories === undefined ? 0 : memories.count() };
    });
  });
}
