/** The commitments of the host, one card each: what was promised, by when, where it stands, and a cancel. */

import { useAction, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import { Button, CopyValue, StateRing } from "@niwa-labs/ui-kit";

import { cancelAction, listAction, type CommitmentItem } from "./actions.ts";
import { RING, STATUS_LABEL, canCancel, commitmentsByStatus } from "./cards.ts";

function CommitmentCard({ commitment }: { commitment: CommitmentItem }) {
  const cancel = useAction(cancelAction);
  const viewer = useViewer();
  return (
    <li data-slot="commitment-card" data-status={commitment.status} className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", gap: "0.3rem 0.75rem", paddingBlock: "0.6rem" }}>
      <StateRing state={RING[commitment.status]} label={STATUS_LABEL[commitment.status]} />
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">{commitment.description}</p>
          <p className="desk-tools mt-1 text-xs text-muted-foreground">
            <span>{STATUS_LABEL[commitment.status]}</span>
            <span>Получатель {commitment.to}</span>
            {commitment.due === undefined ? <span>Без срока</span> : <time dateTime={new Date(commitment.due).toISOString()}>До {new Date(commitment.due).toLocaleString("ru")}</time>}
            {commitment.party === "owner" ? <span>От имени владельца</span> : null}
          </p>
        </div>
        {canCancel(commitment, viewer) ? (
          <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: commitment.id })}>
            Отменить
          </Button>
        ) : null}
      </div>
      <div className="desk-tools min-w-0 text-xs text-muted-foreground" style={{ gridColumn: 2 }}>
        <span>Автор {commitment.by.kind === "owner" ? "владелец" : [commitment.by.harness, commitment.by.id].filter(Boolean).join("/") || commitment.by.kind}</span>
        <CopyValue value={commitment.id} />
        {cancel.isError ? <span role="alert" className="text-destructive">{cancel.error.message}</span> : null}
      </div>
    </li>
  );
}

export function CommitmentsPage() {
  const commitments = useCall(listAction, {}, { refreshOn: { types: ["commitment.*"] } });
  const { open, history } = commitmentsByStatus(commitments.data?.items ?? []);
  const list = (items: CommitmentItem[]) => (
    <ul data-slot="commitments" className="divide-y rounded-lg border bg-card px-3">
      {items.map((commitment) => <CommitmentCard key={commitment.id} commitment={commitment} />)}
    </ul>
  );
  return (
    <div className="desk-page">
      {commitments.isPending ? (
        <p className="text-sm text-muted-foreground">Загружаем обязательства…</p>
      ) : commitments.isError ? (
        <p role="alert" className="text-sm text-destructive">Не удалось загрузить обязательства. {commitments.error.message}</p>
      ) : (
        <>
          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-semibold">Открытые обязательства</h3>
            {open.length ? list(open) : <p className="text-sm text-muted-foreground">Открытых обязательств нет.</p>}
          </section>
          {history.length ? <details className="flex min-w-0 flex-col gap-2">
            <summary className="cursor-pointer text-sm font-medium">Завершённые обязательства ({history.length})</summary>
            {list(history)}
          </details> : null}
        </>
      )}
    </div>
  );
}
