/** The commitments of the host, one card each: what was promised, by when, where it stands, and a cancel. */

import { useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { Badge, Button, StateRing } from "@niwa-labs/ui-kit";

import { cancelAction, listAction, type CommitmentItem } from "./actions.ts";
import { RING, cancellable } from "./cards.ts";

function CommitmentCard({ commitment }: { commitment: CommitmentItem }) {
  const cancel = useAction(cancelAction);
  return (
    <li data-slot="commitment-card" data-status={commitment.status} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-card-foreground">
      <StateRing state={RING[commitment.status]} label={commitment.status} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{commitment.description}</span>
        <span className="text-xs text-muted-foreground">
          {commitment.id} · to {commitment.to}
          {commitment.due === undefined ? "" : ` · due ${new Date(commitment.due).toLocaleString()}`}
        </span>
      </div>
      {commitment.party === "owner" ? <Badge variant="secondary">for you</Badge> : null}
      {cancellable(commitment.status) ? (
        <Button className="ml-auto" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: commitment.id })}>
          Cancel
        </Button>
      ) : null}
      {cancel.isError ? <span role="alert" className="text-xs text-destructive">{cancel.error.message}</span> : null}
    </li>
  );
}

export function CommitmentsPage() {
  const commitments = useCall(listAction, {}, { refreshOn: { types: ["commitment.*"] } });
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Commitments</h2>
      {commitments.isPending ? (
        <p className="text-sm text-muted-foreground">Loading commitments…</p>
      ) : commitments.isError ? (
        <p role="alert" className="text-sm text-destructive">The commitments could not be read: {commitments.error.message}</p>
      ) : commitments.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commitments yet.</p>
      ) : (
        <ul data-slot="commitments" className="flex flex-col gap-2">
          {commitments.data.items.map((commitment) => (
            <CommitmentCard key={commitment.id} commitment={commitment} />
          ))}
        </ul>
      )}
    </div>
  );
}
