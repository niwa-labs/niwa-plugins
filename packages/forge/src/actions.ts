/**
 * The actions of the forge module, as typed references with the targets their rules name.
 *
 * The module builds its real actions from the same references, so the schemas here are the ones
 * the host checks against. Every action that touches a repository takes it as `repo: { host, path }`,
 * which is what a target template fills: `forge.pr.merge@{repo.host}/{repo.path}/pr/*`.
 */

import { actionRef } from "@niwa-labs/core";
import { z } from "zod";

import { ChecksState, MergeMethod, MergeWhen, Pipeline, PipelineKind, PrRef, Repo, RunState, Sha } from "./record-types.ts";
import { RefName, RepoName, prTarget, refTarget, repoTarget } from "./targets.ts";

/** The name of a secret: letters, digits and underscores, as the host's secrets are named. */
export const SecretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a secret name is letters, digits and underscores");

/**
 * A reference to a secret. The value is the owner's: the host resolves it where the call runs, from
 * `<home>/secrets/<name>` (mode 0600) or the variable `NIWA_SECRET_<name>`, and it is never written down.
 */
export const SecretRef = z.strictObject({ secret: SecretName });
export type SecretRef = z.infer<typeof SecretRef>;

/** The reference to the secret called `name`. */
export function secret(name: string): SecretRef {
  return SecretRef.parse({ secret: name });
}

const Number_ = z.number().int().positive();

