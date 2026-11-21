/** What a commitment card shows of where a commitment stands. */

import type { Viewer } from "@niwa-labs/cockpit-sdk";
import type { WorkState } from "@niwa-labs/ui-kit";

import { cancelAction } from "./actions.ts";
import type { CommitmentItem, CommitmentStatus } from "./actions.ts";

export const RING: Record<CommitmentStatus, WorkState> = {
  proposed: "waiting",
  open: "pending",
  due: "running",
  kept: "done",
  "kept-late": "done",
  missed: "failed",
  cancelled: "stopped",
  declined: "skipped",
};

/** Whether a commitment may still be cancelled: it has not ended. */
export function cancellable(status: CommitmentStatus): boolean {
  return status === "proposed" || status === "open" || status === "due";
}

/** Show the cancel control when both the caller's grant and the promise allow it. */
export function canCancel(commitment: Pick<CommitmentItem, "canCancel">, viewer: Pick<Viewer, "can">): boolean {
  return commitment.canCancel && viewer.can(cancelAction);
}
