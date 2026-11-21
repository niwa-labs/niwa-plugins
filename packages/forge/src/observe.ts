/**
 * Watching a repository: what the module records of a server it polls.
 *
 * One pass (`sync`) reads the server and writes what changed since the journal last said:
 *
 * - The project's event log gives pushes, pull requests opened, merged and closed, approvals and
 *   comments. Each is written under the server's event id, so an event read twice is one record,
 *   and the journal is the cursor: the next pass reads on after the last event it holds.
 * - Pull requests, pipelines, jobs and checks have no events of their own. Their state is compared
 *   with the last one the journal holds; a change is written as a new version of the observation,
 *   with the state before it. A record of a version never carries the time of the pass, so a pass
 *   that is made again writes the same record.
 *
 * Passes of one repository never overlap, so a version is never claimed twice.
 */

import { createHash } from "node:crypto";

import { IntegrityError, seq } from "@niwa-labs/core";
import type { EmitOptions, JournalReader, RecordType, StoredRecord } from "@niwa-labs/core";

import { ForgeError } from "./gitlab.ts";
import type { GitLab } from "./gitlab.ts";
import { checksOf, lookupsOf, pipelineOf, pullRequestOf, runStateOf } from "./normalize.ts";
import type { GitLabJob, GitLabMr, GitLabPipeline } from "./normalize.ts";
import { inTrain, pendingMerges } from "./merge.ts";
import {
  ChecksObserved,
  JobObserved,
  MergeArmed,
  MergeDisarmed,
  PipelineObserved,
  PrClosed,
  PrComment,
  PrHead,
  PrMerged,
  PrOpened,
  PrReview,
  PrUpdated,
  Pushed,
} from "./record-types.ts";
import type { ChecksState, PrRef, Repo, RunState, Source } from "./record-types.ts";
import { projectPath } from "./servers.ts";

/** An event of a project's log, as much of it as the module reads. */
export interface GitLabEvent {
  id: number;
  action_name: string;
  target_type?: string | null;
  target_iid?: number | null;
  author?: { username?: string } | null;
  push_data?: { ref?: string | null; ref_type?: string; commit_from?: string | null; commit_to?: string | null } | null;
  note?: { id: number; body?: string; noteable_type?: string; noteable_iid?: number; author?: { username?: string } } | null;
  created_at?: string;
}

/** How a pass writes: a record of the module's own type under an id of its own. */
export type Emit = <T>(type: RecordType<T>, data: T, opts: EmitOptions) => Promise<StoredRecord>;

/** What a pass needs. */
export interface SyncPlace {
  readonly gitlab: GitLab;
  readonly journal: JournalReader;
  readonly emit: Emit;
  /** What was absorbed of the repository's records in earlier passes. Default: nothing, read afresh. */
  readonly seen?: Seen;
}

const NULL_SHA = /^0+$/;

/** The states of a pipeline that has not ended and is not waiting for a person: its jobs still move. */
const ACTIVE = new Set<RunState>(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]);

/** The id of a record a pass writes: `forge:<host>:<project>:<what>`. */
function idOf(repo: Repo, what: string): string {
  return `forge:${repo.host}:${String(repo.projectId)}:${what}`;
}

/** The digest of foreign text, as a record holds it. */
function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const SEEN_TYPES = [Pushed, PrOpened, PrUpdated, PrHead, PrReview, PrComment, PrMerged, PrClosed, PipelineObserved, JobObserved, ChecksObserved];

/**
 * What the journal holds of one repository: a projection kept from pass to pass, so that a pass does
 * not read the whole history of the host again. It changes only by absorbing the records the journal
 * gained since the last one it took, so a record is never counted twice.
 */
