/**
 * The forge actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

/** A repository as the host names it: the server and the path of the project. */
export const Repo = z.object({ host: z.string(), path: z.string(), projectId: z.number() });
export type Repo = z.infer<typeof Repo>;

/** A repository as an action takes it. */
export const RepoName = z.object({ host: z.string(), path: z.string() });
export type RepoName = z.infer<typeof RepoName>;

export const PrRef = z.object({ repo: Repo, number: z.number() });
export type PrRef = z.infer<typeof PrRef>;

export const repoListAction = {
  name: "forge.repo.list",
  input: z.object({}),
  output: z.object({ items: z.array(Repo) }),
} as const;

export const repoSyncAction = {
  name: "forge.repo.sync",
  input: z.object({ repo: RepoName }),
  output: z.object({ written: z.number() }),
} as const;

export const PrState = z.enum(["open", "merged", "closed"]);
export type PrState = z.infer<typeof PrState>;

export const ChecksState = z.enum(["none", "pending", "green", "red"]);
export type ChecksState = z.infer<typeof ChecksState>;

export const PipelineKind = z.enum(["head", "merge-result", "train", "branch", "tag", "schedule"]);
export type PipelineKind = z.infer<typeof PipelineKind>;

export const RunState = z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]);
export type RunState = z.infer<typeof RunState>;

export const PrPipeline = z.object({
  pipeline: z.number(),
  kind: PipelineKind,
  state: RunState,
  sourceSha: z.string(),
  targetSha: z.string().optional(),
  mergeSha: z.string().optional(),
});
export type PrPipeline = z.infer<typeof PrPipeline>;

export const ObservedPr = z.object({
  pr: PrRef,
  state: PrState,
  title: z.string(),
  branch: z.string(),
  base: z.string(),
  draft: z.boolean(),
  author: z.string().optional(),
  head: z.string().optional(),
  checks: ChecksState,
  pipelines: z.array(PrPipeline),
});
export type ObservedPr = z.infer<typeof ObservedPr>;

export const prListAction = {
  name: "forge.pr.list",
  input: z.object({ repo: RepoName.optional(), state: PrState.optional() }),
  output: z.object({ items: z.array(ObservedPr) }),
} as const;

export const PendingMerge = z.object({
  pr: PrRef,
  mode: z.enum(["auto-merge", "train"]),
  externalId: z.string(),
  expectHead: z.string(),
  cancel: z.object({ action: z.string(), input: z.object({ repo: RepoName, number: z.number() }) }),
});
export type PendingMerge = z.infer<typeof PendingMerge>;

export const pendingAction = {
  name: "forge.pr.merge.pending",
  input: z.object({}),
  output: z.object({ items: z.array(PendingMerge) }),
} as const;

export const cancelMergeAction = {
  name: "forge.pr.merge.cancel",
  input: z.object({ repo: RepoName, number: z.number() }),
  output: z.object({ cancelled: z.boolean() }),
} as const;
