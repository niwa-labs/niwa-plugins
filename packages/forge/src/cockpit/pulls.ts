/** What the forge page makes of the pull requests, their pipelines and the merges the server holds for later. */

import type { WorkState } from "@niwa-labs/ui-kit";

import { cancelMergeAction } from "./actions.ts";
import type { ChecksState, ObservedPr, PendingMerge, PipelineKind, PrPipeline, PrRef, Repo, RunState } from "./actions.ts";

/** A pull request as the server names it: `acme/billing!7`. */
export function prLabel(pr: PrRef): string {
  return `${pr.repo.path}!${String(pr.number)}`;
}

/** One text for one pull request: projects are told apart by their id, which a rename keeps. */
export function prKey(pr: PrRef): string {
  return `${pr.repo.host}/${String(pr.repo.projectId)}!${String(pr.number)}`;
}

export function repoLabel(repo: Pick<Repo, "host" | "path">): string {
  return `${repo.host}/${repo.path}`;
}

export const CHECKS_RING: Readonly<Record<ChecksState, WorkState>> = { none: "pending", pending: "running", green: "done", red: "failed" };

export const CHECKS_LABEL: Readonly<Record<ChecksState, string>> = { none: "Нет проверок", pending: "Проверки идут", green: "Проверки пройдены", red: "Проверки не пройдены" };

export const PIPELINE_RING: Readonly<Record<RunState, WorkState>> = {
  created: "pending",
  waiting_for_resource: "waiting",
  preparing: "running",
  pending: "pending",
  running: "running",
  success: "done",
  failed: "failed",
  canceled: "stopped",
  skipped: "skipped",
  manual: "waiting",
  scheduled: "pending",
};

export const PR_STATUS: Readonly<Record<ObservedPr["state"], string>> = {
  open: "Открыт",
  merged: "Слит",
  closed: "Закрыт",
};

export const PIPELINE_STATUS: Readonly<Record<RunState, string>> = {
  created: "Создан",
  waiting_for_resource: "Ждёт ресурса",
  preparing: "Подготовка",
  pending: "В очереди",
  running: "Выполняется",
  success: "Успешно",
  failed: "Ошибка",
  canceled: "Отменён",
  skipped: "Пропущен",
  manual: "Ждёт ручного запуска",
  scheduled: "Запланирован",
};

const KIND_LABEL: Readonly<Record<PipelineKind, string>> = {
  head: "коммит",
  "merge-result": "результат слияния",
  train: "очередь слияния",
  branch: "ветка",
  tag: "тег",
  schedule: "по расписанию",
};

const short = (sha: string): string => sha.slice(0, 8);

/** A pipeline in a line: its number, what it ran on, and for a merge result the pair of commits it was made of. */
export function pipelineText(pipeline: PrPipeline): string {
  const what = KIND_LABEL[pipeline.kind];
  const pair = pipeline.targetSha === undefined ? short(pipeline.sourceSha) : `${short(pipeline.sourceSha)} → ${short(pipeline.targetSha)}`;
  return `#${String(pipeline.pipeline)} ${what} ${pair}`;
}

/** The merges the server holds, by the pull request they are for. */
export function armedBy(pending: readonly PendingMerge[]): Map<string, PendingMerge> {
  return new Map(pending.map((one) => [prKey(one.pr), one]));
}

export const MODE_LABEL: Readonly<Record<PendingMerge["mode"], string>> = { "auto-merge": "Слияние после успешных проверок", train: "В очереди слияния" };

/**
 * What cancelling a merge sends: the input the host gave with it, as it is, and only when the action it names is the one
 * the page knows how to call. A merge held by another action is shown, not cancelled from here.
 */
export function cancelInput(pending: PendingMerge): { repo: { host: string; path: string }; number: number } | undefined {
  return pending.cancel.action === cancelMergeAction.name ? pending.cancel.input : undefined;
}

/** The pull requests by repository, in the order they came, and each repository where its first pull request stands. */
export function byRepo(prs: readonly ObservedPr[]): Array<{ repo: Repo; prs: ObservedPr[] }> {
  const groups = new Map<string, { repo: Repo; prs: ObservedPr[] }>();
  for (const one of prs) {
    const key = `${one.pr.repo.host}/${String(one.pr.repo.projectId)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { repo: one.pr.repo, prs: [one] });
    else group.prs.push(one);
  }
  return [...groups.values()];
}
