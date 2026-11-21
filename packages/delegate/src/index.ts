/**
 * The delegate plugin: it answers for the owner the requests put to one agent.
 *
 * A request addressed to the agent is answered from the owner's decision about the same question in
 * the same area, when one stands. A request of an area that has a judge goes to the judge, with the
 * context the data owners give for it. The agent, or anyone a grant lets decide the area, may decide
 * it within that bound. What is left goes to the owner, and his answer is his decision from then on,
 * unless it was given for this time only. Whatever was passed on for a request is withdrawn when the
 * request is over without it.
 *
 * Nothing is kept in memory: decisions are folded from the journal. A handler reads the journal as
 * of the record that woke it, so a replay decides the same.
 */

import {
  DeniedError,
  EntityDescription,
  IdIndex,
  RecordRefused,
  UnknownId,
  ValidationError,
  action,
  answerMismatch,
  issueId,
  pickedOptions,
  recordId,
  seq,
  stableJson,
  timestamp,
} from "@niwa-labs/core";
import type { Address, Answer, JournalReader, OptionFlavor, Question, Seq, Step, StoredRecord } from "@niwa-labs/core";
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
  RequestId,
  fold as foldRequests,
  requestAsk,
  requestCancel,
  requestResolve,
} from "@niwa-labs/requests/records";
import type { RequestState } from "@niwa-labs/requests/records";
import type { z } from "zod";

import {
  ContextAnswer,
  DELEGATE_TYPES,
  HandlingStarted,
  DecisionMade,
  DecisionRevoked,
  RequestForwarded,
  contextSource,
  delegateDecide,
  delegateDecisionList,
  delegateRecall,
  delegateRevoke,
} from "./records.ts";
import type { ContextItem, ContextRequest, DecisionId, DecisionKind } from "./records.ts";

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

/** How many times the owner is asked again for an answer the request's own question refuses. */
const MAX_OWNER_ROUNDS = 3;

/** The longest description a list shows, and the shortest. */
const DESCRIPTION_MAX_CHARS = 60;
const DESCRIPTION_MIN_CHARS = 3;

type Created = z.infer<typeof RequestCreated.schema>;
type Decision = z.infer<typeof DecisionMade.schema>;

/** How an answer given to a request was found, as `request.resolve` keeps it. */
interface Found {
  readonly how: string;
  readonly area: string;
  readonly source: string;
}

/** What became of an answer handed to its request. */
type Taken =
  /** The request is answered by it. */
  | { readonly status: "answered" }
  /** The request was over before it came. */
  | { readonly status: "over" }
  /** The request's own question refuses it. */
  | { readonly status: "refused"; readonly reason: string };

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

/** What choosing an option is worth for one time only. */
const ONE_TIME: ReadonlySet<OptionFlavor> = new Set(["allow_once", "reject_once"]);

/** Whether an answer holds for this one request only: it picks an option that allows or refuses once. */
export function isOneTime(input: Question, answer: Answer): boolean {
  return pickedOptions(input, answer).some((option) => ONE_TIME.has(option.flavor));
}

/**
 * The owner's decision that answers a question, when one stands: the last one made for the same key
 * in the same area and not revoked. A question without an area names no decision, and neither does
 * a decision that was good for one time only: the next request is put to the owner again.
 */
export function recallOf(rows: readonly StoredRecord[], question: string, input: Question): Decision | undefined {
  const area = input.area;
  if (area === undefined) return undefined;
  const key = questionKey(question, input);
  const last = decisionsOf(rows)
    .filter((one) => !one.revoked && one.decision.kind === "owner" && one.decision.question === key && one.decision.area === area)
    .at(-1)?.decision;
  return last === undefined || isOneTime(input, last.answer) ? undefined : last;
}

