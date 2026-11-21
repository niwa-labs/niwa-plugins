import { describe, expect, test } from "bun:test";

import { recordId, recordTypeName, resolveQuery, selectsType, seq, streamId, timestamp } from "@niwa-labs/core";
import type { Caller, StoredRecord } from "@niwa-labs/core";

import { DEFAULT_SETTINGS, Model, SOURCES, transitions } from "../src/readings.ts";
import type { OpenFlag, Settings, Transition } from "../src/readings.ts";
import { runSubject, sessionSubject } from "../src/records.ts";
import type { Reading } from "../src/records.ts";

const MINUTE = 60_000;
const HOST: Caller = { kind: "host" };

let counter = 0;
function row(type: string, data: unknown, at: number, actor: Caller = HOST): StoredRecord {
  counter += 1;
  const id = recordId(`r${counter}`);
  return {
    id,
    seq: seq(counter),
    stream: streamId("test"),
    type: recordTypeName(type),
    schema: 1,
    data,
    actor,
    cause: null,
    root: id,
    at: timestamp(at),
  };
}

function handler(invocation: string): Caller {
  return { kind: "handler", handler: "workflow/run" as never, invocation: invocation as never };
}

function modelOf(rows: StoredRecord[], floor = 0): Model {
  const model = new Model(floor);
  for (const one of rows) model.apply(one);
  return model;
}

function read(model: Model, subject: ReturnType<typeof sessionSubject>, now: number, settings: Settings = DEFAULT_SETTINGS): Reading | undefined {
  return model.readingOf(subject, now, settings);
}

const ME = "claude abc";
const me = sessionSubject("claude", "abc");

