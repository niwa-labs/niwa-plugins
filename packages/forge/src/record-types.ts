/**
 * The records of the forge module: what it observed on a GitLab server, and what it did there.
 *
 * An observed record has an id that says where the fact came from (`Source`): an event of the
 * server's own event log carries the server's event id, so the same event is written once however
 * often it is read; a change the module saw between two polls carries the version of its
 * observation and the state before it, so `open → closed → open` is three records and not one.
 * A change that came and went between two polls is invisible, and a record never claims more than
 * what was seen.
 *
 * Records hold ids, states, authors, sizes and digests of foreign content, never the content: the
 * text of a comment is read with `forge.comment.read`, whose result is the step's own.
 */

import { record } from "@niwa-labs/core";
import { z } from "zod";

import { ForgeHost, ProjectPath, RefName } from "./targets.ts";

/** A full commit id. */
export const Sha = z.string().regex(/^[0-9a-f]{40,64}$/, "a full commit id");
export type Sha = z.infer<typeof Sha>;

/** A repository the module knows: the server, the path of the project and its id, which survives a rename. */
export const Repo = z.strictObject({ host: ForgeHost, path: ProjectPath, projectId: z.number().int().positive() });
export type Repo = z.infer<typeof Repo>;

/** A pull request (a GitLab merge request): its repository and its number in the project. */
export const PrRef = z.strictObject({ repo: Repo, number: z.number().int().positive() });
export type PrRef = z.infer<typeof PrRef>;

/** Where an observed fact came from: the server's event log, or a change seen between two polls. */
export const Source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), id: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("observed"), version: z.number().int().positive() }),
]);
export type Source = z.infer<typeof Source>;

/** Who did something on the server, by the server's username. */
export const ForgeUser = z.string().min(1);

/** What a pipeline ran on: the head of a pull request, its merge with the target, a merge train, a branch, a tag, a schedule. */
export const PipelineKind = z.enum(["head", "merge-result", "train", "branch", "tag", "schedule"]);
export type PipelineKind = z.infer<typeof PipelineKind>;

/** Where a pipeline or a job stands, in GitLab's words. */
export const RunState = z.enum([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
]);
export type RunState = z.infer<typeof RunState>;

/** A pipeline as the module records it. */
export const Pipeline = z.strictObject({
  repo: Repo,
  pipeline: z.number().int().positive(),
  kind: PipelineKind,
  ref: z.string().min(1),
  /** The commit of the change: the head of the pull request, or the commit of the branch or tag. */
  sourceSha: Sha,
  /** The commit of the target branch a merge result or a train was made on. */
  targetSha: Sha.optional(),
  /** The commit a merge result or a train ran on: the merge of `sourceSha` into `targetSha`. */
  mergeSha: Sha.optional(),
  state: RunState,
  /** The pull request a pipeline of a pull request ran for. */
  pr: z.number().int().positive().optional(),
});
export type Pipeline = z.infer<typeof Pipeline>;

/** A pipeline changed its state: one record per state the module saw. */
export const PipelineObserved = record(
  "forge.pipeline",
  Pipeline.extend({ previous: RunState.optional(), source: Source }),
);

/** A job of a pipeline changed its state. */
export const JobObserved = record(
  "forge.job",
  z.strictObject({
    repo: Repo,
    pipeline: z.number().int().positive(),
    job: z.number().int().positive(),
    name: z.string().min(1),
    stage: z.string().min(1),
    state: RunState,
    previous: RunState.optional(),
    source: Source,
  }),
);

/** What the pipelines of the head of a pull request say, together. */
export const ChecksState = z.enum(["none", "pending", "green", "red"]);
export type ChecksState = z.infer<typeof ChecksState>;

/** The checks of a pull request changed: computed by the module from the pipelines of its head. */
export const ChecksObserved = record(
  "forge.checks",
  z.strictObject({
    pr: PrRef,
    head: Sha,
    state: ChecksState,
    previous: ChecksState.optional(),
    /** The latest pipeline of the head, which decides the state. */
    pipeline: z.number().int().positive().optional(),
    source: Source,
  }),
);

/** Commits were pushed to a branch or a tag. */
export const Pushed = record(
  "forge.push",
  z.strictObject({
    repo: Repo,
    ref: z.string().min(1),
    refType: z.enum(["branch", "tag"]),
    /** The commit before the push; absent for a new ref. */
    before: Sha.optional(),
    /** The commit after the push; absent for a removed ref. */
    after: Sha.optional(),
    author: ForgeUser.optional(),
    source: Source,
  }),
);

