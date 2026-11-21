/**
 * Merging a pull request: the one forge action that cannot be taken back.
 *
 * The merge is asked with the head the caller expects, so a head that moved is refused by the server
 * and not merged blind. A merge the server takes for later (an automatic merge when the pipeline
 * succeeds, a place in a merge train) is recorded as armed, with the server's id and the action that
 * calls it off: niwa cannot hold back what the server already has, so it shows it instead.
 *
 * Before the request leaves, `forge.pr.merge.requested` is written with the operation. A call that was
 * cut off is checked against it: without it the request was never sent; with it, the pull request is
 * read back from the server and says what happened.
 */

import { seq } from "@niwa-labs/core";
import type { ActionContext, CheckResult, JournalReader, OperationId } from "@niwa-labs/core";

import { forgePrMergeCancel } from "./actions.ts";
import type { MergeOutcome, PendingMerge } from "./actions.ts";
import { ForgeError } from "./gitlab.ts";
import type { GitLab } from "./gitlab.ts";
import type { GitLabMr } from "./normalize.ts";
import { MergeArmed, MergeDisarmed, MergeRequested, PrClosed, PrMerged } from "./record-types.ts";
import type { MergeMethod, MergeWhen, PrRef } from "./record-types.ts";
import { projectPath } from "./servers.ts";

/** The server's own name of a merge request: `<host>/<path>!<n>`. */
export function externalIdOf(pr: PrRef): string {
  return `${pr.repo.host}/${pr.repo.path}!${String(pr.number)}`;
}

/** The statuses a server refuses a merge with: not mergeable, a head that moved, nothing to do. */
const REFUSALS = new Set([405, 406, 409, 422]);

/** The commit a merged pull request left on its base. */
function mergedSha(mr: GitLabMr, expectHead: string): string {
  return mr.squash_commit_sha ?? mr.merge_commit_sha ?? expectHead;
}

export interface MergeAsk {
  readonly pr: PrRef;
  readonly expectHead: string;
  readonly method: MergeMethod;
  readonly when: MergeWhen;
}

/** Ask the server to merge, and say how it went. */
export async function merge(gitlab: GitLab, ask: MergeAsk, ctx: Pick<ActionContext, "emit" | "operationId">): Promise<MergeOutcome> {
  const { pr, expectHead, method, when } = ask;
  const externalId = externalIdOf(pr);
  await ctx.emit(MergeRequested, { operation: ctx.operationId, pr, expectHead, method, when });
  const mrPath = projectPath(pr.repo, `/merge_requests/${String(pr.number)}`);
  try {
    if (when === "train") {
      await gitlab.send("POST", projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`), {
        sha: expectHead,
        squash: method === "squash",
      });
      await ctx.emit(MergeArmed, { pr, mode: "train", externalId, expectHead });
      return { outcome: "queued", externalId, cancel: forgePrMergeCancel.name };
    }
    const mr = await gitlab.send<GitLabMr>("PUT", `${mrPath}/merge`, {
      sha: expectHead,
      squash: method === "squash",
      ...(when === "pipeline" ? { merge_when_pipeline_succeeds: true } : {}),
    });
    if (mr.state === "merged") return { outcome: "merged", sha: mergedSha(mr, expectHead), externalId };
    if (mr.merge_when_pipeline_succeeds === true) {
      await ctx.emit(MergeArmed, { pr, mode: "auto-merge", externalId, expectHead });
      return { outcome: "armed", externalId, cancel: forgePrMergeCancel.name };
    }
    return { outcome: "refused", why: `the server answered the merge with a pull request that is ${mr.state} and not merged` };
  } catch (error) {
    if (error instanceof ForgeError && error.status !== undefined && REFUSALS.has(error.status)) return { outcome: "refused", why: error.message };
    throw error;
  }
}

/** What the module needs to check a merge that was cut off. */
export interface CheckPlace {
  readonly journal: () => JournalReader | undefined;
  readonly gitlab: (host: string) => GitLab;
  /** Write a record of the module's own, for what a check finds and nothing recorded. */
  readonly emit: (data: { pr: PrRef; mode: "auto-merge" | "train"; externalId: string; expectHead: string }, id: string) => Promise<unknown>;
}

/** What happened to a merge that was cut off. */
export async function checkMerge(place: CheckPlace, operationId: OperationId): Promise<CheckResult<MergeOutcome>> {
  const journal = place.journal();
  if (journal === undefined) return { status: "unknown" };
  const requested = journal
    .since(seq(0), [MergeRequested.name])
    .map((stored) => MergeRequested.schema.safeParse(stored.data))
    .find((parsed) => parsed.success && parsed.data.operation === operationId);
  if (requested === undefined || !requested.success) return { status: "failed", error: "the merge was never asked of the server" };
  const { pr, expectHead, when } = requested.data;
  const gitlab = place.gitlab(pr.repo.host);
  const externalId = externalIdOf(pr);
  const mr = await gitlab.get<GitLabMr>(projectPath(pr.repo, `/merge_requests/${String(pr.number)}`));
  if (mr.state === "merged") {
    if (mr.sha !== expectHead) return { status: "failed", error: `the pull request was merged at ${mr.sha}, not at the head ${expectHead} this merge expected` };
    return { status: "completed", value: { outcome: "merged", sha: mergedSha(mr, expectHead), externalId } };
  }
  if (mr.state !== "opened" || mr.sha !== expectHead) return { status: "failed", error: `the pull request is ${mr.state} at ${mr.sha} and was not merged` };
  const armed = async (mode: "auto-merge" | "train"): Promise<CheckResult<MergeOutcome>> => {
    if (!pendingMerges(journal).some((one) => one.externalId === externalId && one.expectHead === expectHead)) {
      await place.emit({ pr, mode, externalId, expectHead }, `forge:merge-armed:${operationId}`);
    }
    const outcome = mode === "train" ? "queued" : "armed";
    return { status: "completed", value: { outcome, externalId, cancel: forgePrMergeCancel.name } };
  };
  if (when === "pipeline" && mr.merge_when_pipeline_succeeds === true) return await armed("auto-merge");
  if (when === "train") {
    const inTrain = await gitlab
      .get(projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`))
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof ForgeError && error.code === "not-found") return false;
        throw error;
      });
    if (inTrain) return await armed("train");
  }
  return { status: "failed", error: "the pull request is still open and nothing will merge it" };
}

