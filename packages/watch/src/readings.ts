/**
 * What the watch knows, folded from the journal records it reads.
 *
 * The model is fed record by record (`Model.apply`) and asked, at a moment, what every subject is
 * doing (`Model.readings`). It reads records by type name and parses only the fields it needs, so a
 * record it cannot read is passed over and a plugin it does not know of is not required. Time is
 * given, never read: the same records and the same moment always give the same readings.
 *
 * The sources are: the turns, activity and progress of sessions, the pauses, log, phases, scopes and steps of
 * runs, the requests and sleeps that hold either, a head that moved, and the watch's own flags.
 */

import { z } from "zod";

import { keyUnder, stableJson } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";

import { Subject, runSubject, sessionSubject } from "./records.ts";
import type { Reading, StuckKind, WatchRecoveredData, WatchStuckData } from "./records.ts";

/** The record types, and families, the model reads. */
export const SOURCES: readonly string[] = [
  "session.*",
  "history.session.*",
  "request.*",
  "timer.sleep.requested",
  "timer.slept",
  "git.head.moved",
  "workflow.run.*",
  "workflow.scope.*",
  "workflow.phase.*",
  "niwa.invocation.resolved",
  "niwa.step.intent",
  "niwa.step.outcome",
  "niwa.step.cancelled",
  "niwa.invocation.state",
  "watch.*",
];

/** The limits that decide when a subject is stuck. All durations are milliseconds. */
export interface Settings {
  /** How long a subject that is working may give no sign of life. A session that says its own `stuckAfter` is held to that. */
  readonly silentAfter: number;
  /** How many identical steps in a row make a run loop. */
  readonly loopRepeats: number;
  /** How many identical activities, with no progress between them, make a session loop. */
  readonly sessionLoopRepeats: number;
  /** How long after a cancel a shielded scope may keep a run going. */
  readonly shieldGrace: number;
}

export const DEFAULT_SETTINGS: Settings = {
  silentAfter: 10 * 60_000,
  loopRepeats: 6,
  sessionLoopRepeats: 25,
  shieldGrace: 60_000,
};

// What is read of each record. A field the model does not use is not named.
const Text = z.string().min(1);
const SessionObject = z.object({ harness: Text, native: Text });
/** A session as records name it: the pair as one text (niwa's own), or as an object (the history's). */
const SessionNamed = z.union([Text, SessionObject]);

const OfSession = z.object({ session: SessionNamed });
const Started = z.object({ session: SessionNamed, stuckAfter: z.number().positive().optional() });
const TurnEnded = z.object({ session: SessionNamed, how: z.string().optional() });
const HistoryEnded = z.object({ session: SessionNamed, certainty: z.string().optional() });
const Activity = z.object({ session: SessionNamed, tool: z.string().optional(), permission: z.unknown().optional() });
const OfRun = z.object({ run: Text });
const Scope = z.object({ run: Text, scope: Text, shield: z.boolean().optional() });
const OfInvocation = z.object({ invocation: Text });
const Cancelled = z.object({ invocation: Text, prefixes: z.array(z.string()).optional(), except: z.array(z.string()).optional() });
const Outcome = z.object({ invocation: Text, key: z.string() });
const Intent = z.object({ invocation: Text, key: z.string(), action: z.string(), input: z.unknown() });
/** The keys of the steps the workflow bridge writes beside the step of a call: `<key>~auth`, `~now`, `~mark`, `~arm`, `~ended`. */
const ASIDE = /~(auth|now|mark|arm|ended)$/;
/** The action a sleep records as its step. */
const WAIT_ACTION = "niwa.wait";
/** The action a wait of a script for a record, with or without a timeout, records as its step. */
const SCRIPT_WAIT_ACTION = "workflow.script.wait";
const InvocationState = z.object({ invocation: Text, state: z.string() });
const Paused = z.object({ run: Text, choices: z.array(z.string()).optional() });
const PauseRequested = z.object({ run: Text, kind: z.string().optional() });
const Continued = z.object({ run: Text, pause: z.string() });
const RequestMade = z.object({
  id: Text,
  to: z.object({ kind: z.string() }),
  from: z.object({ kind: z.string(), harness: z.string().optional(), id: z.string().optional() }).optional(),
});
const OfRequest = z.object({ id: Text });
const OfKey = z.object({ key: Text });
const HeadMoved = z.object({ session: SessionNamed.optional() });
const Flag = z.object({ subject: Subject, since: z.number(), kind: z.string() });
const Stuck = Flag.extend({ last: z.number() });

