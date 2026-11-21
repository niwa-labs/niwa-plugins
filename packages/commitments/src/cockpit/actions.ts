/**
 * The commitment actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const Address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }).loose();

export const CommitmentStatus = z.enum(["proposed", "open", "due", "kept", "kept-late", "missed", "cancelled", "declined"]);
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

export const CommitmentItem = z.object({
  id: z.string(),
  description: z.string(),
  status: CommitmentStatus,
  by: Address,
  canCancel: z.boolean(),
  party: z.enum(["self", "owner"]),
  to: z.string(),
  due: z.number().optional(),
});
export type CommitmentItem = z.infer<typeof CommitmentItem>;

export const listAction = {
  name: "commitment.list",
  input: z.object({ status: CommitmentStatus.optional() }),
  output: z.object({ items: z.array(CommitmentItem) }),
} as const;

export const cancelAction = {
  name: "commitment.cancel",
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  output: z.object({ id: z.string(), status: CommitmentStatus }),
} as const;
