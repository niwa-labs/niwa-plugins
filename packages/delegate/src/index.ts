/**
 * The delegate plugin: it answers for the owner the requests put to one agent.
 *
 * A request addressed to the agent is answered from the owner's decision about the same question in
 * the same area, when one stands. A request of an area that has a judge goes to the judge, with the
 * context the data owners give for it. The agent, or anyone a grant lets decide the area, may decide
 * it within that bound. What is left goes to the owner, and his answer is his decision from then on.
 * Whatever was passed on for a request is withdrawn when the request is over without it.
 *
 * Nothing is kept in memory: decisions are folded from the journal. A handler reads the journal as
 * of the record that woke it, so a replay decides the same.
 */

import {
  DeniedError,
  EntityDescription,
  IdIndex,
  UnknownId,
  action,
  issueId,
  recordId,
  seq,
  stableJson,
  timestamp,
} from "@niwa-labs/core";
import type { Address, Answer, JournalReader, Question, Seq, Step, StoredRecord } from "@niwa-labs/core";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, MessagesOptions, Plugin } from "@niwa-labs/plugin";
import {
  REQUEST_TYPES,
  RequestAnswered,
  RequestCancelled,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpired,
  RequestExpiredRecord,
  fold as foldRequests,
  requestAsk,
  requestCancel,
  requestResolve,
} from "@niwa-labs/requests/records";
import type { RequestId, RequestState } from "@niwa-labs/requests/records";
import type { z } from "zod";

import {
  DELEGATE_TYPES,
  DecisionMade,
  DecisionRevoked,
  RequestForwarded,
  contextSource,
  delegateDecide,
  delegateDecisionList,
  delegateRecall,
  delegateRevoke,
} from "./records.ts";
import type { ContextRequest, DecisionId, DecisionKind, SourceRef } from "./records.ts";

export * from "./records.ts";

export interface DelegateOptions {
  /** The agent the requests are addressed to: delegate answers what is put to it. */
  readonly agent: string;
  /** The judge of an area: the address a request of that area is passed to before the owner. */
  readonly judges?: Readonly<Record<string, Address>>;
  /**
   * The actions that answer a request for context (`contextSource`), asked before a request goes to
   * a judge. A memory serves one; delegate knows it only by name.
   */
  readonly context?: readonly string[];
  /** How long a judge has to answer before the request goes on to the owner. Default: an hour. */
  readonly judgeWaitMs?: number;
  /** What address a caller speaks as: the same binding the messages module uses. */
  readonly messages?: MessagesOptions;
}

/** How long a judge has to answer, by default. */
export const DEFAULT_JUDGE_WAIT_MS = 3_600_000;

type Created = z.infer<typeof RequestCreated.schema>;
type Decision = z.infer<typeof DecisionMade.schema>;

/** The key of a question: its name and what was asked, without the area. */
export function questionKey(question: string, input: Question): string {
  const { area: _area, ...rest } = input;
  return `${question}|${stableJson(rest)}`;
}

/** The decisions in the order they were made, each with whether it was revoked. */
function decisionsOf(rows: readonly StoredRecord[]): Array<{ decision: Decision; revoked: boolean }> {
  const revoked = new Set(rows.filter((row) => row.type === DecisionRevoked.name).map((row) => DecisionRevoked.schema.parse(row.data).decision));
  return rows
    .filter((row) => row.type === DecisionMade.name)
    .map((row) => {
      const decision = DecisionMade.schema.parse(row.data);
      return { decision, revoked: revoked.has(decision.id) };
    });
}

/**
 * The owner's decision that answers a question, when one stands: the last one made for the same key
 * in the same area and not revoked. A question without an area names no decision.
 */
export function recallOf(rows: readonly StoredRecord[], question: string, input: Question): Decision | undefined {
  const area = input.area;
  if (area === undefined) return undefined;
  const key = questionKey(question, input);
  return decisionsOf(rows)
    .filter((one) => !one.revoked && one.decision.kind === "owner" && one.decision.question === key && one.decision.area === area)
    .at(-1)?.decision;
}

/** A description a person reads in a list, from the title of a question. */
function describe(title: string): EntityDescription {
  const short = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
  return EntityDescription.parse(short.length >= 3 ? short : "Decision");
}

/** Whether two addresses are the same. */
function same(a: Address | undefined, b: Address | undefined): boolean {
  return a !== undefined && b !== undefined && stableJson(a) === stableJson(b);
}

