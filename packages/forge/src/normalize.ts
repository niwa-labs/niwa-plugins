/**
 * What GitLab answers, in the module's words: a merge request is a pull request, a pipeline has a
 * kind, a merge result has the pair of commits it was made of.
 *
 * GitLab names a pipeline of a merge request by its ref: `refs/merge-requests/<n>/head` ran on the
 * head, `…/merge` on the merge of the head into the target, `…/train` in a merge train. The commit a
 * merge result ran on is a merge whose first parent is the target and second the head, so the pair
 * is read from the commit itself and not from the merge request, whose head may have moved since.
 */

import type { PullRequest } from "./actions.ts";
import type { ChecksState, Pipeline, PipelineKind, PrRef, Repo, RunState } from "./record-types.ts";
import { RunState as RunStates } from "./record-types.ts";

/** A merge request, as much of it as the module reads. */
export interface GitLabMr {
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string } | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merge_when_pipeline_succeeds?: boolean;
  updated_at?: string;
  web_url?: string;
}

/** A pipeline, as much of it as the module reads. */
export interface GitLabPipeline {
  id: number;
  sha: string;
  ref: string;
  status: string;
  source?: string;
  tag?: boolean;
  updated_at?: string;
}

/** A job, as much of it as the module reads. */
export interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  ref: string;
  pipeline: { id: number };
}

/**
 * The commit a merged request left on its base. A squash in a project that merges by merge commit
 * makes two commits, the squash and the merge on top of it: the merge is what lands. Where the
 * project merges by fast-forward there is no merge commit and the squash is the one that lands.
 */
export function finalShaOf(mr: GitLabMr): string | undefined {
  return mr.merge_commit_sha ?? mr.squash_commit_sha ?? undefined;
}

/** The pull request of a merge request. */
export function pullRequestOf(repo: Repo, mr: GitLabMr): PullRequest {
  const state = mr.state === "opened" ? "open" : mr.state === "merged" ? "merged" : mr.state === "locked" ? "locked" : "closed";
  const merged = finalShaOf(mr);
  return {
    pr: { repo, number: mr.iid },
    state,
    title: mr.title,
    branch: mr.source_branch,
    base: mr.target_branch,
    head: mr.sha,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    ...(mr.author?.username === undefined ? {} : { author: mr.author.username }),
    ...(state === "merged" && merged !== undefined ? { mergeSha: merged } : {}),
    autoMerge: mr.merge_when_pipeline_succeeds ?? false,
    ...(mr.web_url === undefined ? {} : { webUrl: mr.web_url }),
  };
}

/** A state GitLab gave, in the module's enum; an unknown one reads as `created`. */
export function runStateOf(status: string): RunState {
  const parsed = RunStates.safeParse(status);
  return parsed.success ? parsed.data : "created";
}

const MR_REF = /^refs\/merge-requests\/(\d+)\/(head|merge|train)$/;

/** What a pipeline ran on, and the pull request it ran for, from its ref and source. */
export function kindOf(pipeline: GitLabPipeline): { kind: PipelineKind; pr?: number } {
  const mr = MR_REF.exec(pipeline.ref);
  if (mr !== null) {
    const kind = mr[2] === "head" ? "head" : mr[2] === "merge" ? "merge-result" : "train";
    return { kind, pr: Number(mr[1]) };
  }
  if (pipeline.tag === true) return { kind: "tag" };
  if (pipeline.source === "schedule") return { kind: "schedule" };
  return { kind: "branch" };
}

/** The parents of a commit, as the server says: what a merge result was made of. */
export type ParentsOf = (sha: string) => Promise<readonly string[] | undefined>;

/**
 * A pipeline in the module's words. A merge result or a train whose commit the server cannot show
 * as a merge of two parents is not bound to a pair, so it is not answered.
 */
export async function pipelineOf(repo: Repo, pipeline: GitLabPipeline, parentsOf: ParentsOf): Promise<Pipeline | undefined> {
  const { kind, pr } = kindOf(pipeline);
  const base = { repo, pipeline: pipeline.id, kind, ref: pipeline.ref, state: runStateOf(pipeline.status), ...(pr === undefined ? {} : { pr }) };
  if (kind !== "merge-result" && kind !== "train") return { ...base, sourceSha: pipeline.sha };
  const parents = await parentsOf(pipeline.sha);
  const [targetSha, sourceSha] = parents ?? [];
  if (parents?.length !== 2 || targetSha === undefined || sourceSha === undefined) return undefined;
  return { ...base, sourceSha, targetSha, mergeSha: pipeline.sha };
}

/**
 * What one pipeline's state says of the change: green on success, red on a failure or a cancel,
 * none when it was skipped, and pending otherwise, a pipeline that waits on a manual job included.
 */
export function verdictOf(state: RunState): ChecksState {
  if (state === "success") return "green";
  if (state === "failed" || state === "canceled") return "red";
  return state === "skipped" ? "none" : "pending";
}

/** What the pipelines of one head say: the latest decides; none is `none`. */
export function checksOf(pipelines: readonly Pipeline[]): { state: ChecksState; pipeline?: number } {
  const latest = [...pipelines].sort((a, b) => b.pipeline - a.pipeline)[0];
  if (latest === undefined) return { state: "none" };
  return { state: verdictOf(latest.state), pipeline: latest.pipeline };
}

/** The ref a pull request's pipelines run on. */
export function prOfRef(ref: string): number | undefined {
  const mr = MR_REF.exec(ref);
  return mr === null ? undefined : Number(mr[1]);
}

/** A pull request reference. */
export function prRef(repo: Repo, number: number): PrRef {
  return { repo, number };
}
