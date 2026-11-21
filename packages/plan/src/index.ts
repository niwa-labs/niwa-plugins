/**
 * The plan plugin: revisable plans, read back at any revision.
 *
 * - **plan.set** writes the next revision of the plan of something: a goal and the whole list of
 *   items. A set that changes nothing writes nothing, so it may be made again after a cut-off call.
 * - **plan.get** reads a plan at its latest revision, or at one asked for.
 * - **plan.list** lists the plans, and the ones with a decision still ahead.
 *
 * What an agent ticks off while it works is not here: that checklist is read from the history of
 * its session.
 *
 * A plan is folded from `plan.revised` records on every read; the records are the only state.
 */

import { CatchableError, NotSent, action, recordId, resolveQuery, stableJson } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import { PLAN_TYPES, PlanRevised, planGet, planList, planSet } from "./records.ts";
import type { PlanRevisedData, PlanSummary, PlanView } from "./records.ts";

export * from "./records.ts";

/** Why a plan, or a revision of it, was refused. */
export type PlanRefusalCode = "unknown-plan" | "unknown-revision" | "stale";

/**
 * A plan, or a revision of it, that cannot be had: the caller asked for what is not there, or for a
 * change on a revision that is no longer the latest. It is the caller's to catch, and `code` says
 * which; nothing was written.
 */
export class PlanRefusal extends CatchableError {
  override name = "PlanRefusal";
  override readonly code: PlanRefusalCode;
  readonly effectPossible = false;
  constructor(code: PlanRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface Revision {
  readonly data: PlanRevisedData;
  readonly at: number;
}

/**
 * The revisions of one plan, by the number they carry, lowest first. A number written twice is the
 * one written first: a later record of the same number is never read.
 */
function revisionsOf(rows: readonly { readonly data: unknown; readonly at: number }[]): Revision[] {
  const byNumber = new Map<number, Revision>();
  for (const row of rows) {
    const data = row.data as PlanRevisedData;
    if (!byNumber.has(data.rev)) byNumber.set(data.rev, { data, at: row.at });
  }
  return [...byNumber.values()].sort((a, b) => a.data.rev - b.data.rev);
}

/** What a set holds, as one text: equal text is the same revision. */
function contentOf(data: Pick<PlanRevisedData, "goal" | "items">): string {
  return stableJson({ goal: data.goal ?? null, items: data.items });
}

function viewOf(list: readonly Revision[], revision: number): PlanView {
  const found = list.find((one) => one.data.rev === revision);
  if (found === undefined) throw new PlanRefusal("unknown-revision", `the plan has no revision ${revision}`);
  const { of, rev, goal, items } = found.data;
  return { of, rev, ...(goal === undefined ? {} : { goal }), items, revisions: list.length, at: found.at };
}

/** The plan plugin. */
export function plan(): Plugin {
  return plugin("plan", (api) => {
    api.declare(...PLAN_TYPES);

    // The plans are read from the journal: with none to read there is no history, and that is said,
    // not shown as a history with nothing in it.
    const journal = (): JournalReader => {
      const reader = api.journal?.();
      if (reader === undefined) throw new NotSent("the plans are read from the journal, and the host is not serving it");
      return reader;
    };

    /** The revisions of one plan. */
    const historyOf = (of: string): Revision[] =>
      revisionsOf(journal().query(resolveQuery({ types: [PlanRevised], filter: { of } })));

    // A set reads the latest revision and writes the next one. Sets of one plan wait for each
    // other, so the number read is the number still free when the record is written.
    const queues = new Map<string, Promise<unknown>>();
    const serialized = <T>(of: string, work: () => Promise<T>): Promise<T> => {
      const turn = (queues.get(of) ?? Promise.resolve()).then(work, work);
      const tail = turn.catch(() => undefined);
      queues.set(of, tail);
      void tail.then(() => {
        if (queues.get(of) === tail) queues.delete(of);
      });
      return turn;
    };

    api.action(
      action(planSet, {
        // A call cut off before its outcome was known is made again under the same operation: it
        // finds the revision it wrote, or writes it. A set that changes nothing writes nothing,
        // so made again it finds the plan as it stands.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        run: (input, ctx) =>
          serialized(input.of, async () => {
            // The revision this very operation wrote is the answer, whatever came after it.
            const born = journal().get(recordId(`${ctx.operationId}/emit/1`));
            if (born !== undefined && born.type === PlanRevised.name) {
              const written = born.data as PlanRevisedData;
              if (written.of === input.of) return { of: written.of, rev: written.rev, revised: true };
            }
            const head = historyOf(input.of).at(-1);
            const rev = head === undefined ? 0 : head.data.rev;
            if (input.expect !== undefined && input.expect !== rev) {
              throw new PlanRefusal(
                "stale",
                `the plan of "${input.of}" is at revision ${rev}, not ${input.expect}: read it again before revising`,
              );
            }
            if (head !== undefined && contentOf(head.data) === contentOf(input)) {
              return { of: input.of, rev, revised: false };
            }
            await ctx.emit(PlanRevised, {
              of: input.of,
              rev: rev + 1,
              ...(input.goal === undefined ? {} : { goal: input.goal }),
              items: input.items,
            });
            return { of: input.of, rev: rev + 1, revised: true };
          }),
      }),
    );

    api.action(
      action(planGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          const list = historyOf(input.of);
          const head = list.at(-1);
          if (head === undefined) throw new PlanRefusal("unknown-plan", `there is no plan of "${input.of}"`);
          return viewOf(list, input.rev ?? head.data.rev);
        },
      }),
    );

    api.action(
      action(planList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          // Only the latest revision of each plan is kept while reading: the older ones are dropped.
          const heads = new Map<string, PlanRevisedData>();
          for (const row of journal().query(resolveQuery({ types: [PlanRevised] }))) {
            const data = row.data as PlanRevisedData;
            const kept = heads.get(data.of);
            if (kept === undefined || data.rev > kept.rev) heads.set(data.of, data);
          }
          const plans: PlanSummary[] = [];
          for (const head of heads.values()) {
            const open = head.items.filter((item) => item.state === "open").length;
            if (input.open === true && open === 0) continue;
            plans.push({
              of: head.of,
              rev: head.rev,
              ...(head.goal === undefined ? {} : { goal: head.goal }),
              items: head.items.length,
              open,
            });
          }
          return { plans };
        },
      }),
    );
  });
}