/** How a session is written as a subject, from either form of its name. */
function sessionSubjectOf(named: z.infer<typeof SessionNamed>): Subject {
  if (typeof named !== "string") return sessionSubject(named.harness, named.native);
  return Subject.parse(`session:${named}`);
}

type Base = "idle" | "working" | "unknown";

interface Streak {
  readonly signature: string;
  readonly count: number;
  /** When the first of the identical records was written. */
  readonly from: number;
}

interface Track {
  readonly subject: Subject;
  readonly kind: "session" | "run";
  base: Base;
  /** Whether niwa runs the session and says its turns itself; a session only the history follows is not. */
  managed: boolean;
  since: number;
  last: number;
  stuckAfter?: number;
  streak?: Streak;
  // A run only.
  invocation?: string;
  started: boolean;
  invocationState?: string;
  /** The pause of an error or of a script that cannot go on, until it is answered. */
  pause?: { readonly cancelOnly: boolean };
  /** The pause someone asked for, or the deadline that was reached, until the continue that names it. */
  manual?: { readonly id: string; readonly deadline: boolean };
  /** The requests the subject asked that are open, each with whether it is put to the owner. */
  asked: Map<string, boolean>;
  /** The steps of the run's invocation that have begun and not ended, by key, with the action each calls. */
  steps: Map<string, string>;
  /** The keys of the wakes the run's invocation has asked for and not had. */
  timers: Set<string>;
  /** The shielded scopes that are open, each with the moment a cancel spared it, once one has. */
  shields: Map<string, number | undefined>;
}

/** A flag the watch wrote and has not closed. */
export interface OpenFlag {
  readonly since: number;
  readonly last: number;
  readonly kind: StuckKind;
}

/** A record the watch should write to bring the journal in line with what it reads. */
export type Transition =
  | { readonly type: "stuck"; readonly data: WatchStuckData }
  | { readonly type: "recovered"; readonly data: WatchRecoveredData };

function isKind(value: string): value is StuckKind {
  return value === "silent" || value === "looping" || value === "shielded-cancel";
}

/** The model: every subject the records have named, and what holds each one. */
export class Model {
  private readonly tracks = new Map<Subject, Track>();
  /** The subjects that ended; a sign of life from one is not a reason to follow it again. */
  private readonly gone = new Set<Subject>();
  private readonly byInvocation = new Map<string, Subject>();
  private readonly requests = new Map<string, Subject>();
  private readonly sleeps = new Map<string, Subject>();
  private readonly open = new Map<Subject, OpenFlag>();
  /** The position of the last record applied: a record at or before it was seen already. */
  private seen = 0;

  /**
   * @param floor Silence is counted from the later of a subject's last sign and this moment: the
   * watch cannot say what happened while it was not looking.
   */
  constructor(private floor = 0) {}

  /** From now on, silence is counted from this moment at the earliest. */
  startedAt(moment: number): void {
    this.floor = Math.max(this.floor, moment);
  }

  /** The flags the watch has written and not closed, as its own records say. */
  flags(): ReadonlyMap<Subject, OpenFlag> {
    return this.open;
  }

