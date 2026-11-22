// The watch page: the order of the subjects, what a subject is called, and the incidents the flags make.

import { expect, test } from "bun:test";

import { decisionText } from "../src/cockpit/decisions.ts";
import { matchRecord } from "@niwa-labs/cockpit-sdk";

import type { Reading, WatchState } from "../src/cockpit/actions.ts";
import { REFRESH_ON, agoText, countByState, incidents, ordered, subjectName, subjectText } from "../src/cockpit/subjects.ts";

function reading(subject: string, state: WatchState, since = 0): Reading {
  return { subject, state, since, last: since };
}

test("troubles come first, then subjects that wait for a person, and the longest in a state first", () => {
  const list = ordered([
    reading("run:idle", "idle"),
    reading("run:late", "working", 500),
    reading("run:early", "working", 100),
    reading("session:claude a", "waiting-human"),
    reading("run:loop", "looping"),
    reading("run:stuck", "stuck"),
  ]);
  expect(list.map((one) => one.subject)).toEqual(["run:stuck", "run:loop", "session:claude a", "run:early", "run:late", "run:idle"]);
});

test("states are counted in the order of the page and the empty ones are left out", () => {
  expect(countByState([reading("run:a", "idle"), reading("run:b", "stuck"), reading("run:c", "idle")])).toEqual([
    { state: "stuck", count: 1 },
    { state: "idle", count: 2 },
  ]);
  expect(countByState([])).toEqual([]);
});

test("a subject is a run or a session with its harness", () => {
  expect(subjectName("run:run-7")).toEqual({ kind: "run", id: "run-7" });
  expect(subjectName("session:claude 4f9 a")).toEqual({ kind: "session", harness: "claude", id: "4f9 a" });
  expect(subjectText("run:run-7")).toBe("run run-7");
  expect(subjectText("session:codex abc")).toBe("session codex/abc");
});

test("a moment is told as how long ago it was", () => {
  const now = 10_000_000;
  expect(agoText(now + 5_000, now)).toBe("только что");
  expect(agoText(now - 30_000, now)).toBe("30 с назад");
  expect(agoText(now - 10 * 60_000, now)).toBe("10 мин назад");
  expect(agoText(now - 3 * 3_600_000, now)).toBe("3 ч назад");
  expect(agoText(now - 5 * 86_400_000, now)).toBe("5 дн назад");
});

const stuck = (subject: string, kind: string, since: number, last = since - 1) => ({ type: "watch.stuck", at: since + 1, data: { subject, kind, since, last } });
const recovered = (subject: string, kind: string, since: number, at: number) => ({ type: "watch.recovered", at, data: { subject, kind, since } });

test("a recovery closes the flag it names by subject, kind and since", () => {
  const found = incidents([stuck("run:a", "silent", 100), stuck("run:a", "looping", 150), recovered("run:a", "silent", 100, 400)]);
  expect(found.map((one) => [one.kind, one.recoveredAt])).toEqual([
    ["looping", undefined],
    ["silent", 400],
  ]);
});

test("a subject flagged again after it recovered is a second incident", () => {
  const found = incidents([stuck("run:a", "silent", 100), recovered("run:a", "silent", 100, 200), stuck("run:a", "silent", 300)]);
  expect(found.map((one) => [one.since, one.recoveredAt])).toEqual([
    [300, undefined],
    [100, 200],
  ]);
});

test("a recovery whose flag is not held is no incident, and a record that is no flag is ignored", () => {
  expect(incidents([recovered("run:a", "silent", 100, 400), { type: "watch.stuck", at: 1, data: { subject: "run:a" } }, { type: "watch.stuck", at: 1, data: null }])).toEqual([]);
});

test("the list is read again after a record that moves a session or a run between states, and not after its activity", () => {
  const at = (type: string) => ({ id: "r", seq: 1, type, stream: "s", at: 0, data: {} }) as unknown as Parameters<typeof matchRecord>[1];
  for (const type of ["watch.stuck", "watch.recovered", "session.started", "session.turn-started", "session.turn-ended", "session.ended", "workflow.run.finished", "request.created", "request.answered", "timer.slept"]) {
    expect([type, matchRecord(REFRESH_ON, at(type))]).toEqual([type, true]);
  }
  expect(matchRecord(REFRESH_ON, at("session.activity"))).toBe(false);
});

test("a merge claim and a refused write identify the affected entity in the watch", () => {
  expect(decisionText({ type: "forge.pr.merge.started", data: {
    operation: "op1", pr: { repo: { host: "git.example", path: "work/project" }, number: 2 },
  } })).toBe("Запрошено слияние · git.example/work/project!2");
  expect(decisionText({ type: "niwa.record.refused", actor: { kind: "client", id: "planner" }, data: {
    recordType: "plan.revised", entity: "work", reason: "revision changed",
  } })).toBe("planner · plan.revised · work · revision changed");
});
