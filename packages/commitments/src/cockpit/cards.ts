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
  missed: "failed",
  cancelled: "stopped",
  declined: "skipped",
};

/** Whether a commitment may still be cancelled: it has not ended. */
export function cancellable(status: CommitmentStatus): boolean {
  return status === "proposed" || status === "open" || status === "due";
}

/**
 * Whether a card offers its viewer a cancel: the commitment has not ended, the viewer may call the
 * action, and the host's rule could let him. The owner may cancel any; anyone else only what an agent
 * promised for itself, or a proposal it made. Whose promise it is, the host decides: it is the one that
 * knows the address a viewer speaks as.
 */
export function canCancel(commitment: Pick<CommitmentItem, "status" | "party">, viewer: Pick<Viewer, "owner" | "can">): boolean {
  if (!cancellable(commitment.status) || !viewer.can(cancelAction)) return false;
  return viewer.owner || commitment.party === "self" || commitment.status === "proposed";
}
