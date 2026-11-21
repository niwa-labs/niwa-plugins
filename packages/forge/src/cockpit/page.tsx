/** The repositories the forge watches, the merges the server holds for later, and the pull requests with their pipelines. */

import { useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { Badge, Button, StateRing } from "@niwa-labs/ui-kit";

import { cancelMergeAction, pendingAction, prListAction, repoListAction, repoSyncAction, type ObservedPr, type PendingMerge, type Repo } from "./actions.ts";
import { CHECKS_LABEL, CHECKS_RING, MODE_LABEL, PIPELINE_RING, armedBy, byRepo, cancelInput, pipelineText, prKey, prLabel, repoLabel } from "./pulls.ts";

const REFRESH = { refreshOn: { types: ["forge.*"] } };

function RepoRow({ repo }: { repo: Repo }) {
  const sync = useAction(repoSyncAction);
  return (
    <li data-slot="repo-row" className="flex min-w-0 items-center gap-3 py-2">
      <span className="min-w-0 truncate font-mono text-sm">{repoLabel(repo)}</span>
      <Button className="ml-auto" variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate({ repo: { host: repo.host, path: repo.path } })}>
        Sync now
      </Button>
      {sync.isError ? <span role="alert" className="text-xs text-destructive">{sync.error.message}</span> : null}
      {sync.data === undefined ? null : <span className="text-xs text-muted-foreground">{sync.data.written} records written</span>}
    </li>
  );
}

function ArmedCard({ pending, title }: { pending: PendingMerge; title: string | undefined }) {
  const cancel = useAction(cancelMergeAction);
  const input = cancelInput(pending);
  return (
    <li data-slot="armed-merge" data-mode={pending.mode} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-card-foreground">
      <StateRing state="waiting" label="Armed" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">
          {prLabel(pending.pr)}
          {title === undefined ? "" : ` · ${title}`}
        </span>
        <span className="text-xs text-muted-foreground">{MODE_LABEL[pending.mode]}, expecting head {pending.expectHead.slice(0, 8)}</span>
      </div>
      {input === undefined ? (
        <span className="ml-auto text-xs text-muted-foreground">Called off by {pending.cancel.action}</span>
      ) : (
        <Button className="ml-auto" variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(input)}>
          Cancel merge
        </Button>
      )}
      {cancel.isError ? <span role="alert" className="text-xs text-destructive">{cancel.error.message}</span> : null}
      {cancel.data?.cancelled === false ? <span role="status" className="text-xs text-muted-foreground">The server held no merge to call off.</span> : null}
    </li>
  );
}

function PrRow({ one, armed }: { one: ObservedPr; armed: PendingMerge | undefined }) {
  return (
    <li data-slot="pr-row" data-state={one.state} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <StateRing state={CHECKS_RING[one.checks]} label={CHECKS_LABEL[one.checks]} />
        <span className="min-w-0 truncate text-sm font-medium">{one.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">!{one.pr.number} · {one.branch} into {one.base}</span>
        {one.draft ? <Badge variant="outline">Draft</Badge> : null}
        {armed === undefined ? null : <Badge variant="secondary">Merge armed</Badge>}
        <Badge className="ml-auto shrink-0" variant={one.state === "open" ? "default" : "secondary"}>
          {one.state}
        </Badge>
      </div>
      {one.pipelines.length === 0 ? null : (
        <ul data-slot="pipelines" className="ml-6 flex flex-col gap-0.5">
          {one.pipelines.map((pipeline) => (
            <li key={pipeline.pipeline} className="flex items-center gap-2 text-xs text-muted-foreground">
              <StateRing state={PIPELINE_RING[pipeline.state]} label={pipeline.state} />
              <span className="font-mono">{pipelineText(pipeline)}</span>
              <span>{pipeline.state}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Failed({ what, message }: { what: string; message: string }) {
  return <p role="alert" className="text-sm text-destructive">The {what} could not be read: {message}</p>;
}

export function ForgePage() {
  const repos = useCall(repoListAction, {}, REFRESH);
  const pending = useCall(pendingAction, {}, REFRESH);
  const prs = useCall(prListAction, {}, REFRESH);
  const titles = new Map((prs.data?.items ?? []).map((one) => [prKey(one.pr), one.title]));
  const armed = armedBy(pending.data?.items ?? []);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Forge</h2>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Watched repositories</h3>
        {repos.isPending ? (
          <p className="text-sm text-muted-foreground">Loading the repositories…</p>
        ) : repos.isError ? (
          <Failed what="repositories" message={repos.error.message} />
        ) : repos.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repository is watched yet.</p>
        ) : (
          <ul data-slot="repos" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {repos.data.items.map((repo) => (
              <RepoRow key={`${repo.host}/${String(repo.projectId)}`} repo={repo} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Merges held for later</h3>
        {pending.isPending ? (
          <p className="text-sm text-muted-foreground">Loading the merges…</p>
        ) : pending.isError ? (
          <Failed what="merges" message={pending.error.message} />
        ) : pending.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">The server holds no merge for later.</p>
        ) : (
          <ul data-slot="armed-merges" className="flex flex-col gap-2">
            {pending.data.items.map((one) => (
              <ArmedCard key={one.externalId} pending={one} title={titles.get(prKey(one.pr))} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Pull requests</h3>
        {prs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading the pull requests…</p>
        ) : prs.isError ? (
          <Failed what="pull requests" message={prs.error.message} />
        ) : prs.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pull request was observed yet.</p>
        ) : (
          byRepo(prs.data.items).map((group) => (
            <div key={repoLabel(group.repo)} data-slot="repo-prs" className="flex min-w-0 flex-col gap-1">
              <h4 className="truncate font-mono text-xs text-muted-foreground">{repoLabel(group.repo)}</h4>
              <ul className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
                {group.prs.map((one) => (
                  <PrRow key={prKey(one.pr)} one={one} armed={armed.get(prKey(one.pr))} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