/** A pull request as it was opened. */
export const PrOpened = record(
  "forge.pr.opened",
  z.strictObject({
    pr: PrRef,
    title: z.string(),
    /** The branch the change is on. */
    branch: RefName,
    /** The branch it is to be merged into. */
    base: RefName,
    author: ForgeUser.optional(),
    source: Source,
  }),
);

/** The title, the target branch or the draft flag of a pull request changed. */
export const PrUpdated = record(
  "forge.pr.updated",
  z.strictObject({
    pr: PrRef,
    title: z.string(),
    base: RefName,
    draft: z.boolean(),
    source: Source,
  }),
);

/** The head of a pull request moved: new commits, a rebase, a force push. */
export const PrHead = record(
  "forge.pr.head",
  z.strictObject({ pr: PrRef, head: Sha, previous: Sha.optional(), source: Source }),
);

/** Somebody approved a pull request, or took an approval back. */
export const PrReview = record(
  "forge.pr.review",
  z.strictObject({ pr: PrRef, reviewer: ForgeUser, state: z.enum(["approved", "unapproved"]), source: Source }),
);

/** Somebody commented on a pull request. The text is foreign content: the record holds its size and digest. */
export const PrComment = record(
  "forge.pr.comment",
  z.strictObject({
    pr: PrRef,
    comment: z.number().int().positive(),
    discussion: z.string().min(1).optional(),
    author: ForgeUser,
    size: z.number().int().nonnegative(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    source: Source,
  }),
);

/** A pull request was merged. */
export const PrMerged = record(
  "forge.pr.merged",
  z.strictObject({
    pr: PrRef,
    base: RefName,
    /** The head of the pull request that was merged. */
    head: Sha.optional(),
    /** The commit the merge made on the base: a merge commit, a squash, or the rebased head. */
    mergeSha: Sha.optional(),
    by: ForgeUser.optional(),
    source: Source,
  }),
);

/** A pull request was closed without a merge. */
export const PrClosed = record("forge.pr.closed", z.strictObject({ pr: PrRef, by: ForgeUser.optional(), source: Source }));

/**
 * A repository is watched: the module polls it and records what it sees. `since` is the last event of
 * the server's log at that moment: the events before it are history, not news.
 */
export const RepoWatched = record("forge.repo.watched", z.strictObject({ repo: Repo, since: z.number().int().nonnegative() }));

/** A repository is not watched any more. */
export const RepoUnwatched = record("forge.repo.unwatched", z.strictObject({ repo: Repo }));

/** How a merge was asked for: at once, when the pipeline succeeds, or by a merge train. */
export const MergeWhen = z.enum(["now", "pipeline", "train"]);
export type MergeWhen = z.infer<typeof MergeWhen>;

/** How the commits of a pull request land on its base: squashed, or by the project's merge method (`merge`, `rebase`). */
export const MergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

/**
 * A merge is about to be asked of the server. Written before the request leaves, so a call that was
 * cut off can be checked: without this record the request was never sent.
 */
export const MergeRequested = record(
  "forge.pr.merge.requested",
  z.strictObject({ operation: z.string().min(1), pr: PrRef, expectHead: Sha, method: MergeMethod, when: MergeWhen }),
);

/**
 * The server took a merge it will make later: an automatic merge when the pipeline succeeds, or a
 * place in a merge train. Nothing in niwa can stop it any more except `forge.pr.merge.cancel`.
 */
export const MergeArmed = record(
  "forge.pr.merge.armed",
  z.strictObject({
    pr: PrRef,
    mode: z.enum(["auto-merge", "train"]),
    /** The server's own name for what it took: `<host>/<path>!<n>` for the merge request. */
    externalId: z.string().min(1),
    expectHead: Sha,
  }),
);

/** A merge the server had taken was called off, by `forge.pr.merge.cancel`. */
export const MergeDisarmed = record(
  "forge.pr.merge.disarmed",
  z.strictObject({ pr: PrRef, externalId: z.string().min(1) }),
);

/** Every record type of the forge module. */
export const FORGE_TYPES = [
  RepoWatched,
  RepoUnwatched,
  Pushed,
  PrOpened,
  PrUpdated,
  PrHead,
  PrReview,
  PrComment,
  PrMerged,
  PrClosed,
  PipelineObserved,
  JobObserved,
  ChecksObserved,
  MergeRequested,
  MergeArmed,
  MergeDisarmed,
] as const;
