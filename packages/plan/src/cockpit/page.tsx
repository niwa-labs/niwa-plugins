/** The plans of the host, one at a time with its items, and a look at what any revision changed. */

import { PageLink, pathFor, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { Badge, StateRing } from "@niwa-labs/ui-kit";

import { getAction, listAction, type PlanSummary, type PlanView } from "./actions.ts";
import { ITEM_LABEL, ITEM_RING, changeText, changesBetween, plansInOrder, progressOf, revisionOf, type ItemChange } from "./revisions.ts";

const REFRESH = { refreshOn: { types: ["plan.revised"] } };

function planPath(of: string, rev?: number): string {
  return pathFor("/plans", {}, { of, rev: rev === undefined ? undefined : String(rev) });
}

function PlanRow({ plan, selected }: { plan: PlanSummary; selected: boolean }) {
  return (
    <li data-slot="plan-row" data-selected={selected} className={selected ? "flex min-w-0 items-center gap-3 bg-muted/40 py-2" : "flex min-w-0 items-center gap-3 py-2"}>
      <PageLink to={planPath(plan.of)} className="min-w-0 truncate text-sm font-medium hover:underline">
        {plan.of}
      </PageLink>
      {plan.goal === undefined ? null : <span className="min-w-0 truncate text-xs text-muted-foreground">{plan.goal}</span>}
      {plan.open > 0 ? <Badge variant="secondary">{plan.open} to decide</Badge> : null}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {plan.items} items · revision {plan.rev}
      </span>
    </li>
  );
}

function ItemRow({ change }: { change: ItemChange }) {
  const { item } = change;
  return (
    <li data-slot="plan-item" data-change={change.kind} data-state={item.state} className="flex min-w-0 items-start gap-3 py-2">
      <StateRing state={ITEM_RING[item.state]} label={ITEM_LABEL[item.state]} />
      <div className="flex min-w-0 flex-col">
        <span className={change.kind === "removed" ? "text-sm line-through" : "text-sm"}>{item.text}</span>
        {item.note === undefined ? null : <span className="text-xs text-muted-foreground">{item.note}</span>}
      </div>
      {change.kind === "same" ? null : (
        <Badge className="ml-auto shrink-0" variant={change.kind === "removed" ? "destructive" : "secondary"}>
          {change.kind === "changed" ? changeText(change) : change.kind}
        </Badge>
      )}
    </li>
  );
}

function PlanDetail({ of, asked }: { of: string; asked: string | undefined }) {
  const latest = useCall(getAction, { of }, REFRESH);
  const rev = latest.data === undefined ? undefined : (revisionOf(asked, latest.data.revisions) ?? latest.data.rev);
  const shown = useCall(getAction, { of, rev }, { ...REFRESH, enabled: rev !== undefined && rev !== latest.data?.rev });
  const earlier = useCall(getAction, { of, rev: rev === undefined ? undefined : rev - 1 }, { ...REFRESH, enabled: rev !== undefined && rev > 1 });
  if (latest.isPending) return <p className="text-sm text-muted-foreground">Loading the plan…</p>;
  if (latest.isError) return <p role="alert" className="text-sm text-destructive">The plan could not be read: {latest.error.message}</p>;
  const plan: PlanView | undefined = rev === latest.data.rev ? latest.data : shown.data;
  if (plan === undefined) return <p className="text-sm text-muted-foreground">Loading the revision…</p>;
  const progress = progressOf(plan.items);
  const changes = plan.rev > 1 && earlier.data !== undefined ? changesBetween(earlier.data.items, plan.items) : plan.items.map((item): ItemChange => ({ kind: "same", item }));
  return (
    <article data-slot="plan-page" className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 flex-col gap-1">
        <h3 className="truncate text-base font-semibold">{plan.of}</h3>
        {plan.goal === undefined ? null : <p className="text-sm">{plan.goal}</p>}
        <p className="text-xs text-muted-foreground">
          {progress.done} of {progress.total} done
          {progress.counts.open > 0 ? ` · ${String(progress.counts.open)} decisions ahead` : ""}
          {progress.counts.dropped > 0 ? ` · ${String(progress.counts.dropped)} dropped` : ""}
        </p>
      </header>
      <nav data-slot="plan-revisions" className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-muted-foreground">Revision</span>
        {Array.from({ length: plan.revisions }, (_, index) => index + 1).map((number) => (
          <PageLink key={number} to={planPath(plan.of, number)} className={number === plan.rev ? "rounded bg-muted px-1.5 py-0.5 font-semibold" : "rounded px-1.5 py-0.5 hover:bg-muted"}>
            {number}
          </PageLink>
        ))}
        <span className="ml-2 text-muted-foreground">written {new Date(plan.at).toLocaleString()}</span>
      </nav>
      {plan.rev > 1 && earlier.isError ? <p role="alert" className="text-xs text-destructive">The revision before could not be read: {earlier.error.message}</p> : null}
      <ul data-slot="plan-items" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
        {changes.map((change) => (
          <ItemRow key={`${change.kind}/${change.item.id}`} change={change} />
        ))}
      </ul>
    </article>
  );
}

export function PlansPage({ search }: PageProps<"/plans">) {
  const plans = useCall(listAction, {}, REFRESH);
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Plans</h2>
      {plans.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the plans…</p>
      ) : plans.isError ? (
        <p role="alert" className="text-sm text-destructive">The plans could not be read: {plans.error.message}</p>
      ) : plans.data.plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plans yet.</p>
      ) : (
        <ul data-slot="plans" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
          {plansInOrder(plans.data.plans).map((plan) => (
            <PlanRow key={plan.of} plan={plan} selected={plan.of === search["of"]} />
          ))}
        </ul>
      )}
      {search["of"] === undefined ? null : <PlanDetail key={search["of"]} of={search["of"]} asked={search["rev"]} />}
    </div>
  );
}
