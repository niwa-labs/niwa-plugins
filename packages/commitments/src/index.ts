/**
 * The commitments plugin: promises with a deadline, delivered to an agent's inbox when they come due,
 * and done, missed or cancelled.
 *
 * Nothing is kept in memory: where a commitment stands is folded from the journal on every read. A
 * handler decides as of the record that woke it, so a replay decides the same. The deadline is a
 * sleep of the timers, asked through their action; the inbox is the agents plugin's, reached through
 * `agent.notify`.
 */

import {
  DeniedError,
  EntityDescription,
  IdIndex,
  UnknownId,
  action,
  confirmOptions,
  isYes,
  recordId,
  seq,
  stableJson,
} from "@niwa-labs/core";
import type { ActionContext, Address, JournalReader, RecordId, Seq, Step, StoredRecord } from "@niwa-labs/core";
import { AGENT_BRIEFING, agentNotify } from "@niwa-labs/agent/records";
import { COCKPIT_MODULE, bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, MessagesOptions, Plugin } from "@niwa-labs/plugin";
import { REQUEST_TYPES, RequestCancelled, RequestCreated, RequestExpired, fold as foldRequest, requestAsk, requestCancel } from "@niwa-labs/requests/records";
import { TimerSlept, timerSleepRequest } from "@niwa-labs/timer/records";
import { fileURLToPath } from "node:url";

import type { z } from "zod";

import {
  COMMITMENT_TYPES,
  CONFIRM_QUESTION,
  CommitmentCancelled,
  CommitmentDeclined,
  CommitmentDelivered,
  CommitmentKept,
  CommitmentMade,
  CommitmentMissed,
  CommitmentProposed,
  ENDED,
  MAX_MOMENT,
  commitmentBriefing,
  commitmentCancel,
  commitmentDone,
  commitmentGet,
  commitmentList,
  commitmentMake,
} from "./records.ts";
import type { CommitmentBasis, CommitmentEntity, CommitmentId, CommitmentStatus } from "./records.ts";

export * from "./records.ts";

/** The grace after a deadline before an open commitment is missed, by default: an hour. */
export const DEFAULT_GRACE_MS = 3_600_000;

export interface CommitmentsOptions {
  /** What address a caller speaks as: the same binding the messages module uses. */
  readonly messages?: MessagesOptions;
  /** How long after its deadline a commitment that is not done is missed. */
  readonly graceMs?: number;
}

/** A commitment was asked to do what its status does not allow: it ended, or it is still proposed. */
export class CommitmentClosed extends Error {
  override name = "CommitmentClosed";
  readonly code = "CommitmentClosed";
  constructor(
    readonly id: CommitmentId,
    readonly status: CommitmentStatus,
  ) {
    super(`the commitment "${id}" is ${status}`);
  }
}

type Terms = z.infer<typeof CommitmentProposed.schema>;

/** One commitment as the journal says it stands. */
interface Folded {
  terms: Terms;
  status: CommitmentStatus;
  basis?: CommitmentBasis;
  /** The record it was proposed in: the cause of the question put to the owner. */
  proposal?: RecordId;
  endedBy?: Address;
  note?: string;
}

/**
 * Where each commitment stands, from its records in the order they were written.
 *
 * An ended commitment stays as it ended: an answer of the owner that comes after a proposal was
 * cancelled, or a wake after it was done, changes nothing.
 */
