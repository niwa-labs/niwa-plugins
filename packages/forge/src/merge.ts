/**
 * Merging a pull request: the one forge action that cannot be taken back.
 *
 * The merge is asked with the head the caller expects, so a head that moved is refused by the server
 * and not merged blind. A merge the server takes for later (an automatic merge when the pipeline
 * succeeds, a place in a merge train) is recorded as armed, with the server's id and the action that
 * calls it off: niwa cannot hold back what the server already has, so it shows it instead.
 *
 * Before the request leaves, `forge.pr.merge.started` is written with the operation. A call that was
 * cut off is checked against it: without it the request was never sent; with it, the pull request is
 * read back from the server and says what happened.
 */

import { seq } from "@niwa-labs/core";
import type { ActionContext, CheckResult, JournalReader, RecordType } from "@niwa-labs/core";

import { forgePrMergeCancel } from "./actions.ts";
import type { MergeOutcome, PendingMerge } from "./actions.ts";
import { ForgeError } from "./gitlab.ts";
import type { GitLab } from "./gitlab.ts";
import { finalShaOf } from "./normalize.ts";
import type { GitLabMr } from "./normalize.ts";
import { mergeKey, CancelRefused, CancelStarted, MergeRefused, MergeArmed, MergeDisarmed, MergeStarted, MergeSettled } from "./record-types.ts";
import type { MergeMethod, MergeWhen, PrRef, Repo } from "./record-types.ts";
import { projectPath } from "./servers.ts";

/** The server's own name of a merge request: `<host>/<path>!<n>`. */
export function externalIdOf(pr: PrRef): string {
  return `${pr.repo.host}/${pr.repo.path}!${String(pr.number)}`;
}

/** The statuses a server refuses a merge with: not mergeable, a head that moved, nothing to do. */
const REFUSALS = new Set([405, 406, 409, 422]);

/** These failures occur before transmission or explicitly reject the HTTP request. */
function definitelyRejected(error: unknown): error is ForgeError {
  if (!(error instanceof ForgeError)) return false;
  return ["unknown-secret", "unsafe-secret", "rate-limited"].includes(error.code)
    || (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408);
}

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
  await ctx.emit(MergeStarted, { operation: ctx.operationId, pr, expectHead, method, when });
  const operation = ctx.operationId;
  const refused = async (why: string): Promise<MergeOutcome> => {
    await ctx.emit(MergeRefused, { pr, operation, reason: why, terminal: false, failed: false });
    return { outcome: "refused", why };
  };
  const mrPath = projectPath(pr.repo, `/merge_requests/${String(pr.number)}`);
  try {
    if (when === "train") {
      await gitlab.send("POST", projectPath(pr.repo, `/merge_trains/merge_requests/${String(pr.number)}`), {
        sha: expectHead,
        squash: method === "squash",
      });
      await ctx.emit(MergeArmed, { pr, operation, mode: "train", externalId, expectHead });
      return { outcome: "queued", externalId, cancel: forgePrMergeCancel.name };
    }
    const mr = await gitlab.send<GitLabMr>("PUT", `${mrPath}/merge`, {
      sha: expectHead,
      squash: method === "squash",
      ...(when === "pipeline" ? { merge_when_pipeline_succeeds: true } : {}),
    });
    if (mr.state === "merged") {
      const sha = mergedSha(mr, expectHead);
      await ctx.emit(MergeSettled, { pr, operation, externalId, outcome: "merged", mergeSha: sha });
      return { outcome: "merged", sha, externalId };
    }
    if (mr.merge_when_pipeline_succeeds === true) {
      await ctx.emit(MergeArmed, { pr, operation, mode: "auto-merge", externalId, expectHead });
      return { outcome: "armed", externalId, cancel: forgePrMergeCancel.name };
    }
    return refused(`the server answered the merge with a pull request that is ${mr.state} and not merged`);
  } catch (error) {
    if (definitelyRejected(error)) {
      if (error.status !== undefined && REFUSALS.has(error.status)) return refused(error.message);
      await ctx.emit(MergeRefused, { pr, operation, reason: error.message, terminal: false, failed: true });
    }
    throw error;
  }
}

/** What the module needs to check a merge that was cut off. */
export interface CheckPlace {
  readonly journal: () => JournalReader | undefined;
  readonly gitlab: (host: string) => GitLab;
  /** Write a record of the module's own, for what a check finds and nothing recorded. */
  readonly write: MergeWriter;
}

/** Claims still waiting for a confirmed result, including after a host restart. */
export function unresolvedClaims(journal: JournalReader | undefined) {
  const claims = new Map<string, { pr: PrRef; operation: string; cancel: boolean }>();
  const types = [MergeStarted, CancelStarted, MergeArmed, MergeRefused, CancelRefused, MergeDisarmed, MergeSettled];
  for (const row of journal?.since(seq(0), types.map(type => type.name)) ?? []) {
    const { pr, operation } = row.data as { pr: PrRef; operation: string };
    if (row.type === MergeStarted.name || row.type === CancelStarted.name) {
      claims.set(operation, { pr, operation, cancel: row.type === CancelStarted.name });
    } else claims.delete(operation);
  }
  return [...claims.values()];
}