/**
 * The merges the server took for later and has not made or dropped yet: armed, and neither called
 * off nor followed by a merge or a close of the pull request.
 */
export function pendingMerges(journal: JournalReader | undefined): PendingMerge[] {
  if (journal === undefined) return [];
  const pending = new Map<string, PendingMerge>();
  for (const stored of journal.since(seq(0), [MergeArmed.name, MergeDisarmed.name, PrMerged.name, PrClosed.name])) {
    if (stored.type === MergeArmed.name) {
      const parsed = MergeArmed.schema.safeParse(stored.data);
      if (!parsed.success) continue;
      const { pr, mode, externalId, expectHead } = parsed.data;
      const input = { repo: { host: pr.repo.host, path: pr.repo.path }, number: pr.number };
      pending.set(externalId, { pr, mode, externalId, expectHead, cancel: { action: forgePrMergeCancel.name, input } });
      continue;
    }
    const parsed = (stored.type === MergeDisarmed.name ? MergeDisarmed : stored.type === PrMerged.name ? PrMerged : PrClosed).schema.safeParse(stored.data);
    if (parsed.success) pending.delete(externalIdOf(parsed.data.pr));
  }
  return [...pending.values()];
}

/** Call off a merge the server took for later: the automatic merge, or the place in the train. */
export async function cancelMerge(gitlab: GitLab, pr: PrRef, journal: JournalReader | undefined, emit: (data: { pr: PrRef; externalId: string }) => Promise<unknown>): Promise<boolean> {
  const externalId = externalIdOf(pr);
  const known = pendingMerges(journal).find((one) => one.externalId === externalId);
  const tries: Array<() => Promise<unknown>> = [
    () => gitlab.send("POST", projectPath(pr.repo, `/merge_requests/${String(pr.number)}/cancel_merge_when_pipeline_succeeds`)),
    () => gitlab.send("DELETE", projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`)),
  ];
  if (known?.mode === "train") tries.reverse();
  let cancelled = false;
  for (const attempt of tries) {
    try {
      await attempt();
      cancelled = true;
      break;
    } catch (error) {
      // Nothing to call off on this side: the other one may have it.
      if (!(error instanceof ForgeError) || (error.code !== "not-found" && error.status !== 406 && error.status !== 405)) throw error;
    }
  }
  if (cancelled || known !== undefined) await emit({ pr, externalId });
  return cancelled;
}