/** A pull request as `forge.pr.read` answers it. */
export const PullRequest = z.strictObject({
  pr: PrRef,
  state: z.enum(["open", "merged", "closed", "locked"]),
  title: z.string(),
  branch: z.string().min(1),
  base: z.string().min(1),
  head: Sha,
  draft: z.boolean(),
  author: z.string().optional(),
  /** The commit the merge made, for a merged pull request. */
  mergeSha: Sha.optional(),
  /** A merge the server will make by itself when the pipeline succeeds. */
  autoMerge: z.boolean(),
  webUrl: z.string().optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

// --- Repositories -------------------------------------------------------------------------------

export const forgeRepoWatch = actionRef("forge.repo.watch", {
  description:
    "Watch a repository of a configured GitLab server: the module looks up its project, records it, and from then on " +
    "polls it and records pushes, pull requests, pipelines, jobs and checks. Watching a watched repository changes nothing.",
  input: z.strictObject({ repo: RepoName }),
  output: Repo,
  target: (input) => repoTarget(input.repo),
});

export const forgeRepoUnwatch = actionRef("forge.repo.unwatch", {
  description: "Stop watching a repository. Its records stay. Unwatching a repository that is not watched changes nothing.",
  input: z.strictObject({ repo: RepoName }),
  output: z.strictObject({ unwatched: z.boolean() }),
  target: (input) => repoTarget(input.repo),
});

export const forgeRepoList = actionRef("forge.repo.list", {
  description: "The repositories the module watches.",
  input: z.strictObject({}),
  output: z.strictObject({ items: z.array(Repo) }),
});

export const forgeRepoSync = actionRef("forge.repo.sync", {
  description:
    "Poll a watched repository now, as the module does on its own timer, and record what changed: events of the server's " +
    "event log, heads of pull requests, pipelines, jobs and checks. Answers how many records it wrote.",
  input: z.strictObject({ repo: RepoName }),
  output: z.strictObject({ written: z.number().int().nonnegative() }),
  target: (input) => repoTarget(input.repo),
});

// --- Reads --------------------------------------------------------------------------------------

export const forgePrRead = actionRef("forge.pr.read", {
  description: "Read a pull request (a GitLab merge request) by its number: state, title, branches, head, draft, merge.",
  input: z.strictObject({ repo: RepoName, number: Number_ }),
  output: PullRequest,
  target: (input) => repoTarget(input.repo),
});

export const forgeChecksRead = actionRef("forge.checks.read", {
  description:
    "What the pipelines of the head of a pull request say: none, pending, green or red, from its latest pipeline on that head.",
  input: z.strictObject({ repo: RepoName, number: Number_ }),
  output: z.strictObject({ pr: PrRef, head: Sha, state: ChecksState, pipeline: Number_.optional() }),
  target: (input) => repoTarget(input.repo),
});

export const forgePipelineRead = actionRef("forge.pipeline.read", {
  description:
    "Read pipelines: one by its number, or the pipelines that ran on a commit, newest first, optionally of one kind " +
    "(head, merge-result, train, branch, tag, schedule). A merge result carries the pair of commits it was made of.",
  input: z.strictObject({
    repo: RepoName,
    pipeline: Number_.optional(),
    sha: Sha.optional(),
    kind: PipelineKind.optional(),
  }),
  output: z.strictObject({ items: z.array(Pipeline) }),
  target: (input) => repoTarget(input.repo),
});

const Job = z.strictObject({
  job: Number_,
  pipeline: Number_,
  name: z.string(),
  stage: z.string(),
  ref: z.string(),
  state: RunState,
  manual: z.boolean(),
});

export const forgeJobRead = actionRef("forge.job.read", {
  description: "Read the jobs of a pipeline, or one job by its number.",
  input: z.strictObject({ repo: RepoName, pipeline: Number_.optional(), job: Number_.optional() }),
  output: z.strictObject({ items: z.array(Job) }),
  target: (input) => repoTarget(input.repo),
});

export const forgeJobLog = actionRef("forge.job.log", {
  description: "Read the end of the log of a job, at most `bytes` of it (default 64 KiB).",
  input: z.strictObject({ repo: RepoName, job: Number_, bytes: z.number().int().min(1).max(1_048_576).optional() }),
  output: z.strictObject({ job: Number_, log: z.string(), size: z.number().int().nonnegative(), truncated: z.boolean() }),
  target: (input) => repoTarget(input.repo),
});

const Comment = z.strictObject({
  comment: Number_,
  discussion: z.string(),
  author: z.string(),
  body: z.string(),
  resolvable: z.boolean(),
  resolved: z.boolean(),
  system: z.boolean(),
});

export const forgeCommentRead = actionRef("forge.comment.read", {
  description: "Read the comments of a pull request with their text, grouped by the discussion each belongs to.",
  input: z.strictObject({ repo: RepoName, number: Number_ }),
  output: z.strictObject({ items: z.array(Comment) }),
  target: (input) => repoTarget(input.repo),
});

// --- Writes on a pull request -------------------------------------------------------------------

export const forgePrEnsure = actionRef("forge.pr.ensure", {
  description:
    "Make sure a pull request from `branch` into `base` is open, with this title and description: an open one of the branch " +
    "is updated, else one is opened. Its target is the pull request named by `number`, or `pr/new` without one.",
  input: z.strictObject({
    repo: RepoName,
    number: Number_.optional(),
    branch: RefName,
    base: RefName,
    title: z.string().min(1),
    description: z.string().optional(),
    draft: z.boolean().optional(),
  }),
  output: z.strictObject({ pr: PrRef, created: z.boolean(), head: Sha }),
  target: (input) => prTarget(input.repo, input.number ?? "new"),
});

export const forgePrRetarget = actionRef("forge.pr.retarget", {
  description: "Change the branch a pull request is to be merged into.",
  input: z.strictObject({ repo: RepoName, number: Number_, base: RefName }),
  output: z.strictObject({ pr: PrRef, base: z.string() }),
  target: (input) => prTarget(input.repo, input.number),
});

export const forgePrClose = actionRef("forge.pr.close", {
  description: "Close a pull request without merging it. Closing a closed one changes nothing.",
  input: z.strictObject({ repo: RepoName, number: Number_ }),
  output: z.strictObject({ pr: PrRef, closed: z.boolean() }),
  target: (input) => prTarget(input.repo, input.number),
});

export const forgeCommentCreate = actionRef("forge.comment.create", {
  description: "Comment on a pull request. Two calls make two comments.",
  input: z.strictObject({ repo: RepoName, number: Number_, body: z.string().min(1) }),
  output: z.strictObject({ comment: Number_, discussion: z.string() }),
  target: (input) => prTarget(input.repo, input.number),
});

export const forgeCommentReply = actionRef("forge.comment.reply", {
  description: "Reply in a discussion of a pull request. Two calls make two replies.",
  input: z.strictObject({ repo: RepoName, number: Number_, discussion: z.string().min(1), body: z.string().min(1) }),
  output: z.strictObject({ comment: Number_, discussion: z.string() }),
  target: (input) => prTarget(input.repo, input.number),
});

export const forgeCommentResolve = actionRef("forge.comment.resolve", {
  description: "Resolve a discussion of a pull request, or reopen it with `resolved: false`.",
  input: z.strictObject({ repo: RepoName, number: Number_, discussion: z.string().min(1), resolved: z.boolean().optional() }),
  output: z.strictObject({ discussion: z.string(), resolved: z.boolean() }),
  target: (input) => prTarget(input.repo, input.number),
});

/** How a merge went: merged now, taken by a merge train, armed to merge when the pipeline succeeds, or refused. */
export const MergeOutcome = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("merged"), sha: Sha, externalId: z.string() }),
  z.strictObject({ outcome: z.literal("queued"), externalId: z.string(), cancel: z.string() }),
  z.strictObject({ outcome: z.literal("armed"), externalId: z.string(), cancel: z.string() }),
  z.strictObject({ outcome: z.literal("refused"), why: z.string() }),
]);
export type MergeOutcome = z.infer<typeof MergeOutcome>;