function fold(rows: readonly StoredRecord[]): Map<string, Folded> {
  const all = new Map<string, Folded>();
  for (const row of rows) {
    if (row.type === CommitmentProposed.name) {
      const terms = CommitmentProposed.schema.parse(row.data);
      all.set(terms.id, { terms, status: "proposed", proposal: row.id });
      continue;
    }
    if (row.type === CommitmentMade.name) {
      const { basis, ...terms } = CommitmentMade.schema.parse(row.data);
      const known = all.get(terms.id);
      if (known === undefined) all.set(terms.id, { terms, status: "open", basis });
      else if (known.status === "proposed") Object.assign(known, { terms, status: "open", basis });
      continue;
    }
    const id = (row.data as { id?: string }).id;
    const known = id === undefined ? undefined : all.get(id);
    if (known === undefined) continue;
    if (row.type === CommitmentDelivered.name && known.status === "open") known.status = "due";
    else if (row.type === CommitmentMissed.name && (known.status === "due" || known.status === "open")) known.status = "missed";
    else if (row.type === CommitmentDeclined.name && known.status === "proposed") known.status = "declined";
    else if (row.type === CommitmentKept.name && (known.status === "open" || known.status === "due" || known.status === "missed")) {
      const kept = CommitmentKept.schema.parse(row.data);
      Object.assign(known, { status: known.status === "missed" ? "kept-late" : "kept", endedBy: kept.by, note: kept.note });
    } else if (row.type === CommitmentCancelled.name && !ENDED.includes(known.status)) {
      const cancelled = CommitmentCancelled.schema.parse(row.data);
      Object.assign(known, { status: "cancelled", endedBy: cancelled.by, note: cancelled.reason });
    }
  }
  return all;
}

function mayCancel(one: Folded, by: Address | undefined): boolean {
  return by !== undefined && !ENDED.includes(one.status) && (same(by, OWNER) ||
    (same(by, one.terms.by) && (one.terms.party === "self" || one.status === "proposed")));
}

/** The records of commitments, up to a position when one is given. */
function rowsOf(journal: JournalReader | undefined, upto?: Seq): StoredRecord[] {
  const rows = journal?.since(seq(0), COMMITMENT_TYPES.map((type) => type.name)) ?? [];
  return upto === undefined ? rows : rows.filter((row) => row.seq <= upto);
}

/** The record an action writes first: the one a commitment is born in, and the seed of its id. */
function birthOf(ctx: ActionContext): RecordId {
  return recordId(`${ctx.operationId}/emit/1`);
}

/** A description a person reads in a list, made from the text when none was given. */
function describe(text: string): EntityDescription {
  const line = (text.split("\n")[0] ?? "").trim();
  const short = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  return EntityDescription.parse(short.length >= 3 ? short : "Commitment");
}

/** Whether two addresses are the same. */
function same(a: Address | undefined, b: Address | undefined): boolean {
  return a !== undefined && b !== undefined && stableJson(a) === stableJson(b);
}

const OWNER: Address = { kind: "owner" };

/** The key of a sleep of a commitment: its deadline, or the end of the grace after it. */
function sleepKeyOf(id: string, which: "due" | "grace"): string {
  return `commitment:${id}:${which}`;
}
const SLEEP_KEY = /^commitment:(com-[0-9a-f]+):(due|grace)$/;

/** What a record says in words, and who it says wrote them, by the shape of the record that holds them. */
function wordsOf(row: StoredRecord | undefined): { text: string; author: { kind?: unknown } | undefined } | undefined {
  const data = row?.data as
    | { text?: unknown; body?: { text?: unknown }; from?: { kind?: unknown }; author?: { kind?: unknown } }
    | null
    | undefined;
  if (data === null || data === undefined || typeof data !== "object") return undefined;
  // A message, sent or received, holds its words in its body and its sender in `from`; a turn or a
  // sentence a plugin relays holds them in `text`, with the author it names.
  const text = typeof data.body?.text === "string" ? data.body.text : data.text;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  return { text, author: typeof data.body?.text === "string" ? data.from : (data.author ?? data.from) };
}

/**
 * The owner's own words in a record, or nothing when it is not his: it has words, and he wrote it, or
 * the plugin that wrote it says he is its author. What a client wrote names its author by the client
 * alone: a client that may write a record could write any author into it.
 */
function ownersWords(row: StoredRecord | undefined): string | undefined {
  const words = wordsOf(row);
  if (row === undefined || words === undefined) return undefined;
  if (row.actor.kind === "client") return row.actor.principal?.kind === "owner" && (words.author === undefined || words.author.kind === "owner") ? words.text : undefined;
  return words.author?.kind === "owner" ? words.text : undefined;
}

/** A text as it is compared when one is said to quote another: no case, one space between words, no closing mark. */
function plain(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?,;:]+$/, "").trim();
}

/** When a moment is, as a person reads it. */
function when(at: number): string {
  return new Date(at).toISOString().replace(/:\d\d\.\d{3}Z$/, "Z");
}