/** A description a person reads in a list, from the title of a question: one line, cut to what a list shows. */
function describe(title: string): EntityDescription {
  const line = title.replace(/\s+/g, " ").trim();
  let short = "";
  if (line.length <= DESCRIPTION_MAX_CHARS) short = line;
  else {
    for (const character of line) {
      if (short.length + character.length > DESCRIPTION_MAX_CHARS - 1) break;
      short += character;
    }
    short = `${short.trimEnd()}…`;
  }
  return EntityDescription.parse(short.length >= DESCRIPTION_MIN_CHARS ? short : "Decision");
}

/** Whether two addresses are the same. */
function same(a: Address | undefined, b: Address | undefined): boolean {
  return a !== undefined && b !== undefined && stableJson(a) === stableJson(b);
}

/** The context the data owners gave, as lines a judge reads under the question. */
function withContext(detail: string | undefined, items: readonly ContextItem[], withheld: number): string | undefined {
  if (items.length === 0 && withheld === 0) return detail;
  const lines = items.map(({ text, project, source }) => {
    const owner = "id" in source.owner ? `${source.owner.kind} ${source.owner.id}` : source.owner.kind;
    const holds = project === undefined ? "" : `holds in ${project}; `;
    return `- ${text} (${holds}${source.note} of ${owner} at ${String(source.seq)})`;
  });
  if (withheld > 0) lines.push(`- ${String(withheld)} more not shown: this reader may not have them.`);
  return [detail, "Context:", ...lines].filter((line) => line !== undefined).join("\n");
}

/** The request types delegate needs the host to declare: it answers, withdraws and waits on them. */
const REQUIRED = [RequestCreated, RequestAnswered, RequestCancelledRecord, RequestExpiredRecord] as const;