/** What happened to a merge that was cut off. */
export async function checkMerge(place: CheckPlace, operationId: string): Promise<CheckResult<MergeOutcome>> {
  const journal = place.journal();
  if (journal === undefined) return { status: "unknown" };
  const requested = journal
    .since(seq(0), [MergeStarted.name])
    .map((stored) => MergeStarted.schema.safeParse(stored.data))
    .find((parsed) => parsed.success && parsed.data.operation === operationId);
  if (requested === undefined || !requested.success) return { status: "failed", error: "the merge was never asked of the server" };
  const { pr, expectHead, when } = requested.data;
  const gitlab = place.gitlab(pr.repo.host);
  const externalId = externalIdOf(pr);
  const result = journal.since(seq(0), [MergeArmed.name, MergeRefused.name, MergeSettled.name])
    .find(row => (row.data as { operation: string }).operation === operationId);
  if (result?.type === MergeArmed.name) {
    const { mode } = MergeArmed.schema.parse(result.data);
    return { status: "completed", value: { outcome: mode === "train" ? "queued" : "armed", externalId, cancel: forgePrMergeCancel.name } };
  }
  if (result?.type === MergeRefused.name) {
    const { reason, failed } = MergeRefused.schema.parse(result.data);
    return failed ? { status: "failed", error: reason } : { status: "completed", value: { outcome: "refused", why: reason } };
  }
  if (result?.type === MergeSettled.name) {
    const settled = MergeSettled.schema.parse(result.data);
    return { status: "completed", value: { outcome: "merged", sha: settled.mergeSha ?? expectHead, externalId } };
  }
  const mr = await gitlab.get<GitLabMr>(projectPath(pr.repo, `/merge_requests/${pr.number}`));
  const resultId = `forge:merge-outcome:${operationId}`;
  if (mr.state === "merged" && mr.sha === expectHead) {
    const sha = mergedSha(mr, expectHead);
    await place.write(MergeSettled, { operation: operationId, pr, externalId, outcome: "merged", mergeSha: sha }, resultId);
    return { status: "completed", value: { outcome: "merged", sha, externalId } };
  }
  if (mr.state !== "opened" || mr.sha !== expectHead) {
    const reason = `the pull request is ${mr.state} at ${mr.sha}, expected ${expectHead}`;
    await place.write(MergeRefused, { operation: operationId, pr, reason, terminal: mr.state === "merged", failed: true }, resultId);
    return { status: "failed", error: reason };
  }
  const armed = async (mode: "auto-merge" | "train"): Promise<CheckResult<MergeOutcome>> => {
    await place.write(MergeArmed, { operation: operationId, pr, mode, externalId, expectHead }, resultId);
    return { status: "completed", value: { outcome: mode === "train" ? "queued" : "armed", externalId, cancel: forgePrMergeCancel.name } };
  };
  if (when === "pipeline" && mr.merge_when_pipeline_succeeds === true) return await armed("auto-merge");
  if (when === "train" && await inTrain(gitlab, pr)) return armed("train");
  return { status: "unknown" };
}

/**
 * The merges the server took for later and has not made or dropped yet: armed, and neither called
 * off nor followed by a merge or a close of the pull request.
 */
function armedMerges(journal: JournalReader | undefined): Array<PendingMerge & { operation: string }> {
  if (journal === undefined) return [];
  const pending = new Map<string, PendingMerge & { operation: string }>();
  for (const stored of journal.since(seq(0), [MergeArmed.name, MergeDisarmed.name, MergeSettled.name])) {
    if (stored.type === MergeArmed.name) {
      const parsed = MergeArmed.schema.safeParse(stored.data);
      if (!parsed.success) continue;
      const { pr, mode, externalId, expectHead } = parsed.data;
      const input = { repo: { host: pr.repo.host, path: pr.repo.path }, number: pr.number };
      pending.set(mergeKey(pr), { pr, operation: parsed.data.operation, mode, externalId, expectHead, cancel: { action: forgePrMergeCancel.name, input } });
      continue;
    }
    const ended = stored.type === MergeDisarmed.name ? MergeDisarmed : MergeSettled;
    const parsed = ended.schema.safeParse(stored.data);
    if (parsed.success) pending.delete(mergeKey(parsed.data.pr));
  }
  return [...pending.values()];
}

