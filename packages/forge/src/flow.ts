/**
 * The script helpers of the forge module: wait for the pipeline of a commit, land a pull request, wait
 * for a pull request to end or for its head to move. They wait for the queries of `./queries.ts`.
 *
 * They run inside a workflow script and use its globals (`call`, `wait`, `now`, `race`), read when a
 * helper is called, so this file imports nothing of the script runtime. Every call a helper makes is
 * labeled from the key it is given: a replay of the script finds each answer where it left it, and
 * two helpers in one script need two keys.
 */

import type { TypeQuery } from "@niwa-labs/core";
import type { z } from "zod";

import { forgePipelineRead, forgePrMerge, forgePrRead } from "./actions.ts";
import type { MergeOutcome, PullRequest } from "./actions.ts";
import { verdictOf as stateVerdict } from "./normalize.ts";
import type { Pipeline, PipelineKind, PrClosed, PrMerged } from "./record-types.ts";
import { mergeDisarmed, pipelineOf, prClosed, prHead, prMerged } from "./queries.ts";
import type { RepoName } from "./targets.ts";

/** A duration as a script writes it: milliseconds, or "500ms", "30s", "5m", "2h", "1d". */
export type Duration = number | string;

interface Labeled {
  label?: string;
}

/** What the helpers take of a script's globals. */
interface ScriptGlobals {
  call(name: string, input: unknown, opts?: Labeled): Promise<any>;
  wait<D>(query: TypeQuery<D>, opts: { from?: number; timeout?: Duration; label?: string }): Promise<{ data: D; at: number } | { timedOut: true }>;
  now(opts?: Labeled): Promise<number>;
  race<K extends string, T>(name: string, branches: Record<K, () => Promise<T>>): Promise<{ key: K; value: T }>;
}

/** What a wait answers when the data's type does not matter: the branches of a race answer alike. */
type Waited = { data: unknown; at: number } | { timedOut: true };

/** The globals of the script that calls a helper. */
function script(): ScriptGlobals {
  const globals = globalThis as unknown as Partial<ScriptGlobals>;
  for (const name of ["call", "wait", "now", "race"] as const) {
    if (typeof globals[name] !== "function") throw new Error(`@niwa-labs/forge/flow runs inside a workflow script: "${name}" is not a global here`);
  }
  return globals as ScriptGlobals;
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration in milliseconds. */
export function durationMs(duration: Duration): number {
  if (typeof duration === "number") return duration;
  const parsed = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration.trim());
  if (parsed === null) throw new TypeError(`not a duration: ${JSON.stringify(duration)} (milliseconds, or a number with ms, s, m, h or d)`);
  return Number(parsed[1]) * (UNITS[parsed[2] as string] as number);
}

/**
 * The repository as the actions name it, `{ host, path }`: a record holds more (the project id), and
 * an action takes no more than its target names.
 */
function nameOf(repo: RepoName): RepoName {
  return { host: repo.host, path: repo.path };
}

/** How long one wait lasts before the helper reads the server again. */
const ROUND_MS = 300_000;

/** What became of the pipeline of a commit. */
export type PipelineOutcome = { outcome: "green" | "red" | "timed-out"; pipeline?: number };

/**
 * What the latest pipeline of a list says, as the checks of a pull request say it: green or red, or
 * undefined while it is pending (a pipeline that waits on a manual job too) or was skipped.
 */
function verdictOf(items: readonly Pipeline[]): PipelineOutcome | undefined {
  const latest = [...items].sort((a, b) => b.pipeline - a.pipeline)[0];
  if (latest === undefined) return undefined;
  const verdict = stateVerdict(latest.state);
  return verdict === "green" || verdict === "red" ? { outcome: verdict, pipeline: latest.pipeline } : undefined;
}

/**
 * Wait until the latest pipeline of a commit is green (success) or red (a failure or a cancel), or
 * `timed-out` at the deadline: a pipeline that waits on a manual job is still pending. `kind` takes only pipelines of that kind (a merge result, say),
 * matched by the commit of the change they ran for. The server is read first, so a pipeline that
 * settled before the call answers at once; then the helper waits for the module's records of the
 * commit and reads again, which also keeps the repository polled at its fastest while it waits.
 */