describe("sessions", () => {
  const turn = (at: number) => [row("session.started", { session: ME, id: "s-1" }, 0), row("session.turn-started", { session: ME, turn: 1 }, at)];

  test("a session in a turn is working until it has been quiet for too long, then stuck since that moment", () => {
    const model = modelOf(turn(0));
    expect(read(model, me, 9 * MINUTE)).toMatchObject({ state: "working", since: 0, last: 0 });
    expect(read(model, me, 10 * MINUTE)).toEqual({ subject: me, state: "stuck", kind: "silent", since: 10 * MINUTE, last: 0 });
  });

  test("a sign of life moves the end of the quiet", () => {
    const model = modelOf([...turn(0), row("session.activity", { session: ME, tool: "Bash" }, 6 * MINUTE)]);
    expect(read(model, me, 15 * MINUTE)).toMatchObject({ state: "working", last: 6 * MINUTE });
    expect(read(model, me, 16 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent", since: 16 * MINUTE });
  });

  test("a session that says how long a turn may go quiet is held to that, not to the default", () => {
    const model = modelOf([row("session.started", { session: ME, id: "s-1", stuckAfter: 2 * MINUTE }, 0), row("session.turn-started", { session: ME, turn: 1 }, 0)]);
    expect(read(model, me, 2 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent", since: 2 * MINUTE });
  });

  test("a session between turns is idle for as long as it likes", () => {
    const model = modelOf([...turn(0), row("session.turn-ended", { session: ME, turn: 1, how: "completed" }, MINUTE)]);
    expect(read(model, me, 5 * 60 * MINUTE)).toMatchObject({ state: "idle", since: MINUTE });
  });

  test("a turn that ended nobody knows how leaves the session unknown", () => {
    const model = modelOf([...turn(0), row("session.turn-ended", { session: ME, turn: 1, how: "unknown" }, MINUTE)]);
    expect(read(model, me, 2 * MINUTE)).toMatchObject({ state: "unknown", since: MINUTE });
    // The next turn makes it working again.
    model.apply(row("session.turn-started", { session: ME, turn: 2 }, 3 * MINUTE));
    expect(read(model, me, 4 * MINUTE)).toMatchObject({ state: "working", since: 3 * MINUTE });
  });

  test("the same activity over and over with no progress is looping, since the first of them", () => {
    const rows = [...turn(0)];
    for (let n = 1; n <= 25; n += 1) rows.push(row("session.activity", { session: ME, tool: "Edit" }, n * 1000));
    const model = modelOf(rows);
    expect(read(model, me, 26_000)).toEqual({ subject: me, state: "looping", kind: "looping", since: 1000, last: 25_000 });
    // Progress breaks the loop.
    model.apply(row("session.progress", { session: { harness: "claude", native: "abc" }, done: 1, total: 3 }, 27_000));
    expect(read(model, me, 28_000)?.state).toBe("working");
  });

  test("a different tool in between, or one fewer repeat, is not a loop", () => {
    const rows = [...turn(0)];
    for (let n = 1; n <= 24; n += 1) rows.push(row("session.activity", { session: ME, tool: "Edit" }, n * 1000));
    expect(read(modelOf(rows), me, 25_000)?.state).toBe("working");
    rows.push(row("session.activity", { session: ME, tool: "Read" }, 25_000), row("session.activity", { session: ME, tool: "Edit" }, 26_000));
    expect(read(modelOf(rows), me, 27_000)?.state).toBe("working");
  });

  test("activity that names no tool is a sign of life and not a repeated operation", () => {
    const rows = [...turn(0)];
    for (let n = 1; n <= 40; n += 1) rows.push(row("session.activity", { session: ME }, n * 1000));
    expect(read(modelOf(rows), me, 41_000)).toMatchObject({ state: "working", last: 40_000 });
    // Between calls of one tool it neither adds to the repeats nor breaks them.
    const calls = [...turn(0)];
    for (let n = 1; n <= 25; n += 1) calls.push(row("session.activity", { session: ME, tool: "Edit" }, n * 2000), row("session.activity", { session: ME }, n * 2000 + 1000));
    expect(read(modelOf(calls), me, 60_000)).toMatchObject({ state: "looping", since: 2000 });
  });

  test("a head that moved for the session counts as progress and breaks a loop", () => {
    const rows = [...turn(0)];
    for (let n = 1; n <= 25; n += 1) rows.push(row("session.activity", { session: ME, tool: "Edit" }, n * 1000));
    rows.push(row("git.head.moved", { session: ME, head: "abc123" }, 26_000));
    expect(read(modelOf(rows), me, 27_000)).toMatchObject({ state: "working", last: 26_000 });
  });

  test("an open question from the session means waiting for a person, not silence", () => {
    const asker = { kind: "session", harness: "claude", id: "abc" };
    const model = modelOf([...turn(0), row("request.created", { id: "req-1", to: { kind: "owner" }, from: asker }, MINUTE)]);
    expect(read(model, me, 30 * MINUTE)).toMatchObject({ state: "waiting-human" });
    model.apply(row("request.answered", { id: "req-1", answer: {} }, 31 * MINUTE));
    expect(read(model, me, 32 * MINUTE)).toMatchObject({ state: "working", last: 31 * MINUTE });
  });

  test("a question to another session is waiting for an event, not for a person", () => {
    const asker = { kind: "session", harness: "claude", id: "abc" };
    const model = modelOf([...turn(0), row("request.created", { id: "req-1", to: { kind: "session", harness: "codex", id: "x1" }, from: asker }, MINUTE)]);
    expect(read(model, me, 30 * MINUTE)).toMatchObject({ state: "waiting-event" });
    // A person's question beside it makes the session wait for the person.
    model.apply(row("request.created", { id: "req-2", to: { kind: "owner" }, from: asker }, 2 * MINUTE));
    expect(read(model, me, 30 * MINUTE)).toMatchObject({ state: "waiting-human" });
    model.apply(row("request.cancelled", { id: "req-2" }, 3 * MINUTE));
    expect(read(model, me, 30 * MINUTE)).toMatchObject({ state: "waiting-event" });
    model.apply(row("request.answered", { id: "req-1", answer: {} }, 4 * MINUTE));
    expect(read(model, me, 5 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("a session of another harness is unknown when first seen, working with its progress, idle when it pauses", () => {
    const named = { harness: "codex", native: "x1" };
    const subject = sessionSubject("codex", "x1");
    const model = modelOf([row("history.session.seen", { session: named, harness: "codex" }, 0)]);
    expect(read(model, subject, MINUTE)).toMatchObject({ state: "unknown" });
    model.apply(row("session.progress", { session: named, done: 0, total: 2 }, 2 * MINUTE));
    expect(read(model, subject, 3 * MINUTE)).toMatchObject({ state: "working", since: 2 * MINUTE });
    model.apply(row("history.session.paused", { session: named, upto: "x", why: "idle" }, 4 * MINUTE));
    expect(read(model, subject, 99 * MINUTE)).toMatchObject({ state: "idle", since: 4 * MINUTE });
  });

  test("the history beginning to watch a session niwa runs does not make it unknown", () => {
    const model = modelOf([...turn(0), row("history.session.seen", { session: { harness: "claude", native: "abc" }, harness: "claude" }, 1000)]);
    expect(read(model, me, 2000)).toMatchObject({ state: "working", since: 0 });
  });

  test("an ended session is not followed, and a stray sign after the end does not bring it back", () => {
    const model = modelOf([...turn(0), row("session.ended", { session: ME }, MINUTE)]);
    expect(read(model, me, 2 * MINUTE)).toBeUndefined();
    model.apply(row("session.activity", { session: ME, tool: "Bash" }, 3 * MINUTE));
    expect(model.readings(4 * MINUTE)).toEqual([]);
    // A new turn is a reason.
    model.apply(row("session.turn-started", { session: ME, turn: 2 }, 5 * MINUTE));
    expect(read(model, me, 6 * MINUTE)?.state).toBe("working");
  });

  test("a record that cannot be read is passed over", () => {
    const model = modelOf([row("session.started", { nonsense: true }, 0), row("session.activity", 7, 0), ...turn(0)]);
    expect(model.readings(MINUTE).map((one) => one.subject)).toEqual([me]);
  });
});

describe("sessions the history also follows", () => {
  const named = { harness: "claude", native: "abc" };
  const managed = (at = 0) => [row("session.started", { session: ME, id: "s-1" }, 0), row("session.turn-started", { session: ME, turn: 1 }, at)];

  test("a pause of the transcript does not make a turn niwa runs idle: a hung turn goes on to be stuck", () => {
    const model = modelOf([...managed(), row("history.session.seen", { session: named, harness: "claude" }, 1000), row("history.session.paused", { session: named, upto: "x", why: "idle" }, MINUTE)]);
    expect(read(model, me, 5 * MINUTE)).toMatchObject({ state: "working", since: 0 });
    expect(read(model, me, 10 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent", since: 10 * MINUTE });
  });

  test("a guessed end from the history does not end a session niwa runs; an exact one does", () => {
    const model = modelOf([...managed(), row("history.session.ended", { session: named, certainty: "guessed", why: "idle" }, MINUTE)]);
    expect(read(model, me, 2 * MINUTE)).toMatchObject({ state: "working" });
    model.apply(row("history.session.ended", { session: named, certainty: "exact", why: "session-ended" }, 3 * MINUTE));
    expect(read(model, me, 4 * MINUTE)).toBeUndefined();
  });

  test("a session only the history follows is not followed once it is unwatched, and its flag is closed", () => {
    const other = { harness: "codex", native: "x1" };
    const subject = sessionSubject("codex", "x1");
    const model = modelOf([
      row("history.session.seen", { session: other, harness: "codex" }, 0),
      row("session.progress", { session: other, done: 1, total: 3 }, MINUTE),
      row("watch.stuck", { subject, since: 11 * MINUTE, last: MINUTE, kind: "silent" }, 11 * MINUTE),
      row("history.session.unwatched", { session: other }, 12 * MINUTE),
    ]);
    expect(read(model, subject, 60 * MINUTE)).toBeUndefined();
    expect(transitions(model.flags(), model.readings(60 * MINUTE)).map((one) => one.type)).toEqual(["recovered"]);
    // A sign from it afterwards does not bring it back.
    model.apply(row("session.progress", { session: other, done: 2, total: 3 }, 13 * MINUTE));
    expect(model.readings(14 * MINUTE)).toEqual([]);
  });

  test("a session niwa runs is still watched by its own records after the history stops watching it", () => {
    const model = modelOf([...managed(), row("history.session.unwatched", { session: named }, MINUTE)]);
    expect(read(model, me, 2 * MINUTE)).toMatchObject({ state: "working" });
    expect(read(model, me, 10 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent" });
  });
});

describe("runs", () => {
  const run = runSubject("run-1");
  const inv = handler("inv-1");
  const started = (at = 0) => [row("workflow.run.requested", { run: "run-1", file: "f.ts" }, at), row("workflow.run.started", { run: "run-1", file: "f.ts" }, at, inv)];
  const intent = (key: string, input: unknown, at: number, action = "git.status") =>
    row("niwa.step.intent", { invocation: "inv-1", key, action, input, operationId: `op-${key}` }, at);

  test("a run asked for and not started is idle", () => {
    const model = modelOf([row("workflow.run.requested", { run: "run-1", file: "f.ts" }, 0)]);
    expect(model.readingOf(run, 99 * MINUTE)).toMatchObject({ state: "idle", since: 0 });
  });

  test("a started run is working, and stuck when its steps stop for too long", () => {
    const model = modelOf([...started(), intent("a", 1, MINUTE)]);
    expect(model.readingOf(run, 5 * MINUTE)).toMatchObject({ state: "working", last: MINUTE });
    expect(model.readingOf(run, 11 * MINUTE)).toEqual({ subject: run, state: "stuck", kind: "silent", since: 11 * MINUTE, last: MINUTE });
  });

  test("a run suspended on a record waits for an event; on a timer it sleeps; on a question it waits for a person", () => {
    const model = modelOf([...started(), row("niwa.invocation.state", { invocation: "inv-1", state: "waiting" }, MINUTE)]);
    expect(model.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "waiting-event" });

    model.apply(intent("nap", null, 2 * MINUTE, "niwa.wait"));
    model.apply(row("timer.sleep.requested", { at: 90 * MINUTE, key: "inv-1:nap" }, 2 * MINUTE, inv));
    expect(model.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "sleeping" });
    model.apply(row("timer.slept", { key: "inv-1:nap" }, 90 * MINUTE));
    model.apply(row("niwa.step.outcome", { invocation: "inv-1", key: "nap", outcome: {} }, 90 * MINUTE));
    expect(model.readingOf(run, 91 * MINUTE)).toMatchObject({ state: "waiting-event" });

    model.apply(row("request.created", { id: "req-9", to: { kind: "owner" } }, 92 * MINUTE, inv));
    expect(model.readingOf(run, 120 * MINUTE)).toMatchObject({ state: "waiting-human" });
    model.apply(row("request.expired", { id: "req-9" }, 121 * MINUTE));
    model.apply(row("niwa.invocation.state", { invocation: "inv-1", state: "running" }, 121 * MINUTE));
    expect(model.readingOf(run, 122 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("a wait with a timeout waits for an event, and a timer left behind does not make a later wait a sleep", () => {
    const outcome = (key: string, at: number) => row("niwa.step.outcome", { invocation: "inv-1", key, outcome: {} }, at);
    const model = modelOf([
      ...started(),
      intent("w1", { type: "x.done", place: "inv-1:w1" }, MINUTE, "workflow.script.wait"),
      row("timer.sleep.requested", { at: 90 * MINUTE, key: "inv-1:w1" }, MINUTE, inv),
      row("niwa.invocation.state", { invocation: "inv-1", state: "waiting" }, MINUTE),
    ]);
    expect(model.readingOf(run, 30 * MINUTE)).toMatchObject({ state: "waiting-event" });
    // The record came before the timer ran out; its timer is still armed when the run waits again.
    model.apply(outcome("w1", 2 * MINUTE));
    model.apply(row("niwa.invocation.state", { invocation: "inv-1", state: "running" }, 2 * MINUTE));
    model.apply(intent("w2", { type: "y.done" }, 3 * MINUTE, "workflow.script.wait"));
    model.apply(row("niwa.invocation.state", { invocation: "inv-1", state: "waiting" }, 3 * MINUTE));
    expect(model.readingOf(run, 30 * MINUTE)).toMatchObject({ state: "waiting-event" });
  });

  test("a sleep that is cancelled with its branch is no longer what the run waits for", () => {
    const model = modelOf([
      ...started(),
      intent("nap", null, MINUTE, "niwa.wait"),
      row("timer.sleep.requested", { at: 90 * MINUTE, key: "inv-1:nap" }, MINUTE, inv),
      intent("w", { type: "x.done" }, MINUTE, "workflow.script.wait"),
      row("niwa.step.cancelled", { invocation: "inv-1", prefixes: ["w"], reason: "enough" }, 2 * MINUTE),
      row("niwa.invocation.state", { invocation: "inv-1", state: "waiting" }, 2 * MINUTE),
    ]);
    expect(model.readingOf(run, 30 * MINUTE)).toMatchObject({ state: "sleeping" });
  });

  test("a run that asked a session waits for an event; one that asked the owner waits for a person", () => {
    const model = modelOf([...started(), row("niwa.invocation.state", { invocation: "inv-1", state: "waiting" }, MINUTE)]);
    model.apply(row("request.created", { id: "req-s", to: { kind: "session", harness: "codex", id: "x1" } }, 2 * MINUTE, inv));
    expect(model.readingOf(run, 30 * MINUTE)).toMatchObject({ state: "waiting-event" });
    model.apply(row("request.created", { id: "req-o", to: { kind: "owner" } }, 3 * MINUTE, inv));
    expect(model.readingOf(run, 30 * MINUTE)).toMatchObject({ state: "waiting-human" });
  });

  const state = (value: string, at: number, invocation = "inv-1") => row("niwa.invocation.state", { invocation, state: value }, at);
  const resolved = (at: number, choice = "retry") => row("niwa.invocation.resolved", { invocation: "inv-1", key: "a", choice }, at);

  test("a run paused on an error waits for a person until the answer, whichever it is", () => {
    const paused = [...started(), row("workflow.run.paused", { run: "run-1", reason: "a step failed", key: "a", choices: ["retry", "skip", "cancel"] }, MINUTE, inv), state("paused", MINUTE)];
    const model = modelOf(paused);
    expect(model.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "waiting-human" });
    // A retry or a skip is an answer of the core; no `workflow.run.continued` comes with it.
    model.apply(resolved(61 * MINUTE));
    model.apply(state("running", 61 * MINUTE));
    expect(model.readingOf(run, 62 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("a run cancelled from a pause is over, and one that waits for its script to be revised is not", () => {
    const failed = [...started(), row("workflow.run.paused", { run: "run-1", reason: "a step failed", key: "a", choices: ["retry", "skip", "cancel"] }, MINUTE, inv), state("paused", MINUTE)];
    const cancelled = modelOf([...failed, resolved(2 * MINUTE, "cancel"), state("done", 2 * MINUTE)]);
    expect(cancelled.readings(3 * MINUTE)).toEqual([]);

    const edited = modelOf([...started(), row("workflow.run.paused", { run: "run-1", reason: "the script was edited", choices: ["cancel"] }, MINUTE, inv), state("done", MINUTE)]);
    expect(edited.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "waiting-human" });
  });

  test("a revised run starts clean: the pause of the attempt before does not carry over", () => {
    const model = modelOf([...started(), row("workflow.run.paused", { run: "run-1", reason: "the script was edited", choices: ["cancel"] }, MINUTE, inv), state("done", MINUTE)]);
    model.apply(row("workflow.run.requested", { run: "run-1", file: "f.ts" }, 2 * MINUTE));
    expect(model.readingOf(run, 3 * MINUTE)).toMatchObject({ state: "idle" });
    const next = handler("inv-2");
    model.apply(row("workflow.run.started", { run: "run-1", file: "f.ts" }, 4 * MINUTE, next));
    expect(model.readingOf(run, 5 * MINUTE)).toMatchObject({ state: "working" });
    // What the first attempt's invocation writes afterwards is not the new attempt's.
    model.apply(state("paused", 6 * MINUTE));
    model.apply(row("workflow.run.paused", { run: "run-1", reason: "late" }, 6 * MINUTE, inv));
    expect(model.readingOf(run, 7 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("a pause someone asked for holds the run at its next boundary, and only the matching continue releases it", () => {
    const begun = [...started(), intent("a", 1, 30_000)];
    const pause = row("workflow.run.pause-requested", { run: "run-1" }, MINUTE);
    const model = modelOf([...begun, pause]);
    // Not yet at a boundary: the run goes on.
    expect(model.readingOf(run, 2 * MINUTE)).toMatchObject({ state: "working" });
    model.apply(state("waiting", 3 * MINUTE));
    expect(model.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "waiting-human" });
    // Another pause's release (a hold shares the record) does not free it.
    model.apply(row("workflow.run.continued", { run: "run-1", pause: "some-hold" }, 4 * MINUTE));
    expect(model.readingOf(run, 60 * MINUTE)).toMatchObject({ state: "waiting-human" });
    model.apply(row("workflow.run.continued", { run: "run-1", pause: String(pause.id) }, 5 * MINUTE));
    model.apply(state("running", 5 * MINUTE));
    expect(model.readingOf(run, 6 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("a run that reached its deadline waits for a person from the moment it says so, until it is extended", () => {
    const begun = started();
    const pause = row("workflow.run.pause-requested", { run: "run-1", kind: "deadline", deadline: MINUTE }, MINUTE);
    const model = modelOf([...begun, pause]);
    expect(model.readingOf(run, 2 * MINUTE)).toMatchObject({ state: "waiting-human" });
    model.apply(row("workflow.run.continued", { run: "run-1", pause: String(pause.id) }, 3 * MINUTE));
    expect(model.readingOf(run, 4 * MINUTE)).toMatchObject({ state: "working" });
  });

  test("the same step six times in a row is a loop; another step or a moved head ends it", () => {
    const rows = [...started()];
    for (let n = 1; n <= 6; n += 1) rows.push(intent(`k${n}`, { repo: "r" }, n * 1000));
    const model = modelOf(rows);
    expect(model.readingOf(run, 7000)).toEqual({ subject: run, state: "looping", kind: "looping", since: 1000, last: 6000 });

    model.apply(row("git.head.moved", { repo: "r", head: "h2" }, 8000, inv));
    expect(model.readingOf(run, 9000)?.state).toBe("working");

    const other = modelOf([...rows.slice(0, 5), intent("odd", { repo: "x" }, 6000), intent("k7", { repo: "r" }, 7000)]);
    expect(other.readingOf(run, 8000)?.state).toBe("working");
  });

  test("the steps the bridge adds around a call do not hide a loop of the calls", () => {
    const rows = [...started()];
    for (let n = 1; n <= 6; n += 1) {
      rows.push(intent(`k${n}~auth`, { verb: "call", name: "git.status" }, n * 1000, "workflow.authorize"), intent(`k${n}`, { repo: "r" }, n * 1000 + 1));
    }
    expect(modelOf(rows).readingOf(run, 7000)).toEqual({ subject: run, state: "looping", kind: "looping", since: 1001, last: 6001 });
    // They are signs of life all the same.
    const lone = modelOf([...started(), intent("k1~auth", { verb: "call", name: "x" }, 5 * MINUTE, "workflow.authorize")]);
    expect(lone.readingOf(run, 6 * MINUTE)).toMatchObject({ state: "working", last: 5 * MINUTE });
  });

  test("a loop of the same sleep is not counted by the clock and the arming around it", () => {
    const rows = [...started()];
    for (let n = 1; n <= 6; n += 1) {
      rows.push(
        intent(`nap${n}~now`, null, n * 1000, "niwa.now"),
        intent(`nap${n}~arm`, { at: n * 5000, key: `inv-1:nap${n}` }, n * 1000, "timer.sleep.request"),
        intent(`nap${n}`, null, n * 1000, "niwa.wait"),
      );
    }
    expect(modelOf(rows).readingOf(run, 7000)).toMatchObject({ state: "working" });
  });

  test("a line the run wrote to its log is a sign of life, a line of an attempt before is not", () => {
    const model = modelOf([...started(), intent("a", 1, 0), row("workflow.run.log", { run: "run-1", text: "halfway" }, 9 * MINUTE + 50_000, inv)]);
    expect(model.readingOf(run, 19 * MINUTE)).toMatchObject({ state: "working", last: 9 * MINUTE + 50_000 });
    expect(model.readingOf(run, 20 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent" });
    model.apply(row("workflow.run.log", { run: "run-1", text: "late" }, 15 * MINUTE, handler("inv-0")));
    expect(model.readingOf(run, 20 * MINUTE)).toMatchObject({ last: 9 * MINUTE + 50_000 });
  });

  test("a phase the script enters or leaves is progress: a loop before it is over", () => {
    const rows = [...started()];
    for (let n = 1; n <= 6; n += 1) rows.push(intent(`k${n}`, { repo: "r" }, n * 1000));
    const model = modelOf(rows);
    expect(model.readingOf(run, 7000)?.state).toBe("looping");
    model.apply(row("workflow.phase.entered", { run: "run-1", branch: "", phase: "Review" }, 8000, inv));
    expect(model.readingOf(run, 9000)).toMatchObject({ state: "working", last: 8000 });
    for (let n = 7; n <= 12; n += 1) model.apply(intent(`k${n}`, { repo: "r" }, n * 1000));
    expect(model.readingOf(run, 13_000)?.state).toBe("looping");
    model.apply(row("workflow.phase.left", { run: "run-1", branch: "" }, 14_000, inv));
    expect(model.readingOf(run, 15_000)).toMatchObject({ state: "working", last: 14_000 });
  });

  test("a record read twice is counted once", () => {
    const rows = [...started()];
    for (let n = 1; n <= 5; n += 1) rows.push(intent(`k${n}`, { repo: "r" }, n * 1000));
    const model = new Model();
    for (const one of rows) model.apply(one);
    for (const one of rows) model.apply(one);
    expect(model.readingOf(run, 6000)).toMatchObject({ state: "working" });
    model.apply(intent("k6", { repo: "r" }, 6000));
    expect(model.readingOf(run, 7000)).toMatchObject({ state: "looping" });
  });

  test("the input is compared as data, not as text: key order does not hide a loop", () => {
    const rows = [...started()];
    for (let n = 1; n <= 6; n += 1) rows.push(intent(`k${n}`, n % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 }, n * 1000));
    expect(modelOf(rows).readingOf(run, 7000)?.state).toBe("looping");
  });

  const shield = (scope: string, at: number) => row("workflow.scope.opened", { run: "run-1", scope, onExit: "wait", shield: true }, at);
  const cancel = (at: number, except?: string[]) =>
    row("niwa.step.cancelled", { invocation: "inv-1", prefixes: [""], ...(except === undefined ? {} : { except }), reason: "enough" }, at);

  test("a cancel that spares a shielded scope makes the run stuck once the grace has passed, until the scope closes", () => {
    const model = modelOf([...started(), shield("safe", 1000), cancel(5000, ["safe"])]);
    expect(model.readingOf(run, 5000 + 59_999)?.kind).toBeUndefined();
    expect(model.readingOf(run, 5000 + MINUTE)).toEqual({ subject: run, state: "stuck", kind: "shielded-cancel", since: 5000, last: 5000 });
    model.apply(row("workflow.scope.closed", { run: "run-1", scope: "safe", outcome: "done" }, 70_000));
    expect(model.readingOf(run, 80_000)?.kind).toBeUndefined();
  });

  test("a cancel that spares nothing is not held against the run, even when a shield opens long after it", () => {
    const model = modelOf([...started(), cancel(5000), shield("late", 10 * MINUTE)]);
    expect(model.readingOf(run, 15 * MINUTE)).toMatchObject({ state: "working", last: 10 * MINUTE });
  });

  test("only the shields a cancel spared are blamed, each from its own cancel", () => {
    const model = modelOf([...started(), shield("a", 1000), cancel(5000, ["a"]), shield("b", 6000), cancel(10_000, ["a", "b"])]);
    expect(model.readingOf(run, 20_000)?.kind).toBeUndefined();
    expect(model.readingOf(run, 5000 + MINUTE)).toMatchObject({ kind: "shielded-cancel", since: 5000 });
    // "a" closes: "b", spared by the later cancel, is what is left.
    model.apply(row("workflow.scope.closed", { run: "run-1", scope: "a", outcome: "done" }, 62_000));
    expect(model.readingOf(run, 63_000)?.kind).toBeUndefined();
    expect(model.readingOf(run, 10_000 + MINUTE)).toMatchObject({ kind: "shielded-cancel", since: 10_000 });
  });

  test("a finished run is not followed", () => {
    const model = modelOf([...started(), row("workflow.run.finished", { run: "run-1", outcome: { status: "done", result: null } }, MINUTE)]);
    expect(model.readings(2 * MINUTE)).toEqual([]);
  });

  test("steps of an invocation that is no run of the model's are passed over", () => {
    const model = modelOf([...started(), row("niwa.step.intent", { invocation: "inv-other", key: "a", action: "x", input: 1 }, 5000)]);
    expect(model.readingOf(run, 6000)).toMatchObject({ last: 0 });
  });
});

describe("the time the watch was not looking", () => {
  test("silence is counted from the moment the watch began, not from a record written before it", () => {
    const rows = [row("session.started", { session: ME, id: "s-1" }, 0), row("session.turn-started", { session: ME, turn: 1 }, 0)];
    const model = modelOf(rows, 100 * MINUTE);
    expect(read(model, me, 105 * MINUTE)?.state).toBe("working");
    expect(read(model, me, 110 * MINUTE)).toMatchObject({ state: "stuck", since: 110 * MINUTE, last: 0 });
  });

  test("a silence the watch had already flagged stays stuck from where it began", () => {
    const rows = [
      row("session.started", { session: ME, id: "s-1" }, 0),
      row("session.turn-started", { session: ME, turn: 1 }, 0),
      row("watch.stuck", { subject: me, since: 10 * MINUTE, last: 0, kind: "silent" }, 10 * MINUTE),
    ];
    const model = modelOf(rows, 100 * MINUTE);
    expect(read(model, me, 101 * MINUTE)).toMatchObject({ state: "stuck", kind: "silent", since: 10 * MINUTE });
    expect(transitions(model.flags(), model.readings(101 * MINUTE))).toEqual([]);
  });
});

describe("flags and transitions", () => {
  const reading = (over: Partial<Reading>): Reading => ({ subject: me, state: "stuck", since: 10, last: 0, kind: "silent", ...over });
  const flag = (over: Partial<OpenFlag> = {}): OpenFlag => ({ since: 10, last: 0, kind: "silent", ...over });
  const flags = (one?: OpenFlag) => new Map(one === undefined ? [] : [[me, one]]);

  test("a stuck subject with no flag gets one, and with the same flag gets nothing", () => {
    expect(transitions(flags(), [reading({})])).toEqual([{ type: "stuck", data: { subject: me, since: 10, last: 0, kind: "silent" } }]);
    expect(transitions(flags(flag()), [reading({})])).toEqual([]);
  });

  test("a flag whose subject works again, is gone, or is stuck another way is closed first", () => {
    const closes: Transition = { type: "recovered", data: { subject: me, since: 10, kind: "silent" } };
    expect(transitions(flags(flag()), [reading({ state: "working", kind: undefined })])).toEqual([closes]);
    expect(transitions(flags(flag()), [])).toEqual([closes]);
    expect(transitions(flags(flag()), [reading({ state: "looping", kind: "looping", since: 12 })])).toEqual([
      closes,
      { type: "stuck", data: { subject: me, since: 12, last: 0, kind: "looping" } },
    ]);
    // The same kind from a new moment is a new condition.
    expect(transitions(flags(flag()), [reading({ since: 99 })]).map((one) => one.type)).toEqual(["recovered", "stuck"]);
  });

  test("a recovered record closes the flag it names and not a newer one", () => {
    const model = modelOf([
      row("watch.stuck", { subject: me, since: 10, last: 0, kind: "silent" }, 10),
      row("watch.recovered", { subject: me, since: 10, kind: "silent" }, 20),
      row("watch.stuck", { subject: me, since: 30, last: 25, kind: "silent" }, 30),
      row("watch.recovered", { subject: me, since: 10, kind: "silent" }, 31),
    ]);
    expect([...model.flags().values()]).toEqual([{ since: 30, last: 25, kind: "silent" }]);
  });
});

describe("what the service reads", () => {
  test("the sources hold every record type the model reads", () => {
    const query = resolveQuery({ types: SOURCES });
    for (const type of [
      "session.activity",
      "history.session.unwatched",
      "workflow.run.pause-requested",
      "workflow.run.continued",
      "workflow.run.log",
      "workflow.phase.entered",
      "workflow.phase.left",
      "niwa.invocation.state",
      "niwa.invocation.resolved",
      "niwa.step.intent",
      "niwa.step.outcome",
      "niwa.step.cancelled",
    ]) {
      expect(selectsType(query, type), type).toBe(true);
    }
  });
});