/** The delegate plugin. */
export function delegate(opts: DelegateOptions): Plugin {
  const self: Address = { kind: "agent", id: opts.agent };
  // A map, not the object it was given: an area named like a property of every object is not a judge.
  const judges = new Map(Object.entries(opts.judges ?? {}));
  const judgeWait = opts.judgeWaitMs ?? DEFAULT_JUDGE_WAIT_MS;
  for (const [area, judge] of judges) {
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
    /** The id a decision of a request gets: one request is decided once by each kind of decider. */
    const decisionIdOf = (request: RequestId, kind: DecisionKind): DecisionId =>
      issueId(
        "decision",
        recordId(`decision:${request}:${kind}`),
        rowsOf()
          .filter((row) => row.type === DecisionMade.name)
          .map((row) => {
            const made = DecisionMade.schema.parse(row.data);
            return { id: made.id, seed: `decision:${made.request}:${made.kind}` };
          }),
      );
    /** The ids of the requests put to the agent, to name one by a short text. */
    const requestIds = new IdIndex("request", () =>
      (journal()?.find({ type: RequestCreated.name }) ?? [])
        .map((row) => ({ created: RequestCreated.schema.parse(row.data), seed: String(row.id) }))
        .filter(({ created }) => same(created.to, self))
        .map(({ created, seed }) => ({ id: created.id, seed })),
    );

    /** The request with this id as it was created, and the record that created it. */
    const createdOf = (id: string): { created: Created; row: StoredRecord } | undefined => {
      const row = journal()?.find({ type: RequestCreated.name, field: "id", equals: id }).at(0);
      return row === undefined ? undefined : { created: RequestCreated.schema.parse(row.data), row };
    };
    /** The request a text names among those put to the agent: its id, or a unique start or end of it. */
    const requestNamed = (text: string): { created: Created; row: StoredRecord } => {
      const found = createdOf(text) ?? createdOf(requestIds.require(text));
      if (found === undefined) throw new UnknownId(text, "request");
      return found;
    };
    /** The records about one request, in the order they were written. */
    const recordsAbout = (id: string, types: readonly { readonly name: string }[]): StoredRecord[] =>
      types
        .flatMap((type) => journal()?.find({ type: type.name as StoredRecord["type"], field: "id", equals: id }) ?? [])
        .sort((a, b) => a.seq - b.seq);
    /** Where a request stands as of a position: the records about it written up to then. */
    const stateAt = (id: string, at: Seq): RequestState | undefined =>
      foldRequests(recordsAbout(id, REQUEST_TYPES).filter((row) => row.seq <= at)).get(id as RequestId);
    /**
     * The invocations of delegate-answer that passed a request on: the forwards they wrote name
     * them, and what they asked is what was passed on. Another handler's question, asked for the
     * same request, is its own.
     */
    const forwardersOf = (request: RequestId): ReadonlySet<string> =>
      new Set(
        (journal()?.find({ type: RequestForwarded.name, field: "request", equals: request }) ?? []).flatMap((row) =>
          row.actor.kind === "handler" ? [String(row.actor.invocation)] : [],
        ),
      );
    const askedBy = (row: StoredRecord, invocations: ReadonlySet<string>): boolean => row.actor.kind === "handler" && invocations.has(String(row.actor.invocation));
    /** The requests delegate passed on for a request, as of a position. */
    const passedOn = (request: RequestId, created: Seq, at: Seq): Created[] => {
      const invocations = forwardersOf(request);
      if (invocations.size === 0) return [];
      return (journal()?.query({ types: [RequestCreated.name], filter: { "from.kind": "agent", "from.id": opts.agent }, from: created }) ?? [])
        .filter((row) => row.seq <= at && askedBy(row, invocations))
        .map((row) => RequestCreated.schema.parse(row.data));
    };
    const withdraw = async (step: Step, request: RequestId) => {
      // The one it was passed to may end it at the same moment: then there is nothing to withdraw.
      await step.outcome(requestCancel, { id: request, reason: "the request it was passed on for is over", by: self });
    };

    /** The decision of a request, written once, as the request is answered. */
    const decided = (created: Created, kind: DecisionKind, answer: Answer, grounds: readonly string[], by: Address | undefined): Decision | undefined => {
      const area = created.input.area;
      if (area === undefined) return undefined;
      return {
        id: decisionIdOf(created.id, kind),
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
        memory: opts.agent,
        query: created.input.title.slice(0, 500),
        purpose: `judge a request${created.input.area === undefined ? "" : ` about ${created.input.area}`} put to ${opts.agent} for the owner`,
        for: judge,
        at,
      };
      const items: ContextItem[] = [];
      let withheld = 0;
      for (const source of sources) {
        const outcome = await step.outcome(source, asked);
        if (outcome.status !== "completed") continue;
        // The owner of the action checked its own answer; delegate reads the part it knows.
        const answer = ContextAnswer.safeParse(outcome.value);
        if (!answer.success) continue;
        items.push(...answer.data.items);
        withheld += answer.data.withheld.length;
      }
      return { items, withheld };
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

    /**
     * Hand an answer to its request. The question of the request may refuse it (a form held to more
     * than its schema says), and then the request stays open and the answer is not taken.
     */
    const take = async (step: Step, created: Created, answer: Answer, found?: Found): Promise<Taken> => {
      const outcome = await step.outcome(requestResolve, { id: created.id, answer, ...(found === undefined ? {} : { info: found }) });
      if (outcome.status === "completed") return outcome.value.answered ? { status: "answered" } : { status: "over" };
      return outcome.status === "failed" ? { status: "refused", reason: outcome.error } : { status: "over" };
    };

    /** Where the record that ended a request is. */
    const endOf = (request: RequestId): Seq | undefined => recordsAbout(request, [RequestAnswered, RequestCancelledRecord, RequestExpiredRecord]).at(0)?.seq;

    /** The answer of a request delegate passed on, as the journal holds it. */
    const answeredRecordOf = (id: RequestId): StoredRecord | undefined =>
      journal()?.find({ type: RequestAnswered.name, field: "id", equals: id }).at(0);

    // A request put to the agent: recalled, judged, or forwarded to the owner. Each waits for its own
    // answer, side by side with the others.
    api.on(
      RequestCreated,
      { id: "delegate-answer", filter: { "to.kind": "agent", "to.id": opts.agent }, concurrency: { by: data => data.id }, requires: REQUIRED },
      async (created, step, at) => {
        await step.emit(HandlingStarted, { request: created.id }, { key: "claim" });
        const recalled = recallOf(rowsOf(at.seq), created.question, created.input);
        if (recalled !== undefined) {
          // An answer the question refuses today is not an answer: the request goes on as if nothing was recalled.
          const taken = await take(step, created, recalled.answer, { how: "recalled", area: recalled.area, source: recalled.id });
          if (taken.status !== "refused") return;
        }
        const area = created.input.area;
        const judge = area === undefined ? undefined : judges.get(area);
        if (area !== undefined && judge !== undefined) {
          const context = await contextFor(step, created, judge, at.seq);
          const input = { ...created.input, detail: withContext(created.input.detail, context.items, context.withheld) } as Question;
          const deadline = (await step.now({ key: "judge-asked" })) + judgeWait;
          const judged = await passOn(step, created, judge, input, "judge", deadline);
          if (judged !== undefined && "answer" in judged) {
            const taken = await take(step, created, judged.answer, { how: "judged", area, source: judged.id });
            if (taken.status === "over") return;
            if (taken.status === "answered") {
              // Whoever answered the judge's question decided: the judge, or the owner in its place.
              const answered = answeredRecordOf(judged.id);
              const author = answered === undefined ? undefined : RequestAnswered.schema.parse(answered.data).by;
              const decision = decided(created, author?.kind === "owner" ? "owner" : "judge", judged.answer, answered === undefined ? [] : [String(answered.id)], author);
              if (decision !== undefined) await step.emit(DecisionMade, decision, { key: "decided" });
              return;
            }
            // The question refused the judge's answer: the owner is asked.
          } else {
            // The judge's question ended unanswered. When the request ended first, it was withdrawn
            // with it and nothing goes on; otherwise the owner is asked.
            const ended = judged === undefined ? undefined : endOf(judged.ended);
            if (ended !== undefined && stateAt(created.id, ended)?.status !== "open") return;
          }
        }
        let asking: Question = created.input;
        for (let round = 1; round <= MAX_OWNER_ROUNDS; round++) {
          const forwarded = await passOn(step, created, { kind: "owner" }, asking, round === 1 ? "owner" : `owner-${String(round)}`);
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
          const taken = await take(step, created, forwarded.answer);
          if (taken.status === "refused") {
            // The owner answered the copy; the question of the original refuses the answer. He is asked again, with why.
            const why = `Your answer was not accepted: ${taken.reason}`;
            asking = { ...created.input, detail: [created.input.detail, why].filter((line) => line !== undefined).join("\n") } as Question;
            continue;
          }
          // What the owner answered is his decision in the area, whether or not the request still waited.
          const answered = answeredRecordOf(forwarded.id);
          const by = answered === undefined ? undefined : RequestAnswered.schema.parse(answered.data).by;
          if (answered === undefined || by?.kind !== "owner") return;
          const decision = decided(created, "owner", forwarded.answer, [String(answered.id)], by);
          if (decision !== undefined) await step.emit(DecisionMade, decision, { key: "decided" });
          return;
        }
        await step.outcome(requestCancel, { id: created.id, reason: "the answers of the owner did not fit the question", by: self });
      },
    );

    // A request put to the agent that is over takes with it what was passed on for it and still waits:
    // nothing stale is left for the owner or the judge. Decided as of the record that ended it.
    const closePassedOn = async (ended: { id: RequestId }, step: Step, at: StoredRecord) => {
      const found = createdOf(ended.id);
      if (found === undefined || !same(found.created.to, self)) return;
      for (const passed of passedOn(found.created.id, found.row.seq, at.seq)) {
        if (stateAt(passed.id, at.seq)?.status === "open") await withdraw(step, passed.id);
      }
    };
    api.on(RequestAnswered, { id: "delegate-close-answered", requires: REQUIRED }, closePassedOn);
    api.on(RequestCancelledRecord, { id: "delegate-close-cancelled", requires: REQUIRED }, closePassedOn);
    api.on(RequestExpiredRecord, { id: "delegate-close-expired", requires: REQUIRED }, closePassedOn);

    // What was passed on after its request was already over is withdrawn as soon as it is created.
    api.on(
      RequestCreated,
      { id: "delegate-close-late", filter: { "from.kind": "agent", "from.id": opts.agent }, requires: REQUIRED },
      async (passed, step, at) => {
        const cause = at.cause === null ? undefined : journal()?.get(at.cause);
        if (cause?.type !== RequestCreated.name) return;
        const original = RequestCreated.schema.parse(cause.data);
        if (!same(original.to, self) || !askedBy(at, forwardersOf(original.id))) return;
        if (stateAt(original.id, at.seq)?.status !== "open") await withdraw(step, passed.id);
      },
    );

    // A decision of the agent answers the request it decided. When the request does not take it,
    // because it ended otherwise first or its question refuses the answer, the decision is revoked.
    api.on(DecisionMade, { id: "delegate-decided", filter: { kind: "agent" }, requires: REQUIRED }, async (decision, step) => {
      const outcome = await step.outcome(requestResolve, { id: decision.request, answer: decision.answer, info: { how: "decided", area: decision.area, source: decision.id } });
      if (outcome.status === "completed" && outcome.value.answered) return;
      const reason = outcome.status === "failed" ? outcome.error : "the request did not take the answer";
      await step.emit(DecisionRevoked, { decision: decision.id, reason }, { key: "revoked" });
    });

    /** The decision the agent made of a request, revoked or not. */
    const agentDecisionOf = (request: RequestId): { decision: Decision; revoked: boolean } | undefined => {
      const reader = journal();
      const made = reader?.find({ type: DecisionMade.name, field: "request", equals: request }).map((row) => DecisionMade.schema.parse(row.data)).find((one) => one.kind === "agent");
      if (reader === undefined || made === undefined) return undefined;
      return { decision: made, revoked: reader.find({ type: DecisionRevoked.name, field: "decision", equals: made.id }).length > 0 };
    };

    api.action(
      action(delegateDecide, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const { created } = requestNamed(input.request);
          if (!same(created.to, self)) throw new DeniedError(`the request "${created.id}" is not put to ${opts.agent}`);
          // The grant was checked against the area the caller named; it must be the request's own.
          if (created.input.area !== input.area) {
            throw new DeniedError(`the request "${created.id}" is about the area "${created.input.area ?? "(none)"}", not "${input.area}"`);
          }
          // A request is decided once. The same answer again, as a call made again, is the decision it made.
          const prior = agentDecisionOf(created.id);
          if (prior !== undefined) {
            if (prior.revoked) throw new DeniedError(`the decision of the request "${created.id}" was revoked: the request did not take it`);
            if (stableJson(prior.decision.answer) !== stableJson(input.answer)) throw new DeniedError(`the request "${created.id}" is already decided otherwise`);
            return { decision: prior.decision.id };
          }
          const mismatch = answerMismatch(created.input, input.answer);
          if (mismatch !== undefined) throw new ValidationError(`the answer is not one the question of "${created.id}" takes: ${mismatch}`);
          const state = journal() === undefined ? undefined : stateAt(created.id, journal()!.last());
          if (state?.status !== "open") throw new DeniedError(`the request "${created.id}" is ${state?.status ?? "unknown"}`);
          const decision = decided(created, "agent", input.answer, input.grounds, bind(ctx.caller));
          if (decision === undefined) throw new DeniedError(`the request "${created.id}" names no area to decide in`);
          try {
            await ctx.emit(DecisionMade, decision);
            return { decision: decision.id };
          } catch (error) {
            if (!(error instanceof RecordRefused) || error.code !== "decided") throw error;
            const winner = agentDecisionOf(created.id);
            if (winner !== undefined && !winner.revoked && stableJson(winner.decision.answer) === stableJson(input.answer)) {
              return { decision: winner.decision.id };
            }
            throw error;
          }
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
