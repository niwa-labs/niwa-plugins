/**
 * The watch actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const WatchState = z.enum(["working", "waiting-human", "waiting-event", "sleeping", "idle", "looping", "stuck", "unknown"]);
export type WatchState = z.infer<typeof WatchState>;

export const StuckKind = z.enum(["silent", "looping", "shielded-cancel"]);
export type StuckKind = z.infer<typeof StuckKind>;

export const Reading = z.object({
  subject: z.string(),
  state: WatchState,
  since: z.number(),
  last: z.number(),
  kind: StuckKind.optional(),
});
export type Reading = z.infer<typeof Reading>;

export const listAction = {
  name: "watch.list",
  input: z.object({ state: WatchState.optional() }),
  output: z.object({ subjects: z.array(Reading) }),
} as const;