export function pendingMerges(journal: JournalReader | undefined): PendingMerge[] {
  return armedMerges(journal).map(({ operation: _operation, ...pending }) => pending);
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
export async function cancelMerge(gitlab: GitLab, pr: PrRef, journal: JournalReader | undefined, ctx: Pick<ActionContext, "emit" | "operationId">): Promise<boolean> {
  const known = armedMerges(journal).find(one => mergeKey(one.pr) === mergeKey(pr));
  if (known === undefined) return false;
  const claim = { operation: ctx.operationId, pr, basedOn: known.operation, mode: known.mode };
  await ctx.emit(CancelStarted, claim);
  const path = known.mode === "train"
    ? projectPath(pr.repo, `/merge_trains/merge_requests/${pr.number}`)
    : projectPath(pr.repo, `/merge_requests/${pr.number}/cancel_merge_when_pipeline_succeeds`);
  let accepted: boolean;
  try {
    accepted = !refusedInBody(await gitlab.send(known.mode === "train" ? "DELETE" : "POST", path));
  } catch (error) {
    if (!definitelyRejected(error)) throw error;
    if (error.code !== "not-found" && error.status !== 406 && error.status !== 405) {
      await ctx.emit(CancelRefused, { pr, operation: claim.operation, basedOn: known.operation, error: error.message });
      throw error;
    }
    accepted = false;
  }
  const result = await observeCancel(gitlab, claim, (type, data) => ctx.emit(type, data).then(() => {}), accepted);
  return result.status === "completed" && result.value.cancelled;
}

type CancelClaim = ReturnType<typeof CancelStarted.schema.parse>;

async function observeCancel(gitlab: GitLab, claim: CancelClaim, write: MergeWriter, accepted?: boolean): Promise<CheckResult<{cancelled: boolean}>> {
  const { pr, operation, mode, basedOn } = claim;
  const externalId = externalIdOf(pr);
  const id = `forge:cancel-outcome:${operation}`;
  const mr = await gitlab.get<GitLabMr>(projectPath(pr.repo, `/merge_requests/${pr.number}`));
  if (mr.state === "merged" || mr.state === "closed") {
    const mergeSha = finalShaOf(mr);
    await write(MergeSettled, { pr, operation, externalId, outcome: mr.state, ...(mergeSha ? { mergeSha } : {}) }, id);
    return { status: "completed", value: { cancelled: false } };
  }
  if (mr.state !== "opened") return { status: "unknown" };
  const armed = mr.merge_when_pipeline_succeeds === true || (mode === "train" && await inTrain(gitlab, pr));
  if (!armed) {
    const cancelled = accepted !== false;
    await write(MergeDisarmed, { pr, operation, externalId, cancelled }, id);
    return { status: "completed", value: { cancelled } };
  }
  if (accepted === undefined) return { status: "unknown" };
  await write(CancelRefused, { pr, operation, basedOn }, id);
  return { status: "completed", value: { cancelled: false } };
}

export async function checkCancel(place: CheckPlace, operation: string): Promise<CheckResult<{cancelled: boolean}>> {
  const journal = place.journal();
  if (journal === undefined) return { status: "unknown" };
  const claim = journal.find({ type: CancelStarted.name, field: "operation", equals: operation })[0];
  if (!claim) return { status: "completed", value: { cancelled: false } };
  const saved = journal.since(claim.seq, [MergeDisarmed.name, CancelRefused.name, MergeSettled.name])
    .find(row => (row.data as { operation: string }).operation === operation);
  if (saved?.type === CancelRefused.name) {
    const { error } = CancelRefused.schema.parse(saved.data);
    if (error) return { status: "failed", error };
  }
  if (saved) return { status: "completed", value: { cancelled: saved.type === MergeDisarmed.name && MergeDisarmed.schema.parse(saved.data).cancelled } };
  const data = CancelStarted.schema.parse(claim.data);
  return observeCancel(place.gitlab(data.pr.repo.host), data, place.write);
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
  for (const one of armedMerges(journal)) {
    if (one.pr.repo.host !== repo.host || one.pr.repo.projectId !== repo.projectId) continue;
    let mr: GitLabMr;
    try {
      mr = await gitlab.get<GitLabMr>(projectPath(repo, `/merge_requests/${String(one.pr.number)}`));
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not-found") continue;
      throw error;
    }
    const id = (what: string) => `forge:merge:${one.operation}:${what}`;
    if (mr.state === "merged" || mr.state === "closed") {
      const mergeSha = mr.state === "merged" ? finalShaOf(mr) : undefined;
      await place.write(MergeSettled, { pr: one.pr, operation: one.operation, externalId: one.externalId, outcome: mr.state, ...(mergeSha === undefined ? {} : { mergeSha }) }, id("settled"));
      continue;
    }
    if (mr.state !== "opened") continue;
    const dropped = one.mode === "auto-merge" ? mr.merge_when_pipeline_succeeds !== true : !(await inTrain(gitlab, one.pr));
    if (dropped) await place.write(MergeDisarmed, { pr: one.pr, operation: one.operation, cancelled: false, externalId: one.externalId }, id("disarmed"));
  }
}