/** The context the data owners gave, as lines a judge reads under the question. */
function withContext(detail: string | undefined, sources: readonly SourceRef[], withheld: number): string | undefined {
  if (sources.length === 0 && withheld === 0) return detail;
  const lines = sources.map((one) => {
    const owner = "id" in one.owner ? `${one.owner.kind} ${one.owner.id}` : one.owner.kind;
    return `- ${one.text} (${one.ref} of ${owner} at ${String(one.at)}${one.scope === undefined ? "" : `, ${one.scope}`})`;
  });
  if (withheld > 0) lines.push(`- ${String(withheld)} more not shown: they need the owner's leave.`);
  return [detail, "Context:", ...lines].filter((line) => line !== undefined).join("\n");
}

/** The delegate plugin. */
export function delegate(opts: DelegateOptions): Plugin {
  const self: Address = { kind: "agent", id: opts.agent };
  const judges = opts.judges ?? {};
  const judgeWait = opts.judgeWaitMs ?? DEFAULT_JUDGE_WAIT_MS;
  for (const [area, judge] of Object.entries(judges)) {
    if (same(judge, self)) throw new TypeError(`the judge of "${area}" is the agent delegate answers for: it would be asked its own question`);
  }
  const sources = (opts.context ?? []).map((name) => contextSource(name));
  const bind: CallerBinding = bindingOf(opts.messages);

  return plugin("delegate", (api) => {
    api.declare(...DELEGATE_TYPES);
    const journal = (): JournalReader | undefined => api.journal?.();
    /** The records of delegate, up to a position when one is given. */
    const rowsOf = (upto?: Seq): StoredRecord[] => {
      const rows = journal()?.since(seq(0), DELEGATE_TYPES.map((type) => type.name)) ?? [];
      return upto === undefined ? rows : rows.filter((row) => row.seq <= upto);
    };
    const ids = new IdIndex("decision", () =>
      rowsOf()
        .filter((row) => row.type === DecisionMade.name)
        .map((row) => ({ id: DecisionMade.schema.parse(row.data).id, seed: String(row.id) })),
    );
    /** The id a decision of a request gets: one request is decided once. */
    const decisionIdOf = (request: RequestId): DecisionId =>
      issueId(
        "decision",
        recordId(`decision:${request}`),
        rowsOf()
          .filter((row) => row.type === DecisionMade.name)
          .map((row) => {
            const made = DecisionMade.schema.parse(row.data);
            return { id: made.id, seed: `decision:${made.request}` };
          }),
      );

    /** The request with this id as it was created, and the record that created it. */
    const createdOf = (id: string): { created: Created; row: StoredRecord } | undefined => {
      const row = journal()?.find({ type: RequestCreated.name, field: "id", equals: id }).at(0);
      return row === undefined ? undefined : { created: RequestCreated.schema.parse(row.data), row };
    };
    /** Where a request stands as of a position: the records about it written up to then. */
    const stateAt = (id: string, at: Seq): RequestState | undefined => {
      const rows = (journal()?.since(seq(0), REQUEST_TYPES.map((type) => type.name)) ?? []).filter(
        (row) => row.seq <= at && (row.data as { id?: string }).id === id,
      );
      return foldRequests(rows).get(id as RequestId);
    };
    /** The requests delegate passed on for a request: the ones the handler woken by its creation asked. */
    const passedOn = (created: StoredRecord, at: Seq): Created[] =>
      (journal()?.since(created.seq, [RequestCreated.name]) ?? [])
        .filter((row) => row.seq <= at && row.cause === created.id)
        .map((row) => RequestCreated.schema.parse(row.data))
        .filter((one) => same(one.from, self));
    const withdraw = async (step: Step, request: RequestId) => {
      // The one it was passed to may end it at the same moment: then there is nothing to withdraw.
      await step.outcome(requestCancel, { id: request, reason: "the request it was passed on for is over", by: self });
    };

    /** The decision of a request, written once, as the request is answered. */
    const decided = (created: Created, kind: DecisionKind, answer: Answer, grounds: readonly string[], by: Address | undefined): Decision | undefined => {
      const area = created.input.area;
      if (area === undefined) return undefined;
      return {
        id: decisionIdOf(created.id),
        description: describe(created.input.title),
        question: questionKey(created.question, created.input),
        area,
        kind,
        answer,
        request: created.id,
        grounds: [...grounds],
        ...(by === undefined ? {} : { by }),
      };
    };

    /** Ask the data owners for the context a judge needs, as the journal stood when the request was made. */
    const contextFor = async (step: Step, created: Created, judge: Address, at: Seq) => {
      const asked: ContextRequest = {
        what: created.input.title,
        ...(created.input.area === undefined ? {} : { area: created.input.area }),
        of: self,
        for: judge,
        why: `judge a request put to ${opts.agent} for the owner`,
        asOf: at,
      };
      const found: SourceRef[] = [];
      let withheld = 0;
      for (const source of sources) {
        const outcome = await step.outcome(source, asked);
        if (outcome.status !== "completed") continue;
        found.push(...outcome.value.sources);
        withheld += outcome.value.withheld;
      }
      return { found, withheld };
    };

    /** Pass a request on to an address, and give back what it answers. Undefined when it ended unanswered. */
    const passOn = async (step: Step, created: Created, to: Address, input: Question, key: string, deadline?: number) => {
      await step.emit(RequestForwarded, { request: created.id, to }, { key });
      try {
        const asked = await step(requestAsk, { to, question: created.question, input, from: self, ...(deadline === undefined ? {} : { deadline: timestamp(deadline) }) });
        return "answer" in asked ? asked : undefined;
      } catch (error) {
        if (error instanceof RequestCancelled || error instanceof RequestExpired) return { ended: error.request };
        throw error;
      }
    };

    /** Where the record that ended a request is. */
    const endOf = (request: RequestId): Seq | undefined =>
      journal()
        ?.since(seq(0), [RequestAnswered.name, RequestCancelledRecord.name, RequestExpiredRecord.name])
        .find((row) => (row.data as { id?: string }).id === request)?.seq;

    /** The answer of a request delegate passed on, as the journal holds it. */
    const answeredRecordOf = (id: RequestId): StoredRecord | undefined =>
      journal()?.find({ type: RequestAnswered.name, field: "id", equals: id }).at(0);

    // A request put to the agent: recalled, judged, or forwarded to the owner. Each waits for its own
    // answer, side by side with the others.
    api.on(
      RequestCreated,
      { id: "delegate-answer", filter: { "to.kind": "agent", "to.id": opts.agent }, concurrency: Infinity },
      async (created, step, at) => {
        const recalled = recallOf(rowsOf(at.seq), created.question, created.input);
        if (recalled !== undefined) {
          await step(requestResolve, { id: created.id, answer: recalled.answer, info: { how: "recalled", area: recalled.area, source: recalled.id } });
          return;
        }
        const area = created.input.area;
        const judge = area === undefined ? undefined : judges[area];
        if (judge !== undefined) {
          const context = await contextFor(step, created, judge, at.seq);
          const input = { ...created.input, detail: withContext(created.input.detail, context.found, context.withheld) } as Question;
          const deadline = (await step.now({ key: "judge-asked" })) + judgeWait;
          const judged = await passOn(step, created, judge, input, "judge", deadline);
          if (judged !== undefined && "answer" in judged) {
            await step(requestResolve, { id: created.id, answer: judged.answer, info: { how: "judged", ...(area === undefined ? {} : { area }), source: judged.id } });
            const answered = answeredRecordOf(judged.id);
            const decision = decided(created, "judge", judged.answer, answered === undefined ? [] : [String(answered.id)], judge);
            if (decision !== undefined) await step.emit(DecisionMade, decision, { key: "decided" });
            return;
          }
          // The judge's question ended unanswered. When the request ended first, it was withdrawn
          // with it and nothing goes on; otherwise the owner is asked.
          const ended = judged === undefined ? undefined : endOf(judged.ended);
          if (ended !== undefined && stateAt(created.id, ended)?.status !== "open") return;
        }
        const forwarded = await passOn(step, created, { kind: "owner" }, created.input, "owner");
        if (forwarded === undefined) return;
        if (!("answer" in forwarded)) {
          // The owner cancelled the forward, so nobody is left to answer the request. One that ended
          // by itself cannot be cancelled, and that is not a failure.
          const ended = endOf(forwarded.ended);
          if (ended !== undefined && stateAt(created.id, ended)?.status === "open") {
            await step.outcome(requestCancel, { id: created.id, reason: "the owner cancelled the forward", by: self });
          }
          return;
        }
        await step(requestResolve, { id: created.id, answer: forwarded.answer });
        // What the owner answered is his decision in the area, whether or not the request still waited.
        const answered = answeredRecordOf(forwarded.id);
        const by = answered === undefined ? undefined : RequestAnswered.schema.parse(answered.data).by;
        if (answered === undefined || by?.kind !== "owner") return;
        const decision = decided(created, "owner", forwarded.answer, [String(answered.id)], by);
        if (decision !== undefined) await step.emit(DecisionMade, decision, { key: "decided" });
      },
    );

    // A request put to the agent that is over takes with it what was passed on for it and still waits:
    // nothing stale is left for the owner or the judge. Decided as of the record that ended it.
    const closePassedOn = async (ended: { id: RequestId }, step: Step, at: StoredRecord) => {
      const found = createdOf(ended.id);
      if (found === undefined || !same(found.created.to, self)) return;
      for (const passed of passedOn(found.row, at.seq)) {
        if (stateAt(passed.id, at.seq)?.status === "open") await withdraw(step, passed.id);
      }
    };
    api.on(RequestAnswered, { id: "delegate-close-answered" }, closePassedOn);
    api.on(RequestCancelledRecord, { id: "delegate-close-cancelled" }, closePassedOn);
    api.on(RequestExpiredRecord, { id: "delegate-close-expired" }, closePassedOn);

    // What was passed on after its request was already over is withdrawn as soon as it is created.
    api.on(
      RequestCreated,
      { id: "delegate-close-late", filter: { "from.kind": "agent", "from.id": opts.agent } },
      async (passed, step, at) => {
        const cause = at.cause === null ? undefined : journal()?.get(at.cause);
        if (cause?.type !== RequestCreated.name) return;
        const original = RequestCreated.schema.parse(cause.data);
        if (!same(original.to, self)) return;
        if (stateAt(original.id, at.seq)?.status !== "open") await withdraw(step, passed.id);
      },
    );

    // A decision of the agent answers the request it decided.
    api.on(DecisionMade, { id: "delegate-decided", filter: { kind: "agent" } }, async (decision, step) => {
      await step.outcome(requestResolve, { id: decision.request, answer: decision.answer, info: { how: "decided", area: decision.area, source: decision.id } });
    });

    api.action(
      action(delegateDecide, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const found = createdOf(input.request);
          if (found === undefined) throw new UnknownId(input.request, "request");
          const { created } = found;
          if (!same(created.to, self)) throw new DeniedError(`the request "${created.id}" is not put to ${opts.agent}`);
          // The grant was checked against the area the caller named; it must be the request's own.
          if (created.input.area !== input.area) {
            throw new DeniedError(`the request "${created.id}" is about the area "${created.input.area ?? "(none)"}", not "${input.area}"`);
          }
          const state = journal() === undefined ? undefined : stateAt(created.id, journal()!.last());
          if (state?.status !== "open") throw new DeniedError(`the request "${created.id}" is ${state?.status ?? "unknown"}`);
          const decision = decided(created, "agent", input.answer, input.grounds, bind(ctx.caller));
          if (decision === undefined) throw new DeniedError(`the request "${created.id}" names no area to decide in`);
          await ctx.emit(DecisionMade, decision);
          return { decision: decision.id };
        },
      }),
    );

    api.action(
      action(delegateRecall, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const found = recallOf(rowsOf(input.asOf === undefined ? undefined : seq(input.asOf)), input.question, input.input);
          return found === undefined ? { found: false as const } : { found: true as const, answer: found.answer, area: found.area, decision: found.id };
        },
      }),
    );

    api.action(
      action(delegateRevoke, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const by = bind(ctx.caller);
          if (by?.kind !== "owner") throw new DeniedError("only the owner may revoke a decision");
          const id = ids.require(input.decision);
          await ctx.emit(DecisionRevoked, { decision: id, by, ...(input.reason === undefined ? {} : { reason: input.reason }) });
          return { decision: id };
        },
      }),
    );

    api.action(
      action(delegateDecisionList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => ({
          items: decisionsOf(rowsOf())
            .filter(({ decision }) => (input.area === undefined || decision.area === input.area) && (input.kind === undefined || decision.kind === input.kind))
            .map(({ decision, revoked }) => ({
              id: decision.id,
              description: decision.description,
              area: decision.area,
              kind: decision.kind,
              request: decision.request,
              revoked,
            })),
        }),
      }),
    );

    api.summarize(() => {
      const all = decisionsOf(rowsOf());
      return { decisions: all.filter((one) => !one.revoked).length, revoked: all.filter((one) => one.revoked).length };
    });
  });
}
