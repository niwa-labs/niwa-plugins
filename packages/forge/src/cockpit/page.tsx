/** The repositories the forge watches, the merges the server holds for later, and the pull requests with their pipelines. */

import { HostCallError, useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { Button, CopyValue, DataValue, StateRing } from "@niwa-labs/ui-kit";

import { cancelMergeAction, pendingAction, prListAction, repoListAction, repoSyncAction, type ObservedPr, type PendingMerge, type Repo } from "./actions.ts";
import { CHECKS_LABEL, CHECKS_RING, MODE_LABEL, PIPELINE_RING, PIPELINE_STATUS, PR_STATUS, armedBy, byRepo, cancelInput, pipelineText, prKey, prLabel, repoLabel } from "./pulls.ts";

const REFRESH = { refreshOn: { types: ["forge.*"] } };

function errorStatus(error: Error): string {
  if (!(error instanceof HostCallError)) return "Проверьте подключение к хосту.";
  if (error.status === 401 || error.status === 403) return "Доступ ограничен.";
  return `Код ответа ${error.status}.`;
}

function RepoRow({ repo }: { repo: Repo }) {
  const sync = useAction(repoSyncAction);
  return (
    <li data-slot="repo-row" className="flex min-w-0 flex-wrap items-center gap-3 py-2">
      <DataValue value={repoLabel(repo)} />
      <Button className="ml-auto" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate({ repo: { host: repo.host, path: repo.path } })}>
        Синхронизировать
      </Button>
      {sync.isError ? <span role="alert" className="text-xs text-destructive">Не удалось синхронизировать репозиторий. {errorStatus(sync.error)}</span> : null}
      {sync.data === undefined ? null : <span className="text-xs text-muted-foreground">{sync.data.written} записей обновлено</span>}
    </li>
  );
}

function ArmedCard({ pending, title }: { pending: PendingMerge; title: string | undefined }) {
  const cancel = useAction(cancelMergeAction);
  const input = cancelInput(pending);
  return (
    <li data-slot="armed-merge" data-mode={pending.mode} className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", columnGap: "0.75rem", paddingBlock: "0.6rem" }}>
      <StateRing state="waiting" label="Слияние отложено" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="break-words text-sm font-medium">
          {prLabel(pending.pr)}
          {title === undefined ? "" : ` · ${title}`}
        </span>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{MODE_LABEL[pending.mode]} <CopyValue value={pending.expectHead} label={`Коммит ${pending.expectHead.slice(0, 8)}`} /></p>
        {input === undefined ? (
          <span className="text-xs text-muted-foreground">Отмена доступна через другое действие</span>
        ) : (
          <div>
            <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(input)}>
              Отменить слияние
            </Button>
          </div>
        )}
        {cancel.isError ? <span role="alert" className="text-xs text-destructive">Не удалось отменить слияние. {errorStatus(cancel.error)}</span> : null}
        {cancel.data?.cancelled === false ? <span role="status" className="text-xs text-muted-foreground">На сервере уже нет отложенного слияния.</span> : null}
      </div>
    </li>
  );
}

function PrRow({ one, armed }: { one: ObservedPr; armed: PendingMerge | undefined }) {
  return (
    <li data-slot="pr-row" data-state={one.state} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", columnGap: "0.75rem" }}>
        <StateRing state={CHECKS_RING[one.checks]} label={CHECKS_LABEL[one.checks]} />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="break-words text-sm font-medium">{one.title}</p>
          <p className="desk-tools text-xs text-muted-foreground">
            <CopyValue value={prLabel(one.pr)} />
            <span className="break-all">{one.branch} → {one.base}</span>
            <span>{one.draft ? "Черновик" : PR_STATUS[one.state]}</span>
            {armed === undefined ? null : <span>Слияние отложено</span>}
            <span className={one.checks === "red" ? "font-medium text-destructive" : "font-medium text-foreground"}>{CHECKS_LABEL[one.checks]}</span>
          </p>
        </div>
      </div>
      {one.pipelines.length === 0 ? null : (
        <ul data-slot="pipelines" className="ml-6 flex flex-col gap-0.5">
          {one.pipelines.map((pipeline) => (
            <li key={pipeline.pipeline} className="desk-tools text-xs text-muted-foreground">
              <StateRing state={PIPELINE_RING[pipeline.state]} label={PIPELINE_STATUS[pipeline.state]} />
              <span className="font-mono">{pipelineText(pipeline)}</span>
              <span>{PIPELINE_STATUS[pipeline.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Failed({ what, error }: { what: string; error: Error }) {
  return <p role="alert" className="text-sm text-destructive">Не удалось загрузить {what}. {errorStatus(error)}</p>;
}

export function ForgePage() {
  const repos = useCall(repoListAction, {}, REFRESH);
  const pending = useCall(pendingAction, {}, REFRESH);
  const prs = useCall(prListAction, {}, REFRESH);
  const titles = new Map((prs.data?.items ?? []).map((one) => [prKey(one.pr), one.title]));
  const armed = armedBy(pending.data?.items ?? []);
  return (
    <div className="desk-page">
      <section className="flex min-w-0 flex-col gap-2">
        {prs.isPending ? (
          <p className="text-sm text-muted-foreground">Загружаем запросы на слияние…</p>
        ) : prs.isError ? (
          <Failed what="запросы на слияние" error={prs.error} />
        ) : prs.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">В подключённых репозиториях ещё нет наблюдаемых запросов.</p>
        ) : (
          byRepo(prs.data.items).map((group) => (
            <div key={repoLabel(group.repo)} data-slot="repo-prs" className="flex min-w-0 flex-col gap-1">
              <h4 className="text-xs text-muted-foreground"><DataValue value={repoLabel(group.repo)} /></h4>
              <ul className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
                {group.prs.map((one) => (
                  <PrRow key={prKey(one.pr)} one={one} armed={armed.get(prKey(one.pr))} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Отложенные слияния</h3>
        {pending.isPending ? (
          <p className="text-sm text-muted-foreground">Загружаем отложенные слияния…</p>
        ) : pending.isError ? (
          <Failed what="отложенные слияния" error={pending.error} />
        ) : pending.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Отложенных слияний нет.</p>
        ) : (
          <ul data-slot="armed-merges" className="divide-y rounded-lg border bg-card px-3">
            {pending.data.items.map((one) => (
              <ArmedCard key={one.externalId} pending={one} title={titles.get(prKey(one.pr))} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Подключённые репозитории</h3>
        {repos.isPending ? (
          <p className="text-sm text-muted-foreground">Загружаем репозитории…</p>
        ) : repos.isError ? (
          <Failed what="репозитории" error={repos.error} />
        ) : repos.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Подключите репозиторий GitLab, чтобы видеть запросы на слияние и проверки.</p>
        ) : (
          <ul data-slot="repos" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {repos.data.items.map((repo) => (
              <RepoRow key={`${repo.host}/${String(repo.projectId)}`} repo={repo} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
