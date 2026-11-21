/**
 * The query builders of the forge records: what a workflow script waits for (`wait(prHead(pr), {
 * timeout })`) or reads (`read.records(pipelineOf(...))`) with the data typed by the record, and a
 * handler subscribes to.
 *
 * A builder names a pull request, a commit or a repository the way an action does, by `{ host, path }`
 * and a number: a record's own repository, which also holds the project id, is accepted and read for
 * its name. A name that is not one is refused when the query is made, not when the run reaches it.
 */

import { queryOf } from "@niwa-labs/core";
import type { TypeQuery } from "@niwa-labs/core";
import type { z } from "zod";

import {
  ChecksObserved,
  JobObserved,
  MergeArmed,
  MergeDisarmed,
  MergeSettled,
  PipelineObserved,
  PrClosed,
  PrComment,
  PrHead,
  PrMerged,
  PrOpened,
  PrReview,
  PrUpdated,
  Pushed,
  Sha,
} from "./record-types.ts";
import type { PipelineKind } from "./record-types.ts";
import { RepoName } from "./targets.ts";

/** A pull request as a builder is given it: the repository by name, and the number in the project. */
export interface PrKey {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

/** What a builder takes of a repository: its name; a project id beside it is not read. */
export interface RepoKey {
  readonly host: string;
  readonly path: string;
}

/** The name of a repository, checked. */
function repoOf(repo: RepoKey): RepoName {
  return RepoName.parse({ host: repo.host, path: repo.path });
}

/** The filter on the pull request a record names as `pr`. */
function prFilter(pr: PrKey): { "pr.repo.host": string; "pr.repo.path": string; "pr.number": number } {
  const repo = repoOf(pr.repo);
  if (!Number.isInteger(pr.number) || pr.number < 1) throw new TypeError(`not a pull request number: ${String(pr.number)}`);
  return { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": pr.number };
}

type Data<R extends { readonly schema: z.ZodType }> = z.output<R["schema"]>;

/** A pull request was opened, or opened again. */
export function prOpened(pr: PrKey): TypeQuery<Data<typeof PrOpened>> {
  return queryOf(PrOpened, prFilter(pr));
}

/** The title, the target branch or the draft flag of a pull request changed. */
export function prUpdated(pr: PrKey): TypeQuery<Data<typeof PrUpdated>> {
  return queryOf(PrUpdated, prFilter(pr));
}

/** The head of a pull request moved: new commits, a rebase, a force push. */
export function prHead(pr: PrKey): TypeQuery<Data<typeof PrHead>> {
  return queryOf(PrHead, prFilter(pr));
}

/** Somebody approved a pull request, or took an approval back. */
export function prReview(pr: PrKey): TypeQuery<Data<typeof PrReview>> {
  return queryOf(PrReview, prFilter(pr));
}

/** Somebody commented on a pull request. */
export function prComment(pr: PrKey): TypeQuery<Data<typeof PrComment>> {
  return queryOf(PrComment, prFilter(pr));
}

/** A pull request was merged. */
export function prMerged(pr: PrKey): TypeQuery<Data<typeof PrMerged>> {
  return queryOf(PrMerged, prFilter(pr));
}

/** A pull request was closed without a merge. */
export function prClosed(pr: PrKey): TypeQuery<Data<typeof PrClosed>> {
  return queryOf(PrClosed, prFilter(pr));
}

/** What the pipelines of the head of a pull request say, together, changed. */
export function prChecks(pr: PrKey): TypeQuery<Data<typeof ChecksObserved>> {
  return queryOf(ChecksObserved, prFilter(pr));
}

/** The server took a merge of a pull request that it will make later. */
export function mergeArmed(pr: PrKey): TypeQuery<Data<typeof MergeArmed>> {
  return queryOf(MergeArmed, prFilter(pr));
}

/** A merge the server had taken was called off. */
export function mergeDisarmed(pr: PrKey): TypeQuery<Data<typeof MergeDisarmed>> {
  return queryOf(MergeDisarmed, prFilter(pr));
}

/** A merge the server had taken is over: the pull request was merged or closed there. */
export function mergeSettled(pr: PrKey): TypeQuery<Data<typeof MergeSettled>> {
  return queryOf(MergeSettled, prFilter(pr));
}

/**
 * The pipelines of a commit, one record for each state one of them was seen in. A commit is the one
 * the change ran for (a pull request's head, or the commit of a branch or tag), and `kind` takes only
 * the pipelines of that kind: a merge result, say, among a head's pipelines.
 */
export function pipelineOf(opts: { repo: RepoKey; sha: string; kind?: PipelineKind }): TypeQuery<Data<typeof PipelineObserved>> {
  const repo = repoOf(opts.repo);
  return queryOf(PipelineObserved, {
    "repo.host": repo.host,
    "repo.path": repo.path,
    sourceSha: Sha.parse(opts.sha),
    ...(opts.kind === undefined ? {} : { kind: opts.kind }),
  });
}

/** The pipelines that ran for a pull request, as the server numbers it. */
export function pipelinesOfPr(pr: PrKey): TypeQuery<Data<typeof PipelineObserved>> {
  const { "pr.repo.host": host, "pr.repo.path": path, "pr.number": number } = prFilter(pr);
  return queryOf(PipelineObserved, { "repo.host": host, "repo.path": path, pr: number });
}

/** The jobs of one pipeline. */
export function jobsOf(opts: { repo: RepoKey; pipeline: number }): TypeQuery<Data<typeof JobObserved>> {
  const repo = repoOf(opts.repo);
  if (!Number.isInteger(opts.pipeline) || opts.pipeline < 1) throw new TypeError(`not a pipeline id: ${String(opts.pipeline)}`);
  return queryOf(JobObserved, { "repo.host": repo.host, "repo.path": repo.path, pipeline: opts.pipeline });
}

/**
 * Commits pushed to a repository, or to one of its branches or tags.
 * A ref is the name the server gives it, `main` or `v1.2`, without `refs/heads/`.
 */
export function pushed(repo: RepoKey, ref?: string): TypeQuery<Data<typeof Pushed>> {
  const name = repoOf(repo);
  if (ref !== undefined && ref.length === 0) throw new TypeError("a ref is not empty");
  return queryOf(Pushed, { "repo.host": name.host, "repo.path": name.path, ...(ref === undefined ? {} : { ref }) });
}