export async function untilPipeline(
  key: string,
  opts: { repo: RepoName; sha: string; kind?: PipelineKind; deadline: Duration },
): Promise<PipelineOutcome> {
  const api = script();
  const started = await api.now({ label: `${key}-start` });
  const until = started + durationMs(opts.deadline);
  const repo = nameOf(opts.repo);
  const query = pipelineOf({ repo, sha: opts.sha, ...(opts.kind === undefined ? {} : { kind: opts.kind }) });
  let from: number | undefined;
  for (let round = 1; ; round += 1) {
    const read = await api.call(forgePipelineRead.name, { repo, sha: opts.sha, ...(opts.kind === undefined ? {} : { kind: opts.kind }) }, { label: `${key}-read-${String(round)}` });
    const settled = verdictOf((read as { items: Pipeline[] }).items);
    if (settled !== undefined) return settled;
    const now = await api.now({ label: `${key}-now-${String(round)}` });
    if (now >= until) return { outcome: "timed-out" };
    const waited = await api.wait(query, {
      ...(from === undefined ? {} : { from }),
      timeout: Math.min(ROUND_MS, until - now),
      label: `${key}-wait-${String(round)}`,
    });
    if (!("timedOut" in waited)) from = waited.at;
  }
}

/** A pull request a helper is given. */
export interface PrRefGiven {
  readonly repo: RepoName;
  readonly number: number;
}

/** What became of a landing. */
export type LandOutcome = { outcome: "merged"; sha: string } | { outcome: "refused" | "queued-unknown"; why: string };

/**
 * Merge a pull request at the head the caller expects. With `auto`, the server is armed to merge when
 * the pipeline succeeds and the helper waits for the merge, until `deadline` (default 2h): a pull
 * request merged at another head, closed, or called off is refused; still waiting at the deadline is
 * `queued-unknown`, for the server still has it.
 *
 * The module's records of the merge are waited for in rounds, and between rounds the pull request is
 * read from the server (`forge.pr.read` on the repository must be in the script's `uses`): a merge
 * recorded before the waits began, or never recorded because the repository is not watched, is found
 * by the read, and so is a merge the server dropped without a record.
 */
export async function land(
  key: string,
  opts: { pr: PrRefGiven; expectHead: string; method: "merge" | "squash" | "rebase"; auto?: boolean; deadline?: Duration },
): Promise<LandOutcome> {
  const api = script();
  const repo = nameOf(opts.pr.repo);
  const asked = (await api.call(
    forgePrMerge.name,
    { repo, number: opts.pr.number, expectHead: opts.expectHead, method: opts.method, when: opts.auto === true ? "pipeline" : "now" },
    { label: `${key}-merge` },
  )) as MergeOutcome;
  if (asked.outcome === "merged") return { outcome: "merged", sha: asked.sha };
  if (asked.outcome === "refused") return { outcome: "refused", why: asked.why };
  const pr = { repo, number: opts.pr.number };
  const started = await api.now({ label: `${key}-start` });
  const until = started + durationMs(opts.deadline ?? "2h");
  const mergedAt = (head: string | undefined, sha: string | undefined): LandOutcome =>
    head !== undefined && head !== opts.expectHead
      ? { outcome: "refused", why: `${asked.externalId} was merged at ${head}, not at ${opts.expectHead}` }
      : { outcome: "merged", sha: sha ?? opts.expectHead };
  for (let round = 1; ; round += 1) {
    const now = round === 1 ? started : await api.now({ label: `${key}-now-${String(round)}` });
    if (now >= until && round > 1) return { outcome: "queued-unknown", why: `the server took the merge as ${asked.externalId} and has not made it yet` };
    const timeout = Math.max(1, Math.min(ROUND_MS, until - now));
    const ended = await api.race<"merged" | "closed" | "disarmed", Waited>(`${key}-end-${String(round)}`, {
      merged: () => api.wait(prMerged(pr), { timeout, label: `${key}-merged-${String(round)}` }),
      closed: () => api.wait(prClosed(pr), { timeout, label: `${key}-closed-${String(round)}` }),
      disarmed: () => api.wait(mergeDisarmed(pr), { timeout, label: `${key}-disarmed-${String(round)}` }),
    });
    const waited = ended.value;
    if (!("timedOut" in waited)) {
      if (ended.key === "closed") return { outcome: "refused", why: `${asked.externalId} was closed before the server merged it` };
      if (ended.key === "disarmed") return { outcome: "refused", why: `the merge of ${asked.externalId} was called off` };
      const merged = waited.data as z.output<typeof PrMerged.schema>;
      return mergedAt(merged.head, merged.mergeSha);
    }
    const read = (await api.call(forgePrRead.name, { repo, number: opts.pr.number }, { label: `${key}-read-${String(round)}` })) as PullRequest;
    if (read.state === "merged") return mergedAt(read.head, read.mergeSha);
    if (read.state === "closed") return { outcome: "refused", why: `${asked.externalId} was closed before the server merged it` };
    if (read.state === "open" && !read.autoMerge) return { outcome: "refused", why: `the server no longer holds the merge of ${asked.externalId}` };
  }
}

