/** What a commitment card shows of where a commitment stands. */

import type { WorkState } from "@niwa-labs/ui-kit";

import type { CommitmentStatus } from "./actions.ts";

export const RING: Record<CommitmentStatus, WorkState> = {
  proposed: "waiting",
  open: "pending",
  due: "running",
  kept: "done",
  missed: "failed",
  cancelled: "stopped",
  declined: "skipped",
};

/** Whether a commitment may still be cancelled: it has not ended. */
export function cancellable(status: CommitmentStatus): boolean {
  return status === "proposed" || status === "open" || status === "due";
}
