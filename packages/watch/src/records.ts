/**
 * The records of the watch plugin, and the typed references of its actions.
 *
 * A subject is something that works and can stop working: a session or a run, named
 * `session:<harness> <native id>` or `run:<id>`. The watch writes only two facts about a subject,
 * that it is stuck and that it is not any more; what to do about it is a workflow subscribed to
 * those records.
 */

import { z } from "zod";

import { actionRef, record } from "@niwa-labs/core";

/** What a subject is doing, as the journal shows it. */
export const WatchState = z.enum([
  /** Making progress: a turn or a step is going on and signs of life keep coming. */
  "working",
  /** Waiting for a person: a question is open, or a run is paused for a decision. */
  "waiting-human",
  /** Waiting for something to happen: a run is suspended on a record or on another run's work. */
  "waiting-event",
  /** Waiting for a moment: a timer will wake it. */
  "sleeping",
  /** Nothing to do: a session between turns, a run not yet started. */
  "idle",
  /** Working, but repeating itself without anything changing. */
  "looping",
  /** Should be working and is not, or was told to stop and does not. */
  "stuck",
  /** The journal does not say: a watch began, or a turn ended with no known outcome. */
  "unknown",
]);
export type WatchState = z.infer<typeof WatchState>;

/**
 * Why a subject counts as stuck:
 *
 * - `silent` — it is working and has given no sign of life for too long;
 * - `looping` — it repeats the same thing and nothing changes;
 * - `shielded-cancel` — the run was cancelled and a shielded scope inside it still goes on.
 */
export const StuckKind = z.enum(["silent", "looping", "shielded-cancel"]);
export type StuckKind = z.infer<typeof StuckKind>;

/** A session or a run: `session:<harness> <native id>`, `run:<id>`. */
export const Subject = z.string().regex(/^(session|run):\S.*$/, "a subject is session:<harness> <id> or run:<id>").brand<"WatchSubject">();
export type Subject = z.infer<typeof Subject>;

/** The subject of a session, from the harness and the id the harness gave it. */
export function sessionSubject(harness: string, native: string): Subject {
  return Subject.parse(`session:${harness} ${native}`);
}

/** The subject of a run. */
export function runSubject(run: string): Subject {
  return Subject.parse(`run:${run}`);
}

/**
 * A subject is stuck.
 *
 * `since` is when the condition began (for silence: the end of the time it was allowed to be
 * quiet), `last` is the moment of its last sign of life. Both are milliseconds since the epoch.
 * A subject is flagged once for one condition: another record follows only after `watch.recovered`.
 */
export const WatchStuck = record(
  "watch.stuck",
  z.object({
    subject: Subject,
    since: z.number().int().nonnegative(),
    last: z.number().int().nonnegative(),
    kind: StuckKind,
  }),
);
export type WatchStuckData = z.infer<typeof WatchStuck.schema>;

/**
 * The condition of a `watch.stuck` is over: the subject gave a sign of life, stopped repeating
 * itself, ended, or its shielded scope closed. It names the record it closes by `subject`, `kind`
 * and `since`.
 */
export const WatchRecovered = record(
  "watch.recovered",
  z.object({
    subject: Subject,
    since: z.number().int().nonnegative(),
    kind: StuckKind,
  }),
);
export type WatchRecoveredData = z.infer<typeof WatchRecovered.schema>;

/** The record types the watch plugin declares. */
export const WATCH_TYPES = [WatchStuck, WatchRecovered] as const;

/** One subject as the watch reads it now. */
export const Reading = z.object({
  subject: Subject,
  state: WatchState,
  /** When the subject entered this state, in milliseconds since the epoch. */
  since: z.number().int().nonnegative(),
  /** Its last sign of life. */
  last: z.number().int().nonnegative(),
  /** Why it is stuck or looping; present exactly for those two states. */
  kind: StuckKind.optional(),
});
export type Reading = z.infer<typeof Reading>;

export const watchGet = actionRef("watch.get", {
  description: "Read the state of a session or a run from the journal: what it is doing, since when, and its last sign of life.",
  input: z.object({ subject: Subject }),
  output: Reading,
  target: (input) => input.subject,
});

export const watchList = actionRef("watch.list", {
  description:
    "List the sessions and runs the watch follows, each with its state. `state` keeps those in one state, such as `stuck`.",
  input: z.object({ state: WatchState.optional() }),
  output: z.object({ subjects: z.array(Reading) }),
});