/** What became of the head of a pull request while a script waited for it to move. */
export type HeadMove = { moved: true; head: string; previous?: string; at: number } | { moved: false };

/**
 * Wait until the head of a pull request moves (new commits, a rebase, a force push) after `from`, a
 * position an earlier wait or read answered, or after the wait began; `moved: false` at the timeout.
 * Without a timeout it waits for ever. It waits for the module's record of the move, so the repository
 * must be watched; `at` is the position to wait on from.
 */
export async function untilHeadMoved(key: string, opts: { pr: PrRefGiven; from?: number; timeout?: Duration }): Promise<HeadMove> {
  const waited = await script().wait(prHead({ repo: nameOf(opts.pr.repo), number: opts.pr.number }), {
    ...(opts.from === undefined ? {} : { from: opts.from }),
    ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
    label: key,
  });
  if ("timedOut" in waited) return { moved: false };
  const { head, previous } = waited.data;
  return { moved: true, head, ...(previous === undefined ? {} : { previous }), at: waited.at };
}

/** How a pull request ended while a script waited for it: merged or closed, and where, or not by the timeout. */
export type PrEnd =
  | { ended: "merged"; head?: string; mergeSha?: string; by?: string; at: number }
  | { ended: "closed"; by?: string; at: number }
  | { ended: false };

/**
 * Wait until a pull request is merged or closed after `from`, a position an earlier wait or read
 * answered, or after the wait began: whichever the module records first answers at once, and the other
 * wait is cancelled. `ended: false` at the timeout; without one it waits for ever. It waits for the
 * module's records, so the repository must be watched; `at` is the position of the record.
 */
export async function untilPrEnded(key: string, opts: { pr: PrRefGiven; from?: number; timeout?: Duration }): Promise<PrEnd> {
  const api = script();
  const pr = { repo: nameOf(opts.pr.repo), number: opts.pr.number };
  const how = { ...(opts.from === undefined ? {} : { from: opts.from }), ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }) };
  const ended = await api.race<"merged" | "closed", Waited>(key, {
    merged: () => api.wait(prMerged(pr), { ...how, label: `${key}-merged` }),
    closed: () => api.wait(prClosed(pr), { ...how, label: `${key}-closed` }),
  });
  const waited = ended.value;
  if ("timedOut" in waited) return { ended: false };
  if (ended.key === "closed") {
    const { by } = waited.data as z.output<typeof PrClosed.schema>;
    return { ended: "closed", ...(by === undefined ? {} : { by }), at: waited.at };
  }
  const { head, mergeSha, by } = waited.data as z.output<typeof PrMerged.schema>;
  return {
    ended: "merged",
    ...(head === undefined ? {} : { head }),
    ...(mergeSha === undefined ? {} : { mergeSha }),
    ...(by === undefined ? {} : { by }),
    at: waited.at,
  };
}
