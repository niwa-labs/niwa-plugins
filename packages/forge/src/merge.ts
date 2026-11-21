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
import type { ActionContext, CheckResult, JournalReader, OperationId, RecordType } from "@niwa-labs/core";

import { forgePrMergeCancel } from "./actions.ts";
import type { MergeOutcome, PendingMerge } from "./actions.ts";
import { ForgeError } from "./gitlab.ts";
import type { GitLab } from "./gitlab.ts";
import { finalShaOf } from "./normalize.ts";
import type { GitLabMr } from "./normalize.ts";
import { MergeArmed, MergeDisarmed, MergeRequested, MergeSettled, PrClosed, PrMerged } from "./record-types.ts";
import type { MergeMethod, MergeWhen, PrRef, Repo } from "./record-types.ts";
import { projectPath } from "./servers.ts";

/** The server's own name of a merge request: `<host>/<path>!<n>`. */
export function externalIdOf(pr: PrRef): string {
  return `${pr.repo.host}/${pr.repo.path}!${String(pr.number)}`;
}

/** The statuses a server refuses a merge with: not mergeable, a head that moved, nothing to do. */
const REFUSALS = new Set([405, 406, 409, 422]);

/** The commit a merged pull request left on its base; the head it was merged at when the server names none. */
function mergedSha(mr: GitLabMr, expectHead: string): string {
  return finalShaOf(mr) ?? expectHead;
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
  for (const stored of journal.since(seq(0), [MergeArmed.name, MergeDisarmed.name, MergeSettled.name, PrMerged.name, PrClosed.name])) {
    if (stored.type === MergeArmed.name) {
      const parsed = MergeArmed.schema.safeParse(stored.data);
      if (!parsed.success) continue;
      const { pr, mode, externalId, expectHead } = parsed.data;
      const input = { repo: { host: pr.repo.host, path: pr.repo.path }, number: pr.number };
      pending.set(externalId, { pr, mode, externalId, expectHead, cancel: { action: forgePrMergeCancel.name, input } });
      continue;
    }
    const ended = stored.type === MergeDisarmed.name ? MergeDisarmed : stored.type === MergeSettled.name ? MergeSettled : stored.type === PrMerged.name ? PrMerged : PrClosed;
    const parsed = ended.schema.safeParse(stored.data);
    if (parsed.success) pending.delete(externalIdOf(parsed.data.pr));
  }
  return [...pending.values()];
}

/** Whether a pull request has a place in the merge train. */
export async function inTrain(gitlab: GitLab, pr: PrRef): Promise<boolean> {
  try {
    await gitlab.get(projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`));
    return true;
  } catch (error) {
    if (error instanceof ForgeError && error.code === "not-found") return false;
    throw error;
  }
}

/** Whether an answer to a cancel says the server did not do it: a refusal in the body of a success. */
function refusedInBody(answer: unknown): boolean {
  return typeof answer === "object" && answer !== null && (answer as { status?: unknown }).status === "error";
}

/**
 * Call off a merge the server took for later: the automatic merge, or the place in the train. The
 * answer of the cancel is not taken for the outcome, for a server may answer a success status over a
 * refusal: the pull request is read back, and the merge is dropped from the pending ones only when it
 * is open and neither armed nor in the train, or no longer a merge to wait for. Merged, it is not
 * called off: the server made it.
 */
export async function cancelMerge(gitlab: GitLab, pr: PrRef, journal: JournalReader | undefined, emit: (data: { pr: PrRef; externalId: string }) => Promise<unknown>): Promise<boolean> {
  const externalId = externalIdOf(pr);
  const known = pendingMerges(journal).find((one) => one.externalId === externalId);
  const mrPath = projectPath(pr.repo, `/merge_requests/${String(pr.number)}`);
  const tries: Array<{ mode: "auto-merge" | "train"; call: () => Promise<unknown> }> = [
    { mode: "auto-merge", call: () => gitlab.send("POST", `${mrPath}/cancel_merge_when_pipeline_succeeds`) },
    { mode: "train", call: () => gitlab.send("DELETE", projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`)) },
  ];
  if (known?.mode === "train") tries.reverse();
  let answeredBy: "auto-merge" | "train" | undefined;
  for (const attempt of tries) {
    try {
      if (!refusedInBody(await attempt.call())) {
        answeredBy = attempt.mode;
        break;
      }
    } catch (error) {
      // Nothing to call off on this side: the other one may have it.
      if (!(error instanceof ForgeError) || (error.code !== "not-found" && error.status !== 406 && error.status !== 405)) throw error;
    }
  }
  const asked = answeredBy !== undefined;
  const mr = await gitlab.get<GitLabMr>(mrPath);
  if (mr.state === "merged") return false;
  // The train is asked about only where the merge was in one: merge trains are not on every server.
  const trained = known?.mode === "train" || answeredBy === "train";
  const armed = mr.state === "opened" && (mr.merge_when_pipeline_succeeds === true || (trained && (await inTrain(gitlab, pr))));
  if (armed) return false;
  if (asked || known !== undefined) await emit({ pr, externalId });
  return asked;
}

/** How a record is written for the merges: a record of the module's own type under an id of its own. */
export type MergeWriter = <T>(type: RecordType<T>, data: T, id: string) => Promise<void>;

/**
 * Settle the merges listed as pending on one repository against the server, one read of each pull
 * request: merged or closed there, it is settled; open and no longer armed or in the train, it is
 * disarmed; open and armed, it stays pending. A pull request the server no longer has is left.
 * Pending merges are watched for this whether or not their repository is.
 */
export async function settleMerges(place: { gitlab: GitLab; journal: JournalReader; write: MergeWriter }, repo: Repo): Promise<void> {
  const { gitlab, journal } = place;
  for (const one of pendingMerges(journal)) {
    if (one.pr.repo.host !== repo.host || one.pr.repo.projectId !== repo.projectId) continue;
    let mr: GitLabMr;
    try {
      mr = await gitlab.get<GitLabMr>(projectPath(repo, `/merge_requests/${String(one.pr.number)}`));
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not-found") continue;
      throw error;
    }
    // How many times this merge was armed: a merge armed again after being called off is a new one.
    const armings = journal
      .since(seq(0), [MergeArmed.name])
      .filter((stored) => MergeArmed.schema.safeParse(stored.data).data?.externalId === one.externalId).length;
    const id = (what: string) => `forge:${repo.host}:${String(repo.projectId)}:pr:${String(one.pr.number)}:${what}:${String(armings)}`;
    if (mr.state === "merged" || mr.state === "closed") {
      const mergeSha = mr.state === "merged" ? finalShaOf(mr) : undefined;
      await place.write(MergeSettled, { pr: one.pr, externalId: one.externalId, outcome: mr.state, ...(mergeSha === undefined ? {} : { mergeSha }) }, id("settled"));
      continue;
    }
    if (mr.state !== "opened") continue;
    const dropped = one.mode === "auto-merge" ? mr.merge_when_pipeline_succeeds !== true : !(await inTrain(gitlab, one.pr));
    if (dropped) await place.write(MergeDisarmed, { pr: one.pr, externalId: one.externalId }, id("disarmed"));
  }
}
