/** What the watch page makes of the subjects and of the records that flag them. */

import type { WorkState } from "@niwa-labs/ui-kit";

import type { Reading, StuckKind, WatchState } from "./actions.ts";

/** The ring a state is drawn with: a stuck or looping subject is a failure the owner should see. */
export const RING: Readonly<Record<WatchState, WorkState>> = {
  working: "running",
  "waiting-human": "waiting",
  "waiting-event": "waiting",
  sleeping: "waiting",
  idle: "pending",
  looping: "failed",
  stuck: "failed",
  unknown: "pending",
};

/** What a state is called on the page. */
export const STATE_LABEL: Readonly<Record<WatchState, string>> = {
  working: "Working",
  "waiting-human": "Waiting for a person",
  "waiting-event": "Waiting for an event",
  sleeping: "Sleeping",
  idle: "Idle",
  looping: "Looping",
  stuck: "Stuck",
  unknown: "Unknown",
};

/** What a stuck kind says about the subject. */
export const KIND_LABEL: Readonly<Record<StuckKind, string>> = {
  silent: "no sign of life",
  looping: "repeating itself",
  "shielded-cancel": "cancelled, a shielded scope goes on",
};

/** The order states are listed in: what needs the owner first. */
const ORDER: readonly WatchState[] = ["stuck", "looping", "waiting-human", "unknown", "working", "waiting-event", "sleeping", "idle"];

/** Whether a state is a problem the watch flagged. */
export function troubled(state: WatchState): boolean {
  return state === "stuck" || state === "looping";
}

/** The subjects in the order of the page: troubles first, then by how long they have been in their state, longest first. */
export function ordered(readings: readonly Reading[]): Reading[] {
  return [...readings].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.since - b.since || a.subject.localeCompare(b.subject));
}

/** How many subjects are in each state, the states with none left out. */
export function countByState(readings: readonly Reading[]): Array<{ state: WatchState; count: number }> {
  return ORDER.flatMap((state) => {
    const count = readings.filter((one) => one.state === state).length;
    return count === 0 ? [] : [{ state, count }];
  });
}

/** A subject taken apart: a run is `run:<id>`, a session `session:<harness> <native id>`. */
export type SubjectName = { kind: "run"; id: string } | { kind: "session"; harness: string; id: string };

export function subjectName(subject: string): SubjectName {
  const colon = subject.indexOf(":");
  const rest = subject.slice(colon + 1);
  if (subject.slice(0, colon) === "run") return { kind: "run", id: rest };
  const space = rest.indexOf(" ");
  return space < 0 ? { kind: "session", harness: "", id: rest } : { kind: "session", harness: rest.slice(0, space), id: rest.slice(space + 1) };
}

/** A subject in the words of the page. */
export function subjectText(subject: string): string {
  const name = subjectName(subject);
  return name.kind === "run" ? `run ${name.id}` : `session ${name.harness === "" ? "" : `${name.harness}/`}${name.id}`;
}

/** A moment in milliseconds since the epoch, as how long ago it was; a moment ahead of `now` is "just now". */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${String(seconds)} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} d ago`;
}

/** A record as the feed gives it: the part the incidents read. */
export type FlagRecord = { readonly type: string; readonly data: unknown; readonly at: number };

/** A time a subject was flagged, and whether it has recovered. */
export type Incident = {
  subject: string;
  kind: StuckKind;
  /** When the condition began. */
  since: number;
  /** The last sign of life, known from the flag. */
  last: number;
  /** When the watch wrote the recovery; undefined while the subject is still flagged. */
  recoveredAt: number | undefined;
};

function fieldsOf(data: unknown): { subject: string; kind: StuckKind; since: number; last: number | undefined } | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const found = data as Record<string, unknown>;
  const { subject, kind, since } = found;
  if (typeof subject !== "string" || typeof since !== "number") return undefined;
  if (kind !== "silent" && kind !== "looping" && kind !== "shielded-cancel") return undefined;
  return { subject, kind, since, last: typeof found["last"] === "number" ? found["last"] : undefined };
}

/**
 * The incidents the records tell of, the latest flag first. A `watch.recovered` closes the flag with its subject,
 * kind and `since`; a recovery whose flag the feed no longer holds is not an incident of its own.
 */
export function incidents(records: readonly FlagRecord[]): Incident[] {
  const found = new Map<string, Incident>();
  const keyOf = (one: { subject: string; kind: StuckKind; since: number }): string => `${one.subject}\0${one.kind}\0${String(one.since)}`;
  for (const record of records) {
    const fields = fieldsOf(record.data);
    if (fields === undefined) continue;
    if (record.type === "watch.stuck") {
      found.set(keyOf(fields), { subject: fields.subject, kind: fields.kind, since: fields.since, last: fields.last ?? fields.since, recoveredAt: undefined });
    } else if (record.type === "watch.recovered") {
      const open = found.get(keyOf(fields));
      if (open !== undefined) open.recoveredAt = record.at;
    }
  }
  return [...found.values()].sort((a, b) => b.since - a.since);
}