export const forgePrMerge = actionRef("forge.pr.merge", {
  description:
    "Merge a pull request, only if its head is still `expectHead`. `when: now` merges at once; `pipeline` arms the server to merge " +
    "when the pipeline succeeds; `train` puts it in the merge train. Answers merged (with the commit), armed or queued (with the " +
    "server's id and the action that calls it off), or refused with the server's reason, such as a head that moved. " +
    "Irreversible and external: a grant names it.",
  input: z.strictObject({
    repo: RepoName,
    number: Number_,
    expectHead: Sha,
    method: MergeMethod,
    when: MergeWhen.optional(),
  }),
  output: MergeOutcome,
  target: (input) => prTarget(input.repo, input.number),
});

export const forgePrMergeCancel = actionRef("forge.pr.merge.cancel", {
  description:
    "Call off a merge the server took for later: the automatic merge when the pipeline succeeds, or the place in the merge train.",
  input: z.strictObject({ repo: RepoName, number: Number_ }),
  output: z.strictObject({ cancelled: z.boolean() }),
  target: (input) => prTarget(input.repo, input.number),
});

/** A merge the server took and has not made or dropped yet, as niwa recorded it. */
export const PendingMerge = z.strictObject({
  pr: PrRef,
  mode: z.enum(["auto-merge", "train"]),
  externalId: z.string(),
  expectHead: Sha,
  /** The action that calls it off, and its input. */
  cancel: z.strictObject({ action: z.string(), input: z.strictObject({ repo: RepoName, number: Number_ }) }),
});
export type PendingMerge = z.infer<typeof PendingMerge>;

export const forgePrMergePending = actionRef("forge.pr.merge.pending", {
  description:
    "The merges the server took for later and has not made yet, each with its external id and the action that calls it off. " +
    "A hold of niwa cannot stop them: the server has them.",
  input: z.strictObject({}),
  output: z.strictObject({ items: z.array(PendingMerge) }),
});

// --- Pipelines and jobs -------------------------------------------------------------------------

/** A variable of a pipeline: text, or a secret the host resolves when the call runs. */
export const PipelineVariable = z.union([z.string(), SecretRef]);

export const forgePipelineTrigger = actionRef("forge.pipeline.trigger", {
  description:
    "Run a new pipeline on a branch or a tag. `variables` are text or a secret reference, `secret(\"name\")`, resolved by the host " +
    "and never written down. A pipeline may publish, so this is irreversible: a grant names it.",
  input: z.strictObject({ repo: RepoName, ref: RefName, variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), PipelineVariable).optional() }),
  output: z.strictObject({ pipeline: Number_, ref: z.string(), sha: Sha, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});

const OnRef = { repo: RepoName, ref: RefName };

export const forgePipelineRetry = actionRef("forge.pipeline.retry", {
  description: "Retry the failed jobs of a pipeline. `ref` is the branch or tag it ran on; a pipeline of another ref is refused.",
  input: z.strictObject({ ...OnRef, pipeline: Number_ }),
  output: z.strictObject({ pipeline: Number_, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});

export const forgePipelineCancel = actionRef("forge.pipeline.cancel", {
  description: "Cancel the running jobs of a pipeline. `ref` is the branch or tag it ran on; a pipeline of another ref is refused.",
  input: z.strictObject({ ...OnRef, pipeline: Number_ }),
  output: z.strictObject({ pipeline: Number_, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});

export const forgeJobRetry = actionRef("forge.job.retry", {
  description: "Run a job again, as a new job. `ref` is the branch or tag it ran on; a job of another ref is refused.",
  input: z.strictObject({ ...OnRef, job: Number_ }),
  output: z.strictObject({ job: Number_, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});

export const forgeJobCancel = actionRef("forge.job.cancel", {
  description: "Cancel a job. `ref` is the branch or tag it ran on; a job of another ref is refused.",
  input: z.strictObject({ ...OnRef, job: Number_ }),
  output: z.strictObject({ job: Number_, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});

export const forgeJobRun = actionRef("forge.job.run", {
  description: "Start a manual job. `ref` is the branch or tag it belongs to; a job of another ref is refused.",
  input: z.strictObject({ ...OnRef, job: Number_ }),
  output: z.strictObject({ job: Number_, state: RunState }),
  target: (input) => refTarget(input.repo, input.ref),
});