export class Seen {
  /** The position of the last record absorbed. */
  #upto = 0;
  /** The highest event id written. */
  lastEvent = 0;
  /** The pull requests whose opening, merge or close is written. */
  readonly opened = new Set<number>();
  readonly merged = new Set<number>();
  readonly closed = new Set<number>();
  /** The last head, fields and checks written of each pull request, and how many observations of each. */
  readonly heads = new Map<number, { head: string; version: number }>();
  readonly fields = new Map<number, { title: string; base: string; draft: boolean; version: number }>();
  readonly checks = new Map<number, { head: string; state: ChecksState; version: number }>();
  /** The last state and version of each pipeline and job. */
  readonly pipelines = new Map<number, { state: RunState; version: number }>();
  readonly jobs = new Map<number, { state: RunState; version: number }>();

  readonly #repo: Repo;

  constructor(repo: Repo) {
    this.#repo = repo;
  }

  /** Take the records the journal gained since the last absorbed one. */
  absorb(journal: JournalReader): void {
    const repo = this.#repo;
    const ours = (data: { repo?: Repo; pr?: PrRef }) => (data.repo ?? data.pr?.repo)?.projectId === repo.projectId && (data.repo ?? data.pr?.repo)?.host === repo.host;
    const byName = new Map<string, RecordType<any>>(SEEN_TYPES.map((type) => [type.name, type]));
    for (const stored of journal.since(seq(this.#upto), SEEN_TYPES.map((type) => type.name))) {
      this.#upto = Number(stored.seq);
      const type = byName.get(stored.type);
      const parsed = type?.schema.safeParse(stored.data);
      if (parsed === undefined || !parsed.success) continue;
      const data = parsed.data as { repo?: Repo; pr?: PrRef; source: Source } & Record<string, unknown>;
      if (!ours(data)) continue;
      if (data.source.kind === "event") this.lastEvent = Math.max(this.lastEvent, data.source.id);
      const version = data.source.kind === "observed" ? data.source.version : 0;
      const number = data.pr?.number ?? -1;
      const at = <V extends { version: number }>(map: Map<number, V>, key: number, value: Omit<V, "version">) =>
        map.set(key, { ...value, version: Math.max(version, map.get(key)?.version ?? 0) } as V);
      switch (stored.type) {
        case PrOpened.name: {
          this.opened.add(number);
          const opened = data as unknown as { title: string; base: string };
          if (!this.fields.has(number)) this.fields.set(number, { title: opened.title, base: opened.base, draft: false, version: 0 });
          break;
        }
        case PrMerged.name:
          this.merged.add(number);
          break;
        case PrClosed.name:
          this.closed.add(number);
          break;
        case PrHead.name:
          at(this.heads, number, { head: data["head"] as string });
          break;
        case PrUpdated.name:
          at(this.fields, number, { title: data["title"] as string, base: data["base"] as string, draft: data["draft"] as boolean });
          break;
        case ChecksObserved.name:
          at(this.checks, number, { head: data["head"] as string, state: data["state"] as ChecksState });
          break;
        case PipelineObserved.name:
          at(this.pipelines, data["pipeline"] as number, { state: data["state"] as RunState });
          break;
        case JobObserved.name:
          at(this.jobs, data["job"] as number, { state: data["state"] as RunState });
          break;
      }
    }
  }
}

/**
 * One pass over a repository: what changed is written, and how many records that made. `since` is
 * the last event of the log when the repository was watched: what came before is not news.
 */
export async function sync(place: SyncPlace, repo: Repo, since = 0): Promise<number> {
  const { gitlab } = place;
  const seen = place.seen ?? new Seen(repo);
  seen.absorb(place.journal);
  let written = 0;
  const write = async <T>(type: RecordType<T>, data: T, id: string): Promise<void> => {
    try {
      await place.emit(type, data, { id });
      written += 1;
      seen.absorb(place.journal);
    } catch (error) {
      // The same id with other content: a pass that was cut off wrote this version already.
      if (!(error instanceof IntegrityError)) throw error;
    }
  };
  const mrOf = async (iid: number): Promise<GitLabMr | undefined> => {
    try {
      return await gitlab.get<GitLabMr>(projectPath(repo, `/merge_requests/${String(iid)}`));
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not-found") return undefined;
      throw error;
    }
  };
  const pr = (number: number): PrRef => ({ repo, number });

  // The event log, newest first until an event the journal holds, then written oldest first.
  const after = Math.max(seen.lastEvent, since);
  const events = (await gitlab.list<GitLabEvent>(projectPath(repo, "/events"), { sort: "desc" }, (page) => page.some((event) => event.id <= after)))
    .filter((event) => event.id > after)
    .sort((a, b) => a.id - b.id);
  for (const event of events) {
    const source: Source = { kind: "event", id: event.id };
    const id = idOf(repo, `event:${String(event.id)}`);
    const author = event.author?.username;
    const push = event.push_data;
    if (push?.ref !== undefined && push.ref !== null && /^pushed|^deleted/.test(event.action_name)) {
      const before = push.commit_from ?? undefined;
      const after = push.commit_to ?? undefined;
      await write(
        Pushed,
        {
          repo,
          ref: push.ref,
          refType: push.ref_type === "tag" ? "tag" : "branch",
          ...(before === undefined || NULL_SHA.test(before) ? {} : { before }),
          ...(after === undefined || NULL_SHA.test(after) ? {} : { after }),
          ...(author === undefined ? {} : { author }),
          source,
        },
        id,
      );
      continue;
    }
    const note = event.note;
    if (note !== undefined && note !== null && note.noteable_type === "MergeRequest" && note.noteable_iid !== undefined) {
      const body = note.body ?? "";
      await write(
        PrComment,
        {
          pr: pr(note.noteable_iid),
          comment: note.id,
          author: note.author?.username ?? author ?? "",
          size: Buffer.byteLength(body, "utf8"),
          digest: digestOf(body),
          source,
        },
        id,
      );
      continue;
    }
    if (event.target_type !== "MergeRequest" || event.target_iid === undefined || event.target_iid === null) continue;
    const number = event.target_iid;
    if (event.action_name === "approved" || event.action_name === "unapproved") {
      await write(PrReview, { pr: pr(number), reviewer: author ?? "", state: event.action_name, source }, id);
      continue;
    }
    if (!["opened", "accepted", "closed"].includes(event.action_name)) continue;
    const mr = await mrOf(number);
    if (mr === undefined) continue;
    if (event.action_name === "opened") {
      await write(PrOpened, { pr: pr(number), title: mr.title, branch: mr.source_branch, base: mr.target_branch, ...(author === undefined ? {} : { author }), source }, id);
    } else if (event.action_name === "accepted") {
      const made = pullRequestOf(repo, mr);
      await write(PrMerged, { pr: pr(number), base: mr.target_branch, head: mr.sha, ...(made.mergeSha === undefined ? {} : { mergeSha: made.mergeSha }), ...(author === undefined ? {} : { by: author }), source }, id);
    } else {
      await write(PrClosed, { pr: pr(number), ...(author === undefined ? {} : { by: author }), source }, id);
    }
  }

  // Pull requests: the open ones, and the ones whose end the journal does not hold yet.
  const known = new Set([...seen.opened].filter((number) => !seen.merged.has(number) && !seen.closed.has(number)));
  const open = await gitlab.list<GitLabMr>(projectPath(repo, "/merge_requests"), { state: "opened" });
  const ended = await Promise.all([...known].filter((number) => !open.some((mr) => mr.iid === number)).map((number) => mrOf(number)));
  for (const mr of [...open, ...ended]) {
    if (mr === undefined) continue;
    const number = mr.iid;
    const observed = (version: number): Source => ({ kind: "observed", version });
    if (!seen.opened.has(number)) {
      await write(PrOpened, { pr: pr(number), title: mr.title, branch: mr.source_branch, base: mr.target_branch, ...(mr.author?.username === undefined ? {} : { author: mr.author.username }), source: observed(1) }, idOf(repo, `pr:${String(number)}:opened`));
    }
    const head = seen.heads.get(number);
    if (head?.head !== mr.sha) {
      const version = (head?.version ?? 0) + 1;
      await write(PrHead, { pr: pr(number), head: mr.sha, ...(head === undefined ? {} : { previous: head.head }), source: observed(version) }, idOf(repo, `pr:${String(number)}:head:v${String(version)}`));
    }
    const fields = seen.fields.get(number);
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    if (fields !== undefined && (fields.title !== mr.title || fields.base !== mr.target_branch || fields.draft !== draft)) {
      const version = fields.version + 1;
      await write(PrUpdated, { pr: pr(number), title: mr.title, base: mr.target_branch, draft, source: observed(version) }, idOf(repo, `pr:${String(number)}:updated:v${String(version)}`));
    }
    if (mr.state === "merged" && !seen.merged.has(number)) {
      const made = pullRequestOf(repo, mr);
      await write(PrMerged, { pr: pr(number), base: mr.target_branch, head: mr.sha, ...(made.mergeSha === undefined ? {} : { mergeSha: made.mergeSha }), source: observed(1) }, idOf(repo, `pr:${String(number)}:merged`));
    }
    if (mr.state === "closed" && !seen.closed.has(number)) {
      await write(PrClosed, { pr: pr(number), source: observed(1) }, idOf(repo, `pr:${String(number)}:closed`));
    }
  }

  // Pipelines and their jobs: a state that differs from the last one written is a new version.
  const lookups = lookupsOf(gitlab, repo);
  const raw = await gitlab.get<GitLabPipeline[]>(projectPath(repo, "/pipelines"), { per_page: 50, order_by: "updated_at", sort: "desc" });
  for (const one of [...raw].sort((a, b) => a.id - b.id)) {
    const last = seen.pipelines.get(one.id);
    const state = runStateOf(one.status);
    const changed = last?.state !== state;
    // A pipeline that is still moving has jobs that move with it, whether or not its own state did.
    if (!changed && !ACTIVE.has(state)) continue;
    const pipeline = changed ? await pipelineOf(repo, one, lookups) : undefined;
    if (changed && pipeline === undefined) continue;
    // The jobs are written before the pipeline's new version: a pass cut off in between leaves the
    // pipeline changed, and the next pass reads its jobs again.
    for (const job of await gitlab.list<GitLabJob>(projectPath(repo, `/pipelines/${String(one.id)}/jobs`))) {
      const was = seen.jobs.get(job.id);
      const jobState = runStateOf(job.status);
      if (was?.state === jobState) continue;
      const jobVersion = (was?.version ?? 0) + 1;
      await write(
        JobObserved,
        { repo, pipeline: one.id, job: job.id, name: job.name, stage: job.stage, state: jobState, ...(was === undefined ? {} : { previous: was.state }), source: { kind: "observed", version: jobVersion } },
        idOf(repo, `job:${String(job.id)}:v${String(jobVersion)}`),
      );
    }
    if (pipeline === undefined) continue;
    const version = (last?.version ?? 0) + 1;
    await write(PipelineObserved, { ...pipeline, ...(last === undefined ? {} : { previous: last.state }), source: { kind: "observed", version } }, idOf(repo, `pipeline:${String(one.id)}:v${String(version)}`));
  }

  // Checks of the open pull requests, from the pipelines of their heads.
  for (const mr of open) {
    const pipelines = await gitlab.list<GitLabPipeline>(projectPath(repo, `/merge_requests/${String(mr.iid)}/pipelines`));
    const made = await Promise.all(pipelines.map((one) => pipelineOf(repo, one, lookups)));
    const checks = checksOf(made.filter((one) => one !== undefined && one.sourceSha === mr.sha).map((one) => one!));
    const last = seen.checks.get(mr.iid);
    if (last?.head === mr.sha && last.state === checks.state) continue;
    const version = (last?.version ?? 0) + 1;
    await write(
      ChecksObserved,
      { pr: pr(mr.iid), head: mr.sha, ...checks, ...(last === undefined ? {} : { previous: last.state }), source: { kind: "observed", version } },
      idOf(repo, `pr:${String(mr.iid)}:checks:v${String(version)}`),
    );
  }
  // Merges the server took for later and dropped on its own, or that somebody called off there: an open
  // pull request no longer armed or in the train is no longer pending.
  for (const one of pendingMerges(place.journal)) {
    if (one.pr.repo.host !== repo.host || one.pr.repo.projectId !== repo.projectId) continue;
    const mr = await mrOf(one.pr.number);
    if (mr?.state !== "opened") continue;
    const dropped = one.mode === "auto-merge" ? mr.merge_when_pipeline_succeeds !== true : !(await inTrain(gitlab, one.pr));
    if (!dropped) continue;
    const armings = place.journal
      .since(seq(0), [MergeArmed.name])
      .filter((stored) => MergeArmed.schema.safeParse(stored.data).data?.externalId === one.externalId).length;
    await write(MergeDisarmed, { pr: one.pr, externalId: one.externalId }, idOf(repo, `pr:${String(one.pr.number)}:disarmed:${String(armings)}`));
  }
  return written;
}

/** How long to wait between two passes over a repository. */
export interface PollIntervals {
  /** While a run waits on the repository. Default: 20 seconds. */
  readonly awaited: number;
  /** While something changed in the last hour. Default: 2 minutes. */
  readonly background: number;
  /** After an hour with no change. Default: 5 minutes. */
  readonly quiet: number;
}

export const DEFAULT_INTERVALS: PollIntervals = { awaited: 20_000, background: 120_000, quiet: 300_000 };

/** An hour: how long with no change before a repository is polled as quiet. */
const QUIET_AFTER_MS = 3_600_000;

/** The interval of the next pass over a repository. */
export function pollInterval(state: { awaited: boolean; lastChangeAt: number; now: number }, intervals: PollIntervals = DEFAULT_INTERVALS): number {
  if (state.awaited) return intervals.awaited;
  return state.now - state.lastChangeAt >= QUIET_AFTER_MS ? intervals.quiet : intervals.background;
}

/** What the poller knows of one repository. */
interface Polled {
  lastPassAt: number;
  lastChangeAt: number;
  awaitedUntil: number;
}

/**
 * When each watched repository is polled next: a repository a run waits on every 20 seconds, one that
 * changed in the last hour every 2 minutes, a quiet one every 5. A server whose limit is spent is not
 * asked before it may be.
 */
export class Poller {
  readonly #polled = new Map<string, Polled>();
  readonly #intervals: PollIntervals;
  /** How long a read by a caller keeps a repository awaited. */
  readonly #awaitedFor: number;

  constructor(intervals: PollIntervals = DEFAULT_INTERVALS, awaitedFor = 600_000) {
    this.#intervals = intervals;
    this.#awaitedFor = awaitedFor;
  }

  /** A caller read the repository: something waits on it now. */
  touch(key: string, now: number): void {
    const known = this.#of(key, now);
    known.awaitedUntil = now + this.#awaitedFor;
  }

  /** The repositories of `keys` whose next pass is due at `now`. */
  due(keys: readonly string[], now: number, waitMs: (key: string) => number): string[] {
    return keys.filter((key) => {
      const known = this.#polled.get(key);
      if (known === undefined) return waitMs(key) === 0;
      const interval = pollInterval({ awaited: known.awaitedUntil > now, lastChangeAt: known.lastChangeAt, now }, this.#intervals);
      return now - known.lastPassAt >= interval && waitMs(key) === 0;
    });
  }

  /** A pass over a repository ended, having written `written` records. */
  passed(key: string, now: number, written: number): void {
    const known = this.#of(key, now);
    known.lastPassAt = now;
    if (written > 0) known.lastChangeAt = now;
  }

  #of(key: string, now: number): Polled {
    const known = this.#polled.get(key);
    if (known !== undefined) return known;
    const made: Polled = { lastPassAt: Number.NEGATIVE_INFINITY, lastChangeAt: now, awaitedUntil: 0 };
    this.#polled.set(key, made);
    return made;
  }
}
