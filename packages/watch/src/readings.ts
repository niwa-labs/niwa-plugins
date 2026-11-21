/**
 * What the watch knows, folded from the journal records it reads.
 *
 * The model is fed record by record (`Model.apply`) and asked, at a moment, what every subject is
 * doing (`Model.readings`). It reads records by type name and parses only the fields it needs, so a
 * record it cannot read is passed over and a plugin it does not know of is not required. Time is
 * given, never read: the same records and the same moment always give the same readings.
 *
 * The sources are: the turns, activity and progress of sessions, the pauses, scopes and steps of
 * runs, the requests and sleeps that hold either, a head that moved, and the watch's own flags.
 */

import { z } from "zod";

import { stableJson } from "@niwa-labs/core";
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
const Activity = z.object({ session: SessionNamed, tool: z.string().optional(), permission: z.unknown().optional() });
const OfRun = z.object({ run: Text });
const Scope = z.object({ run: Text, scope: Text, shield: z.boolean().optional() });
const OfInvocation = z.object({ invocation: Text });
const Intent = z.object({ invocation: Text, action: z.string(), input: z.unknown() });
const InvocationState = z.object({ invocation: Text, state: z.string() });
const RequestMade = z.object({
  id: Text,
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
  since: number;
  last: number;
  stuckAfter?: number;
  streak?: Streak;
  // A run only.
  invocation?: string;
  started: boolean;
  invocationState?: string;
  paused: boolean;
  cancelledAt?: number;
  shields: Set<string>;
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
        this.repeat(track, stableJson([data.data.tool ?? null, data.data.permission ?? null]), at);
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
      case "session.ended":
      case "history.session.ended": {
        const data = OfSession.safeParse(row.data);
        if (data.success) this.end(sessionSubjectOf(data.data.session));
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
        if (track === undefined) return;
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
        track.base = "idle";
        track.started = false;
        return;
      }
      case "workflow.run.started": {
        const data = OfRun.safeParse(row.data);
        if (!data.success) return;
        const track = this.revive(runSubject(data.data.run), "run", at);
        track.started = true;
        this.become(track, "working", at);
        if (row.actor.kind === "handler") {
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
        const track = this.runOf(row.data);
        if (track === undefined) return;
        track.paused = true;
        track.last = at;
        return;
      }
      case "workflow.run.continued": {
        const track = this.runOf(row.data);
        if (track === undefined) return;
        track.paused = false;
        track.last = at;
        return;
      }
      case "workflow.scope.opened": {
        const data = Scope.safeParse(row.data);
        if (!data.success) return;
        const track = this.known(runSubject(data.data.run));
        if (track === undefined) return;
        if (data.data.shield === true) track.shields.add(data.data.scope);
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
        this.repeat(track, stableJson([data.data.action, data.data.input]), at);
        return;
      }
      case "niwa.step.outcome": {
        const data = OfInvocation.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track !== undefined) track.last = at;
        return;
      }
      case "niwa.step.cancelled": {
        const data = OfInvocation.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined) return;
        track.cancelledAt ??= at;
        track.last = at;
        return;
      }
      case "niwa.invocation.state": {
        const data = InvocationState.safeParse(row.data);
        const track = data.success ? this.ofInvocation(data.data.invocation) : undefined;
        if (track === undefined || !data.success) return;
        track.invocationState = data.data.state;
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
        if (subject !== undefined) this.requests.set(data.data.id, subject);
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
        if (track !== undefined) track.last = at;
        return;
      }
      case "timer.sleep.requested": {
        const data = OfKey.safeParse(row.data);
        if (!data.success) return;
        // The key of a sleep is the invocation and the sleeping place: `<invocation>:<place>`.
        const invocation = row.actor.kind === "handler" ? (row.actor.invocation as string) : data.data.key.split(":")[0];
        const track = invocation === undefined ? undefined : this.ofInvocation(invocation);
        if (track !== undefined) this.sleeps.set(data.data.key, track.subject);
        return;
      }
      case "timer.slept": {
        const data = OfKey.safeParse(row.data);
        if (!data.success) return;
        const subject = this.sleeps.get(data.data.key);
        this.sleeps.delete(data.data.key);
        const track = subject === undefined ? undefined : this.tracks.get(subject);
        if (track !== undefined) track.last = at;
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

    // A run that was cancelled and still holds a shielded scope open past the grace is not stopping.
    if (track.cancelledAt !== undefined && track.shields.size > 0 && now - track.cancelledAt >= settings.shieldGrace) {
      return shape("stuck", track.cancelledAt, "shielded-cancel");
    }

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
    const asked = [...this.requests.values()].includes(track.subject);
    if (track.kind === "session") return asked && track.base !== "unknown" ? "waiting-human" : undefined;
    if (!track.started) return track.base === "idle" ? "idle" : undefined;
    if (track.paused || track.invocationState === "paused") return "waiting-human";
    if (track.invocationState !== "waiting") return undefined;
    if (asked) return "waiting-human";
    if ([...this.sleeps.values()].includes(track.subject)) return "sleeping";
    return "waiting-event";
  }

  private create(subject: Subject, kind: Track["kind"], at: number): Track | undefined {
    if (this.gone.has(subject)) return undefined;
    const track: Track = { subject, kind, base: "idle", since: at, last: at, started: kind === "session", paused: false, shields: new Set() };
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

  private runOf(data: unknown): Track | undefined {
    const parsed = OfRun.safeParse(data);
    return parsed.success ? this.tracks.get(runSubject(parsed.data.run)) : undefined;
  }

  private ofInvocation(invocation: string): Track | undefined {
    const subject = this.byInvocation.get(invocation);
    return subject === undefined ? undefined : this.tracks.get(subject);
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
