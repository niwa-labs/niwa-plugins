/**
 * The records of the plan plugin, and the typed references of its actions.
 *
 * A plan is what is to be done about something and in which order. Each revision is written whole,
 * so a plan is read at any revision without folding the ones before it.
 */

import { z } from "zod";

import { actionRef, record } from "@niwa-labs/core";

/**
 * Where an item stands. `open` is a decision still ahead: the plan cannot go on past it until
 * somebody decides. The others say what became of work that is already decided.
 */
export const ItemState = z.enum(["open", "planned", "done", "dropped"]);
export type ItemState = z.infer<typeof ItemState>;

/** One step of a plan. */
export const PlanItem = z.object({
  /** Names the item across revisions; unique inside one plan. */
  id: z.string().trim().min(1),
  /** What is to be done, or what is to be decided. */
  text: z.string().trim().min(1),
  state: ItemState,
  /** Why it stands where it does: the decision taken, the reason it was dropped. */
  note: z.string().trim().min(1).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** The items of a plan: one list, in the order the work goes in, with no id twice. */
export const PlanItems = z.array(PlanItem).superRefine((items, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", message: `the item id "${item.id}" is used twice`, path: [index, "id"] });
    seen.add(item.id);
  }
});

/**
 * What a plan is of: a task, a run, a branch, anything the writer names.
 *
 * The text is trimmed and must be well-formed Unicode, so the subject an action works with and the
 * one a grant names (`planTarget`) are the same text, and encoding it cannot fail.
 */
export const PlanSubject = z
  .string()
  .trim()
  .min(1)
  .refine((text) => text.isWellFormed(), { message: "a plan is of text with no unpaired UTF-16 surrogate" });

/** A revision of a plan was written: the whole plan as it stands from `rev` on. */
export const PlanRevised = record(
  "plan.revised",
  z.object({
    /** What the plan is of. */
    of: PlanSubject,
    /** The number of the revision, from 1, one more than the revision before it. */
    rev: z.number().int().positive(),
    /** What the plan is for, when it says. */
    goal: z.string().trim().min(1).optional(),
    items: PlanItems,
  }),
);
export type PlanRevisedData = z.infer<typeof PlanRevised.schema>;

/** The record types the plan plugin declares. */
export const PLAN_TYPES = [PlanRevised] as const;

/** A plan at one revision, as `plan.get` shows it. */
export const PlanView = z.object({
  of: PlanSubject,
  rev: z.number().int().positive(),
  goal: z.string().optional(),
  items: PlanItems,
  /** How many revisions the plan has had, the latest included. */
  revisions: z.number().int().positive(),
  /** When this revision was written, in milliseconds since the epoch. */
  at: z.number().int().nonnegative(),
});
export type PlanView = z.infer<typeof PlanView>;

/** What `plan.list` shows of each plan: where it stands, not its items. */
export const PlanSummary = z.object({
  of: PlanSubject,
  rev: z.number().int().positive(),
  goal: z.string().optional(),
  /** How many items the latest revision has, and how many of them are decisions still ahead. */
  items: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

/**
 * What a grant's `@target` names a plan by: one segment, so any text a plan is of stays one place.
 *
 * The subject is read as the actions read it, so a grant built here matches the call it is for.
 */
export function planTarget(of: string): string {
  return encodeURIComponent(PlanSubject.parse(of)).replace(/\*/g, "%2A");
}

export const planSet = actionRef("plan.set", {
  description:
    "Write a revision of the plan of `of`: its goal and the whole list of items, each with a state (`open` is a decision still ahead). " +
    "The revision is numbered by the plan, one after the last. Items equal to the latest revision write nothing and return it. " +
    "Give `expect` the revision you based the change on to refuse it when someone revised the plan since.",
  input: z.object({
    of: PlanSubject,
    goal: z.string().trim().min(1).optional(),
    items: PlanItems,
    expect: z.number().int().nonnegative().optional(),
  }),
  output: z.object({ of: PlanSubject, rev: z.number().int().positive(), revised: z.boolean() }),
  target: (input) => planTarget(input.of),
});

export const planGet = actionRef("plan.get", {
  description: "Read the plan of `of`: its latest revision, or the one asked for with `rev`.",
  input: z.object({ of: PlanSubject, rev: z.number().int().positive().optional() }),
  output: PlanView,
  target: (input) => planTarget(input.of),
});

export const planList = actionRef("plan.list", {
  description:
    "List the plans: what each is of, its latest revision and how many of its items are decisions still ahead. " +
    "`open: true` keeps the plans that have at least one.",
  input: z.object({ open: z.boolean().optional() }),
  output: z.object({ plans: z.array(PlanSummary) }),
});