/** The commitments plugin. */
export function commitments(opts: CommitmentsOptions = {}): Plugin {
  const bind: CallerBinding = bindingOf(opts.messages);
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) throw new RangeError(`graceMs is a number of milliseconds, not negative: ${String(grace)}`);
  return plugin("commitments", (api) => {
    api.declare(...COMMITMENT_TYPES);
    // The cards of the commitments in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "commitments", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });
    const journal = () => api.journal?.();
    const ids = new IdIndex("commitment", () =>
      rowsOf(journal())
        .filter((row) => row.type === CommitmentProposed.name || (row.type === CommitmentMade.name && (row.data as { basis: CommitmentBasis }).basis.kind !== "owner-confirmed"))
        .map((row) => ({ id: (row.data as { id: string }).id, seed: String(row.id) })),
    );
    const current = () => fold(rowsOf(journal()));
    const require = (text: string): Folded & { id: CommitmentId } => {
      const id = ids.require(text);
      const found = current().get(id);
      if (found === undefined) throw new UnknownId(text, "commitment");
      return { ...found, id };
    };
    /** Whether this very operation already wrote the record that ends the commitment: a call made again after it was cut off. */
    const wrote = (ctx: ActionContext, type: typeof CommitmentKept | typeof CommitmentCancelled, id: CommitmentId): boolean => {
      const born = journal()?.get(birthOf(ctx));
      return born !== undefined && born.type === type.name && (born.data as { id?: string }).id === id;
    };
    const speaker = (ctx: ActionContext): Address => {
      const address = bind(ctx.caller);
      if (address === undefined) throw new DeniedError("a commitment is made and ended by someone who speaks as an address; this caller speaks as none");
      return address;
    };

    api.action(
      action(commitmentMake, {
        recovery: "do-not-repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const by = speaker(ctx);
          if (input.due !== undefined && input.due + grace > MAX_MOMENT) {
            throw new RangeError(`the deadline ${input.due} and the grace after it reach past the last moment a date holds`);
          }
          const terms: Terms = {
            id: ids.issue(birthOf(ctx)),
            text: input.text,
            description: input.description ?? describe(input.text),
            by,
            to: input.to,
            party: input.party,
            ...(input.due === undefined ? {} : { due: input.due }),
          };
          let basis: CommitmentBasis | undefined;
          if (same(by, OWNER)) basis = { kind: "owner" };
          else if (input.party === "self") basis = { kind: "own" };
          else if (input.basis !== undefined) {
            const said = ownersWords(journal()?.get(recordId(input.basis.record)));
            if (said === undefined) {
              throw new DeniedError(`"${input.basis.record}" is not a record of the owner's words: a promise for the owner stands only on his word`);
            }
            // His words carry the promise as he worded it. What an agent rewords, or a deadline it
            // reads into them, is its own: it stands once he confirms the terms as they are now.
            if (input.due === undefined && plain(said).includes(plain(input.text))) basis = input.basis;
          }
          if (basis === undefined) {
            await ctx.emit(CommitmentProposed, terms);
            return { id: terms.id, status: "proposed" as const };
          }
          await ctx.emit(CommitmentMade, { ...terms, basis });
          return { id: terms.id, status: "open" as const };
        },
      }),
    );

    api.action(
      action(commitmentDone, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const found = require(input.id);
          // Made again under the operation that already did it, it answers as it did.
          if (wrote(ctx, CommitmentKept, found.id)) return { id: found.id, status: found.status };
          if (found.status !== "open" && found.status !== "due" && found.status !== "missed") throw new CommitmentClosed(found.id, found.status);
          const by = speaker(ctx);
          if (!same(by, OWNER) && !same(by, found.terms.by)) throw new DeniedError("only the one who made a commitment, or the owner, may say it is done");
          await ctx.emit(CommitmentKept, { id: found.id, basedOn: found.status, by, ...(input.note === undefined ? {} : { note: input.note }) });
          return { id: found.id, status: found.status === "missed" ? "kept-late" as const : "kept" as const };
        },
      }),
    );

    api.action(
      action(commitmentCancel, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const found = require(input.id);
          if (wrote(ctx, CommitmentCancelled, found.id)) return { id: found.id, status: "cancelled" as const };
          if (found.status !== "open" && found.status !== "due" && found.status !== "proposed") throw new CommitmentClosed(found.id, found.status);
          const by = speaker(ctx);
          if (!mayCancel(found, by)) {
            throw new DeniedError(
              found.terms.party === "owner"
                ? "only the owner may cancel a commitment made for him"
                : "only the one who made a commitment, or the owner, may cancel it",
            );
          }
          await ctx.emit(CommitmentCancelled, { id: found.id, basedOn: found.status, by, ...(input.reason === undefined ? {} : { reason: input.reason }) });
          return { id: found.id, status: "cancelled" as const };
        },
      }),
    );

    const entityOf = (found: Folded): CommitmentEntity => ({
      ...found.terms,
      id: found.terms.id,
      status: found.status,
      ...(found.basis === undefined ? {} : { basis: found.basis }),
      ...(found.endedBy === undefined ? {} : { endedBy: found.endedBy }),
      ...(found.note === undefined ? {} : { note: found.note }),
    });

    api.action(
      action(commitmentList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input, ctx) => ({
          items: [...current().values()]
            .filter((one) => (input.status === undefined || one.status === input.status) && (input.to === undefined || one.terms.to === input.to))
            .map((one) => ({
              id: one.terms.id,
              description: one.terms.description,
              by: one.terms.by,
              canCancel: mayCancel(one, bind(ctx.caller)),
              status: one.status,
              party: one.terms.party,
              to: one.terms.to,
              ...(one.terms.due === undefined ? {} : { due: one.terms.due }),
            })),
        }),
      }),
    );

    api.action(
      action(commitmentGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const found = require(input.id);
          return entityOf(found);
        },
      }),
    );

    // The section of an agent's briefing: what it is to deliver and what it promised, not yet ended.
    api.offer(AGENT_BRIEFING, { title: "Commitments", action: commitmentBriefing.name });
    api.action(
      action(commitmentBriefing, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async ({ agent }) => {
          const self: Address = { kind: "agent", id: agent };
          const lines = [...current().values()]
            .filter((one) => !ENDED.includes(one.status) && (one.terms.to === agent || same(one.terms.by, self)))
            .map((one) => `${one.terms.id}  ${one.status}  ${one.terms.due === undefined ? "no deadline" : `due ${when(one.terms.due)}`}  ${one.terms.description}`);
          return { text: lines.join("\n") };
        },
      }),
    );

    /** Whether a proposal still waits for the owner, as the journal says now: an answer to one that ended decides nothing. */
    const stillProposed = (id: CommitmentId): boolean => current().get(id)?.status === "proposed";
    // A proposal is put to the owner. The asks wait side by side: one he leaves open holds no other.
    api.on(CommitmentProposed, { id: "commitment-confirm", concurrency: Infinity }, async (terms, step) => {
      const due = terms.due === undefined ? "" : ` by ${when(terms.due)}`;
      try {
        const asked = await step(requestAsk, {
          to: OWNER,
          answerPolicy: "owner-only",
          question: CONFIRM_QUESTION,
          input: {
            kind: "confirm",
            title: `Promise for you${due}: ${terms.text}`,
            detail: `Proposed by ${terms.by.kind === "agent" ? `agent ${terms.by.id}` : terms.by.kind} as ${terms.id}. It stands only if you confirm it.`,
            options: confirmOptions(),
            allowOther: false,
          },
          from: terms.by,
        });
        if (!("answer" in asked)) return;
        // The owner's confirmation is his own answer: a resolver that found one for him did not ask him.
        if (!stillProposed(terms.id)) return;
        if (isYes(asked.answer)) await step.emit(CommitmentMade, { ...terms, basis: { kind: "owner-confirmed", request: asked.id } });
        else await step.emit(CommitmentDeclined, { id: terms.id, request: asked.id });
      } catch (error) {
        if (!(error instanceof RequestCancelled) && !(error instanceof RequestExpired)) throw error;
        // A proposal its author withdrew is not one the owner refused.
        if (stillProposed(terms.id)) await step.emit(CommitmentDeclined, { id: terms.id, request: error.request });
      }
    });

    /** The question that confirms a proposal, when it was asked before `at` and is still open then. */
    const openConfirmation = (proposal: RecordId, at: Seq): z.infer<typeof RequestCreated.schema> | undefined => {
      const reader = journal();
      const asked = reader?.since(seq(0), [RequestCreated.name]).find((row) => row.seq <= at && row.cause === proposal);
      if (reader === undefined || asked === undefined) return undefined;
      const created = RequestCreated.schema.parse(asked.data);
      const ended = reader.since(asked.seq, REQUEST_TYPES.map((type) => type.name)).filter((row) => row.seq <= at && (row.data as { id?: string }).id === created.id);
      return foldRequest([asked, ...ended], bind).get(created.id)?.status === "open" ? created : undefined;
    };
    const withdraw = async (step: Step, request: z.infer<typeof RequestCreated.schema>, by: Address) => {
      await step.outcome(requestCancel, { id: request.id, reason: "the proposed commitment was cancelled", by });
    };

    // A cancelled proposal takes its question with it, whether it was asked before the cancel ...
    api.on(CommitmentCancelled, { id: "commitment-withdraw" }, async (data, step, at) => {
      const found = fold(rowsOf(journal(), at.seq)).get(data.id);
      if (found?.proposal === undefined || found.basis !== undefined) return;
      const open = openConfirmation(found.proposal, at.seq);
      if (open !== undefined) await withdraw(step, open, found.terms.by);
    });
    // ... or asked after it.
    api.on(RequestCreated, { id: "commitment-withdraw-late", filter: { question: CONFIRM_QUESTION } }, async (created, step, at) => {
      if (at.cause === null) return;
      const proposal = journal()?.get(at.cause);
      if (proposal?.type !== CommitmentProposed.name) return;
      const found = fold(rowsOf(journal(), at.seq)).get(CommitmentProposed.schema.parse(proposal.data).id);
      if (found?.status === "cancelled") await withdraw(step, created, found.terms.by);
    });

    // A commitment with a deadline sleeps until it.
    api.on(CommitmentMade, { id: "commitment-due" }, async (made, step) => {
      if (made.due === undefined) return;
      await step(timerSleepRequest, { at: made.due, key: sleepKeyOf(made.id, "due") });
    });

    // At the deadline an open commitment is told to its agent; after the grace one that is not done is
    // missed, delivered or not. Each is decided as of its own wake, so the wakes run side by side, and
    // an inbox that cannot be reached is a failed outcome that stops no other wake: the commitment
    // is not delivered, and the grace still ends it.
    api.on(TimerSlept, { id: "commitment-wake", requires: [TimerSlept], concurrency: Infinity }, async (wake, step, at) => {
      const matched = SLEEP_KEY.exec(wake.key);
      if (matched === null) return;
      const [, id, which] = matched;
      const found = id === undefined ? undefined : fold(rowsOf(journal(), at.seq)).get(id);
      const due = found?.terms.due;
      if (id === undefined || found === undefined || due === undefined) return;
      // Done or cancelled after the wake was recorded, before this ran: that came first, and nothing
      // the wake would say is true any more.
      const outrun = (): boolean => {
        const status = current().get(id)?.status;
        return status === "kept" || status === "cancelled";
      };
      if (which === "due" && found.status === "open") {
        if (outrun()) return;
        const told = await step.outcome(agentNotify, { agent: found.terms.to, text: `Commitment ${found.terms.id} is due now: ${found.terms.text}` });
        if (outrun()) return;
        if (told.status === "completed") await step.emit(CommitmentDelivered, { id: found.terms.id, due, at: at.at });
        await step(timerSleepRequest, { at: due + grace, key: sleepKeyOf(found.terms.id, "grace") });
      } else if (which === "grace" && (found.status === "due" || found.status === "open")) {
        if (outrun()) return;
        await step.emit(CommitmentMissed, { id: found.terms.id, due, at: at.at });
        await step.outcome(agentNotify, { agent: found.terms.to, text: `Commitment ${found.terms.id} was missed: ${found.terms.text}` });
      }
    });

    api.summarize(() => {
      const counts: Record<string, number> = {};
      for (const one of current().values()) counts[one.status] = (counts[one.status] ?? 0) + 1;
      return counts;
    });
  });
}
