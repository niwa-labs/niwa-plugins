/** The plans of the host, one at a time with its items, and a look at what any revision changed. */

import { PageLink, pathFor, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { CopyValue, StateRing } from "@niwa-labs/ui-kit";

import { getAction, listAction, type PlanSummary, type PlanView } from "./actions.ts";
import { ITEM_LABEL, ITEM_RING, changeText, changesBetween, plansInOrder, progressOf, revisionOf, type ItemChange } from "./revisions.ts";

const REFRESH = { refreshOn: { types: ["plan.revised"] } };

function planPath(of: string, rev?: number): string {
  return pathFor("/plans", {}, { of, rev: rev === undefined ? undefined : String(rev) });
}

function PlanRow({ plan, selected }: { plan: PlanSummary; selected: boolean }) {
  return (
    <li data-slot="plan-row" data-selected={selected} className="min-w-0">
      <PageLink to={planPath(plan.of)} className={selected ? "block bg-muted/60 px-3 py-2 hover:underline" : "block px-3 py-2 hover:bg-muted/40 hover:underline"}>
        <span className="block break-words text-sm font-medium">{plan.goal || plan.of}</span>
        <span className="desk-tools text-xs text-muted-foreground">
          <span>Пунктов {plan.items}</span>
          {plan.open > 0 ? <span>Ждут решения {plan.open}</span> : null}
          <span>Версия {plan.rev}</span>
        </span>
      </PageLink>
    </li>
  );
}

function ItemRow({ change }: { change: ItemChange }) {
  const { item } = change;
  return (
    <li data-slot="plan-item" data-change={change.kind} data-state={item.state} className="flex min-w-0 items-start gap-3 py-2">
      <StateRing state={ITEM_RING[item.state]} label={ITEM_LABEL[item.state]} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={change.kind === "removed" ? "text-sm line-through" : "text-sm"}>{item.text}</span>
        <span className="text-xs text-muted-foreground">{ITEM_LABEL[item.state]}</span>
        {item.note === undefined ? null : <span className="text-xs text-muted-foreground">{item.note}</span>}
        {change.kind === "same" ? null : (
          <span className="text-xs text-muted-foreground">
            {change.kind === "changed" ? changeText(change) : change.kind === "added" ? "Добавлен в этой версии" : "Удалён в этой версии"}
          </span>
        )}
      </div>
    </li>
  );
}

function PlanDetail({ of, asked }: { of: string; asked: string | undefined }) {
  const latest = useCall(getAction, { of }, REFRESH);
  const rev = latest.data === undefined ? undefined : (revisionOf(asked, latest.data.revisions) ?? latest.data.rev);
  const shown = useCall(getAction, { of, rev }, { ...REFRESH, enabled: rev !== undefined && rev !== latest.data?.rev });
  const earlier = useCall(getAction, { of, rev: rev === undefined ? undefined : rev - 1 }, { ...REFRESH, enabled: rev !== undefined && rev > 1 });
  if (latest.isPending) return <p className="text-sm text-muted-foreground">Загружаем план…</p>;
  if (latest.isError) return <p role="alert" className="text-sm text-destructive">Не удалось загрузить план. {latest.error.message}</p>;
  const plan: PlanView | undefined = rev === latest.data.rev ? latest.data : shown.data;
  if (plan === undefined && shown.isError) return <p role="alert" className="text-sm text-destructive">Не удалось загрузить версию. {shown.error.message}</p>;
  if (plan === undefined) return <p className="text-sm text-muted-foreground">Загружаем версию…</p>;
  const progress = progressOf(plan.items);
  const changes = plan.rev > 1 && earlier.data !== undefined ? changesBetween(earlier.data.items, plan.items) : plan.items.map((item): ItemChange => ({ kind: "same", item }));
  return (
    <article data-slot="plan-page" className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col gap-1">
        <h3 className="break-words text-base font-semibold">{plan.goal || "План"}</h3>
        <div className="text-xs"><CopyValue value={plan.of} /></div>
        <p className="text-xs text-muted-foreground">
          Выполнено {progress.done} из {progress.total}
          {progress.counts.open > 0 ? ` · Ждут решения ${String(progress.counts.open)}` : ""}
          {progress.counts.dropped > 0 ? ` · Снято ${String(progress.counts.dropped)}` : ""}
        </p>
        {progress.total > 0 ? (
          <div role="progressbar" aria-label="Ход выполнения плана" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}
            style={{ height: "0.4rem", width: "min(100%, 16rem)", background: "var(--muted)", borderRadius: "0.25rem", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(progress.done / progress.total) * 100}%`, background: "var(--state-done)" }} />
          </div>
        ) : null}
      </header>
      {plan.rev > 1 && earlier.isError ? <p role="alert" className="text-xs text-destructive">Не удалось сравнить с предыдущей версией. {earlier.error.message}</p> : null}
      {changes.length === 0 ? <p className="text-sm text-muted-foreground">В этой версии пока нет пунктов.</p> : <ul data-slot="plan-items" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
        {changes.map((change) => (
          <ItemRow key={`${change.kind}/${change.item.id}`} change={change} />
        ))}
      </ul>}
      <details data-slot="plan-revisions" className="space-y-1 text-xs">
        <summary className="cursor-pointer font-medium">Версия {plan.rev} из {plan.revisions} · {new Date(plan.at).toLocaleString("ru")}</summary>
        <nav aria-label="Версии плана" className="flex flex-wrap items-center gap-1">
          {Array.from({ length: plan.revisions }, (_, index) => index + 1).map((number) => (
            <PageLink key={number} to={planPath(plan.of, number)} className={number === plan.rev ? "rounded bg-muted px-1.5 py-0.5 font-semibold" : "rounded px-1.5 py-0.5 hover:bg-muted"}>
              {number}
            </PageLink>
          ))}
        </nav>
      </details>
    </article>
  );
}

export function PlansPage({ search }: PageProps<"/plans">) {
  const plans = useCall(listAction, {}, REFRESH);
  const ordered = plansInOrder(plans.data?.plans ?? []);
  const selected = search["of"] ?? ordered[0]?.of;
  const requestedRevision = search["of"] === undefined ? undefined : search["rev"];
  return (
    <div className="desk-page">
      {plans.isPending ? (
        <p className="text-sm text-muted-foreground">Загружаем планы…</p>
      ) : plans.isError ? (
        <p role="alert" className="text-sm text-destructive">Не удалось загрузить планы. {plans.error.message}</p>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Планов пока нет. Составьте план, чтобы отслеживать его выполнение.</p>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-4">
          <nav aria-label="Список планов" className="min-w-0" style={{ flex: "1 1 12rem" }}>
            <ul data-slot="plans" className="divide-y overflow-hidden rounded-lg border bg-card">
              {ordered.map((plan) => <PlanRow key={plan.of} plan={plan} selected={plan.of === selected} />)}
            </ul>
          </nav>
          {selected === undefined ? null : (
            <div className="min-w-0" style={{ flex: "3 1 24rem" }}>
              <PlanDetail key={selected} of={selected} asked={requestedRevision} />
            </div>
          )}
        </div>
      )}
      {ordered.length === 0 && search["of"] !== undefined ? <PlanDetail key={search["of"]} of={search["of"]} asked={requestedRevision} /> : null}
    </div>
  );
}
