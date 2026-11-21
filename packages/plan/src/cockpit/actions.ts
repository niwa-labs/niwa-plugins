/**
 * The plan actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const ItemState = z.enum(["open", "planned", "done", "dropped"]);
export type ItemState = z.infer<typeof ItemState>;

export const PlanItem = z.object({ id: z.string(), text: z.string(), state: ItemState, note: z.string().optional() });
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanSummary = z.object({
  of: z.string(),
  rev: z.number(),
  goal: z.string().optional(),
  items: z.number(),
  open: z.number(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const listAction = {
  name: "plan.list",
  input: z.object({ open: z.boolean().optional() }),
  output: z.object({ plans: z.array(PlanSummary) }),
} as const;

export const PlanView = z.object({
  of: z.string(),
  rev: z.number(),
  goal: z.string().optional(),
  items: z.array(PlanItem),
  revisions: z.number(),
  at: z.number(),
});
export type PlanView = z.infer<typeof PlanView>;

export const getAction = {
  name: "plan.get",
  input: z.object({ of: z.string(), rev: z.number().int().positive().optional() }),
  output: PlanView,
} as const;
