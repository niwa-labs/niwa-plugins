/** What the watch page makes of the subjects and of the records that flag them. */

import type { WorkState } from "@niwa-labs/ui-kit";

import type { Reading, StuckKind, WatchState } from "./actions.ts";

/**
 * The records after which the list of subjects is read again: those that move a subject between states. A session's
 * activity is left out, as it moves nothing and arrives many times a second.
 */
export const REFRESH_ON = {
  types: ["watch.*", "session.started", "session.turn-started", "session.turn-ended", "session.ended", "workflow.run.*", "request.*", "timer.*"],
} as const;

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
  working: "В работе",
  "waiting-human": "Ждёт ответа",
  "waiting-event": "Ждёт события",
  sleeping: "Пауза по таймеру",
  idle: "Простаивает",
  looping: "Зациклилось",
  stuck: "Застряло",
  unknown: "Нет данных",
};

/** What a stuck kind says about the subject. */
export const KIND_LABEL: Readonly<Record<StuckKind, string>> = {
  silent: "Нет активности",
  looping: "Повторяет один и тот же шаг",
  "shielded-cancel": "После отмены продолжает защищённую работу",
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

/** Relative time, with future timestamps shown as just now. */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "только что";
  if (seconds < 90) return `${String(seconds)} с назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${String(hours)} ч назад`;
  return `${String(Math.round(hours / 24))} дн назад`;
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