  /** Fold one record. Records are applied in the order they were committed; one seen before is passed over. */
  apply(row: StoredRecord): void {
    if (row.seq <= this.seen) return;
    this.seen = row.seq;
    const at = row.at as number;
    switch (row.type as string) {
      case "session.started": {
        const data = Started.safeParse(row.data);
        if (!data.success) return;
        const track = this.revive(sessionSubjectOf(data.data.session), "session", at);
        track.managed = true;
        track.base = "idle";
        track.since = at;
        track.last = at;
        if (data.data.stuckAfter !== undefined) track.stuckAfter = data.data.stuckAfter;
        return;
      }
      case "session.turn-started": {
        const data = OfSession.safeParse(row.data);
        if (!data.success) return;
        const track = this.revive(sessionSubjectOf(data.data.session), "session", at);
        track.managed = true;
        this.become(track, "working", at);
        track.streak = undefined;
        return;
      }
      case "session.turn-ended": {
        const data = TurnEnded.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(sessionSubjectOf(data.data.session));
        if (track === undefined) return;
        this.become(track, data.data.how === "unknown" ? "unknown" : "idle", at);
        track.streak = undefined;
        return;
      }
      case "session.activity": {
        const data = Activity.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(sessionSubjectOf(data.data.session)) ?? this.create(sessionSubjectOf(data.data.session), "session", at);
        if (track === undefined) return;
        if (track.base !== "working") this.become(track, "working", at);
        track.last = at;
        // Only a call of a tool names an operation that can repeat; any other sign of life is just that.
        if (data.data.tool !== undefined || data.data.permission !== undefined) {
          this.repeat(track, stableJson([data.data.tool ?? null, data.data.permission ?? null]), at);
        }
        return;
      }
      case "session.progress": {
        const data = OfSession.safeParse(row.data);
        if (!data.success) return;
        const subject = sessionSubjectOf(data.data.session);
        const track = this.known(subject) ?? this.create(subject, "session", at);
        if (track === undefined) return;
        if (track.base !== "working") this.become(track, "working", at);
        track.last = at;
        track.streak = undefined;
        return;
      }
      case "session.ended": {
        const data = OfSession.safeParse(row.data);
        if (data.success) this.end(sessionSubjectOf(data.data.session));
        return;
      }
      case "history.session.ended": {
        const data = HistoryEnded.safeParse(row.data);
        if (!data.success) return;
        const subject = sessionSubjectOf(data.data.session);
        // A quiet transcript only suggests that a session niwa runs is over: it says so itself.
        if (this.tracks.get(subject)?.managed === true && data.data.certainty !== "exact") return;
        this.end(subject);
        return;
      }
      case "history.session.unwatched": {
        const data = OfSession.safeParse(row.data);
        if (!data.success) return;
        const subject = sessionSubjectOf(data.data.session);
        // The history was the only source of a session niwa does not run: with it gone there is nothing to measure.
        // A session niwa runs goes on being read from its own records.
        if (this.tracks.get(subject)?.managed === false) this.end(subject);
        return;
      }
      case "history.session.seen": {
        const data = OfSession.safeParse(row.data);
        if (!data.success) return;
        const subject = sessionSubjectOf(data.data.session);
        if (this.tracks.has(subject)) return;
        this.revive(subject, "session", at).base = "unknown";
        return;
      }
      case "history.session.paused": {
        const data = OfSession.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(sessionSubjectOf(data.data.session));
        // A quiet transcript says nothing of a turn niwa runs: the turn is open until it ends.
        if (track === undefined || track.managed) return;
        this.become(track, "idle", at);
        track.streak = undefined;
        return;
      }
      case "git.head.moved": {
        const data = HeadMoved.safeParse(row.data);
        // A moved head is progress for whoever it can be attributed to: the session it names, or
        // the run whose handler wrote it.
        const track =
          data.success && data.data.session !== undefined
            ? this.known(sessionSubjectOf(data.data.session))
            : this.ofActor(row);
        if (track === undefined) return;
        track.last = at;
        track.streak = undefined;
        return;
      }
      case "workflow.run.requested": {
        const data = OfRun.safeParse(row.data);
        if (!data.success) return;
        const track = this.revive(runSubject(data.data.run), "run", at);
        // An attempt at the script begins: nothing of the one before holds.
        this.release(track);
        track.base = "idle";
        track.started = false;
        track.pause = undefined;
        track.manual = undefined;
        track.streak = undefined;
        track.shields.clear();
        return;
      }
      case "workflow.run.started": {
        const data = OfRun.safeParse(row.data);
        if (!data.success) return;
        const track = this.revive(runSubject(data.data.run), "run", at);
        track.started = true;
        this.become(track, "working", at);
        if (row.actor.kind === "handler" && track.invocation !== (row.actor.invocation as string)) {
          this.release(track);
          track.invocation = row.actor.invocation as string;
          this.byInvocation.set(track.invocation, track.subject);
        }
        return;
      }
      case "workflow.run.finished": {
        const data = OfRun.safeParse(row.data);
        if (data.success) this.end(runSubject(data.data.run));
        return;
      }
      case "workflow.run.paused": {
        const data = Paused.safeParse(row.data);
        const track = data.success ? this.attemptOf(row, data.data.run) : undefined;
        if (track === undefined || !data.success) return;
        track.pause = { cancelOnly: data.data.choices?.join() === "cancel" };
        track.last = at;
        return;
      }
      case "workflow.run.pause-requested": {
        const data = PauseRequested.safeParse(row.data);
        const track = data.success ? this.tracks.get(runSubject(data.data.run)) : undefined;
        if (track === undefined || !data.success) return;
        track.manual = { id: String(row.id), deadline: data.data.kind === "deadline" };
        track.last = at;
        return;
      }
      case "workflow.run.continued": {
        const data = Continued.safeParse(row.data);
        const track = data.success ? this.tracks.get(runSubject(data.data.run)) : undefined;
        if (track === undefined || !data.success) return;
        // It frees the pause it names: a hold shares the record, and a later pause is not the one that was released.
        if (track.manual?.id === data.data.pause) track.manual = undefined;
        track.last = at;
        return;
      }
      case "workflow.run.log": {
        const data = OfRun.safeParse(row.data);
        const track = data.success ? this.attemptOf(row, data.data.run) : undefined;
        if (track !== undefined) track.last = at;
        return;
      }
      case "workflow.phase.entered":
      case "workflow.phase.left": {
        const data = OfRun.safeParse(row.data);
        const track = data.success ? this.attemptOf(row, data.data.run) : undefined;
        if (track === undefined) return;
        // A script that moves to another phase is getting somewhere: what it repeated before is not a loop.
        track.last = at;
        track.streak = undefined;
        return;
      }
      case "workflow.scope.opened": {
        const data = Scope.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(runSubject(data.data.run));
        if (track === undefined) return;
        if (data.data.shield === true && !track.shields.has(data.data.scope)) track.shields.set(data.data.scope, undefined);
        track.last = at;
        return;
      }
      case "workflow.scope.closed": {
        const data = Scope.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(runSubject(data.data.run));
        if (track === undefined) return;
        track.shields.delete(data.data.scope);
        track.last = at;
        return;
      }
      case "niwa.step.intent": {
        const data = Intent.safeParse(row.data);
        if (!data.success) return;
        const track = this.ofInvocation(data.data.invocation);
        if (track === undefined) return;
        track.last = at;
        track.steps.set(data.data.key, data.data.action);
        // The steps the bridge adds around a call (its permission, the clock, the arming of a wake) and the
        // sleep itself are signs of life: they are not the script repeating a call.
        if (!ASIDE.test(data.data.key) && data.data.action !== WAIT_ACTION) this.repeat(track, stableJson([data.data.action, data.data.input]), at);
        return;
      }
      case "niwa.step.outcome": {
        const data = Outcome.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined || !data.success) return;
        track.steps.delete(data.data.key);
        track.last = at;
        return;
      }
      case "niwa.step.cancelled": {
        const data = Cancelled.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined || !data.success) return;
        // The steps it holds are over, whether or not an outcome is ever written for them.
        const { prefixes = [], except = [] } = data.data;
        for (const key of [...track.steps.keys()]) {
          if (prefixes.some((prefix) => keyUnder(key, prefix)) && !except.some((spared) => keyUnder(key, spared))) track.steps.delete(key);
        }
        // A cancel names the open shields it spares in `except`: those are the scopes that go on past it.
        for (const scope of data.data.except ?? []) {
          if (track.shields.has(scope) && track.shields.get(scope) === undefined) track.shields.set(scope, at);
        }
        track.last = at;
        return;
      }
      case "niwa.invocation.state": {
        const data = InvocationState.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined || !data.success) return;
        track.invocationState = data.data.state;
        track.last = at;
        if (data.data.state === "running") track.pause = undefined;
        // An invocation that is done is the end of the run, unless the run waits for its script to be revised.
        if (data.data.state === "done" && track.pause?.cancelOnly !== true) this.end(track.subject);
        return;
      }
      case "niwa.invocation.resolved": {
        const data = OfInvocation.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined) return;
        // A retry, a skip or a cancel answers the pause of the invocation.
        track.pause = undefined;
        track.last = at;
        return;
      }
      case "request.created": {
        const data = RequestMade.safeParse(row.data);
        if (!data.success) return;
        const from = data.data.from;
        const subject =
          from?.kind === "session" && from.harness !== undefined && from.id !== undefined
            ? sessionSubject(from.harness, from.id)
            : this.ofActor(row)?.subject;
        const track = subject === undefined ? undefined : this.tracks.get(subject);
        if (subject === undefined) return;
        this.requests.set(data.data.id, subject);
        // Only a question to the owner waits for a person; one to a session or another address waits for what answers it.
        track?.asked.set(data.data.id, data.data.to.kind === "owner");
        return;
      }
      case "request.answered":
      case "request.cancelled":
      case "request.expired": {
        const data = OfRequest.safeParse(row.data);
        if (!data.success) return;
        const subject = this.requests.get(data.data.id);
        this.requests.delete(data.data.id);
        const track = subject === undefined ? undefined : this.tracks.get(subject);
        if (track === undefined) return;
        track.asked.delete(data.data.id);
        track.last = at;
        return;
      }
      case "timer.sleep.requested": {
        const data = OfKey.safeParse(row.data);
        if (!data.success) return;
        // The key of a sleep is the invocation and the sleeping place: `<invocation>:<place>`.
        const invocation = row.actor.kind === "handler" ? (row.actor.invocation as string) : data.data.key.split(":")[0];
        const track = invocation === undefined ? undefined : this.ofInvocation(invocation);
        if (track === undefined) return;
        this.sleeps.set(data.data.key, track.subject);
        track.timers.add(data.data.key);
        return;
      }
      case "timer.slept": {
        const data = OfKey.safeParse(row.data);
        if (!data.success) return;
        const subject = this.sleeps.get(data.data.key);
        this.sleeps.delete(data.data.key);
        const track = subject === undefined ? undefined : this.tracks.get(subject);
        if (track === undefined) return;
        track.timers.delete(data.data.key);
        track.last = at;
        return;
      }
      case "watch.stuck": {
        const data = Stuck.safeParse(row.data);
        if (data.success && isKind(data.data.kind)) {
          this.open.set(data.data.subject, { since: data.data.since, last: data.data.last, kind: data.data.kind });
        }
        return;
      }
      case "watch.recovered": {
        const data = Flag.safeParse(row.data);
        if (!data.success) return;
        const flag = this.open.get(data.data.subject);
        // It closes the flag it names, not a newer one for the same subject.
        if (flag !== undefined && flag.since === data.data.since && flag.kind === data.data.kind) {
          this.open.delete(data.data.subject);
        }
        return;
      }
      default:
        return;
    }
  }

  /** What every followed subject is doing at `now`, by subject. */
  readings(now: number, settings: Settings = DEFAULT_SETTINGS): Reading[] {
    const readings: Reading[] = [];
    for (const track of this.tracks.values()) readings.push(this.reading(track, now, settings));
    return readings.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
  }

  /** What one subject is doing at `now`; undefined for a subject the model does not follow. */
  readingOf(subject: Subject, now: number, settings: Settings = DEFAULT_SETTINGS): Reading | undefined {
    const track = this.tracks.get(subject);
    return track === undefined ? undefined : this.reading(track, now, settings);
  }

  private reading(track: Track, now: number, settings: Settings): Reading {
    const shape = (state: Reading["state"], since: number, kind?: StuckKind): Reading => ({
      subject: track.subject,
      state,
      since,
      last: track.last,
      ...(kind === undefined ? {} : { kind }),
    });

    // A run whose cancel spared a shielded scope that is still open past the grace is not stopping.
    const spared = [...track.shields.values()].filter((at): at is number => at !== undefined && now - at >= settings.shieldGrace);
    if (spared.length > 0) return shape("stuck", Math.min(...spared), "shielded-cancel");

    const held = this.heldState(track);
    if (held !== undefined) return shape(held, track.since);
    if (track.base !== "working") return shape(track.base, track.since);

    const repeats = track.kind === "run" ? settings.loopRepeats : settings.sessionLoopRepeats;
    if (track.streak !== undefined && track.streak.count >= repeats) return shape("looping", track.streak.from, "looping");

    const quiet = settings.silentAfter;
    const allowed = track.stuckAfter ?? quiet;
    // A silence the watch flagged lasts until a sign of life: it is not counted again from a later floor.
    const flagged = this.open.get(track.subject);
    if (flagged?.kind === "silent" && flagged.last === track.last) return shape("stuck", flagged.since, "silent");
    // Time the watch was not looking does not count as quiet.
    const lastSign = Math.max(track.last, this.floor);
    if (now - lastSign >= allowed) return shape("stuck", lastSign + allowed, "silent");
    return shape("working", track.since);
  }

  /** What holds a subject that would otherwise be working: a question to a person, a paused run, a sleep, a wait. */
  private heldState(track: Track): Reading["state"] | undefined {
    const asked = track.asked.size > 0;
    const person = [...track.asked.values()].includes(true);
    if (track.kind === "session") {
      if (!asked || track.base === "unknown") return undefined;
      return person ? "waiting-human" : "waiting-event";
    }
    if (!track.started) return track.base === "idle" ? "idle" : undefined;
    // A deadline that was reached pauses the run from that moment; a pause someone asked for, when the run reaches a boundary.
    if (track.manual?.deadline === true) return "waiting-human";
    if (track.pause !== undefined || track.invocationState === "paused") return "waiting-human";
    if (track.manual !== undefined && track.invocationState === "waiting") return "waiting-human";
    if (track.invocationState !== "waiting") return undefined;
    if (person) return "waiting-human";
    return this.sleeping(track) ? "sleeping" : "waiting-event";
  }

  /**
   * Whether the run waits for a moment: a sleep of its own is open with its wake not yet come, and no wait for a record
   * is. A wait with a timeout arms the same wake as a sleep, but a record can end it, and a wake left over from a wait
   * that a record ended is not what a later wait waits for.
   */
  private sleeping(track: Track): boolean {
    let asleep = false;
    for (const [key, action] of track.steps) {
      if (action === SCRIPT_WAIT_ACTION) return false;
      if (action === WAIT_ACTION && track.invocation !== undefined && track.timers.has(`${track.invocation}:${key}`)) asleep = true;
    }
    return asleep;
  }

  private create(subject: Subject, kind: Track["kind"], at: number): Track | undefined {
    if (this.gone.has(subject)) return undefined;
    const track: Track = { subject, kind, base: "idle", managed: false, since: at, last: at, started: kind === "session", asked: new Map(), steps: new Map(), timers: new Set(), shields: new Map() };
    this.tracks.set(subject, track);
    return track;
  }

  /** The track of a subject that begins or begins again: a start or a new turn is a reason to follow it. */
  private revive(subject: Subject, kind: Track["kind"], at: number): Track {
    this.gone.delete(subject);
    const track = this.tracks.get(subject) ?? this.create(subject, kind, at);
    if (track === undefined) throw new Error(`the subject ${subject} could not be followed`);
    track.last = Math.max(track.last, at);
    return track;
  }

  private known(subject: Subject): Track | undefined {
    return this.tracks.get(subject);
  }

  /** The track of the run a record is about, unless an invocation other than the run's current one wrote it. */
  private attemptOf(row: StoredRecord, run: string): Track | undefined {
    const track = this.tracks.get(runSubject(run));
    if (track === undefined) return undefined;
    if (row.actor.kind === "handler" && track.invocation !== undefined && (row.actor.invocation as string) !== track.invocation) return undefined;
    return track;
  }

  private ofInvocation(invocation: string): Track | undefined {
    const subject = this.byInvocation.get(invocation);
    const track = subject === undefined ? undefined : this.tracks.get(subject);
    return track?.invocation === invocation ? track : undefined;
  }

  /** The invocation a run was in is over for it: what it said is not read for the run any more. */
  private release(track: Track): void {
    if (track.invocation !== undefined) this.byInvocation.delete(track.invocation);
    track.invocation = undefined;
    track.invocationState = undefined;
    track.steps.clear();
    track.timers.clear();
    for (const [key, owner] of this.sleeps) if (owner === track.subject) this.sleeps.delete(key);
  }

  /** The run whose handler wrote a record, when one did. */
  private ofActor(row: StoredRecord): Track | undefined {
    return row.actor.kind === "handler" ? this.ofInvocation(row.actor.invocation as string) : undefined;
  }

  private become(track: Track, base: Base, at: number): void {
    if (track.base !== base) track.since = at;
    track.base = base;
    track.last = at;
  }

  private repeat(track: Track, signature: string, at: number): void {
    const streak = track.streak;
    track.streak =
      streak !== undefined && streak.signature === signature
        ? { signature, count: streak.count + 1, from: streak.from }
        : { signature, count: 1, from: at };
  }

  private end(subject: Subject): void {
    const track = this.tracks.get(subject);
    this.tracks.delete(subject);
    this.gone.add(subject);
    if (track?.invocation !== undefined) this.byInvocation.delete(track.invocation);
    for (const [key, owner] of this.requests) if (owner === subject) this.requests.delete(key);
    for (const [key, owner] of this.sleeps) if (owner === subject) this.sleeps.delete(key);
  }
}

/**
 * The records to write so that the flags in the journal say what the readings say: close a flag whose
 * condition is over or changed, open one for a subject that is stuck or looping and has none.
 */
export function transitions(flags: ReadonlyMap<Subject, OpenFlag>, readings: readonly Reading[]): Transition[] {
  const wanted = new Map<Subject, Reading & { kind: StuckKind }>();
  for (const reading of readings) if (reading.kind !== undefined) wanted.set(reading.subject, { ...reading, kind: reading.kind });

  const closing: Transition[] = [];
  for (const [subject, flag] of flags) {
    const now = wanted.get(subject);
    if (now === undefined || now.kind !== flag.kind || now.since !== flag.since) {
      closing.push({ type: "recovered", data: { subject, since: flag.since, kind: flag.kind } });
    }
  }

  const opening: Transition[] = [];
  for (const [subject, reading] of wanted) {
    const flag = flags.get(subject);
    if (flag === undefined || flag.kind !== reading.kind || flag.since !== reading.since) {
      opening.push({ type: "stuck", data: { subject, since: reading.since, last: reading.last, kind: reading.kind } });
    }
  }
  return [...closing, ...opening];
}
