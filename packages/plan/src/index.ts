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

import { action, resolveQuery, stableJson } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import { PLAN_TYPES, PlanRevised, planGet, planList, planSet } from "./records.ts";
import type { PlanRevisedData, PlanSummary, PlanView } from "./records.ts";

export * from "./records.ts";

/** A plan, or a revision of it, that cannot be had: the caller asked for what is not there. */
export class PlanRefusal extends Error {
  override name = "PlanRefusal";
  constructor(
    readonly reason: "unknown-plan" | "unknown-revision" | "stale",
    message: string,
  ) {
    super(message);
  }
}

interface Revision {
  readonly data: PlanRevisedData;
  readonly at: number;
}

/** The revisions of every plan, each in order of writing. */
function revisionsOf(rows: readonly StoredRecord[]): Map<string, Revision[]> {
  const plans = new Map<string, Revision[]>();
  for (const row of rows) {
    const data = row.data as PlanRevisedData;
    const list = plans.get(data.of) ?? [];
    list.push({ data, at: row.at });
    plans.set(data.of, list);
  }
  return plans;
}

/** What a set holds, as one text: equal text is the same revision. */
function contentOf(data: Pick<PlanRevisedData, "goal" | "items">): string {
  return stableJson({ goal: data.goal ?? null, items: data.items });
}

function viewOf(list: readonly Revision[], revision: number): PlanView {
  const found = list[revision - 1];
  if (found === undefined) throw new PlanRefusal("unknown-revision", `the plan has no revision ${revision}`);
  const { of, rev, goal, items } = found.data;
  return { of, rev, ...(goal === undefined ? {} : { goal }), items, revisions: list.length, at: found.at };
}

/** The plan plugin. */
export function plan(): Plugin {
  return plugin("plan", (api) => {
    api.declare(...PLAN_TYPES);

    const read = (): Map<string, Revision[]> => {
      const rows = api.journal?.()?.query(resolveQuery({ types: [PlanRevised] })) ?? [];
      return revisionsOf(rows);
    };

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
        // A set that changes nothing writes nothing, so a call cut off before its outcome was known
        // is made again: it either writes the revision or finds it written.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        run: (input, ctx) =>
          serialized(input.of, async () => {
            const head = read().get(input.of)?.at(-1);
            if (head !== undefined && contentOf(head.data) === contentOf(input)) {
              return { of: input.of, rev: head.data.rev, revised: false };
            }
            const rev = head === undefined ? 0 : head.data.rev;
            if (input.expect !== undefined && input.expect !== rev) {
              throw new PlanRefusal(
                "stale",
                `the plan of "${input.of}" is at revision ${rev}, not ${input.expect}: read it again before revising`,
              );
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
          const list = read().get(input.of);
          if (list === undefined) throw new PlanRefusal("unknown-plan", `there is no plan of "${input.of}"`);
          return viewOf(list, input.rev ?? list.length);
        },
      }),
    );

    api.action(
      action(planList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          const plans: PlanSummary[] = [];
          for (const list of read().values()) {
            const head = list.at(-1)?.data;
            if (head === undefined) continue;
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
