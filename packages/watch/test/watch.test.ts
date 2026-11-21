import { expect, test } from "bun:test";
import { z } from "zod";

import { record } from "@niwa-labs/core";
import type { Action, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import type { TestClock } from "@niwa-labs/testing";

import { watch } from "../src/index.ts";
import { WatchRecovered, WatchStuck, sessionSubject, watchGet, watchList } from "../src/records.ts";

const MINUTE = 60_000;
const START = 1_000_000;
const ME = "claude abc";
const me = sessionSubject("claude", "abc");

// The records of the sessions, as the sessions plugin writes them, declared here so that a host
// without that plugin can carry them. Only the fields the watch reads are given.
const Started = record("session.started", z.object({ session: z.string(), id: z.string() }));
const TurnStarted = record("session.turn-started", z.object({ session: z.string(), turn: z.number() }));
const TurnEnded = record("session.turn-ended", z.object({ session: z.string(), turn: z.number() }));
const Activity = record("session.activity", z.object({ session: z.string(), tool: z.string().optional() }));
const sessionRecords = plugin("fixture", (api) => api.declare(Started, TurnStarted, TurnEnded, Activity));

interface Rig {
  readonly niwa: ReturnType<typeof createNiwa>;
  readonly clock: TestClock;
}

async function rig(use: Plugin[], run: (rig: Rig) => Promise<void>, opts: { home?: string; start?: number } = {}): Promise<void> {
  const home = opts.home === undefined ? await tempHome() : undefined;
  const clock = testClock(opts.start ?? START);
  const niwa = createNiwa({ home: opts.home ?? home!.path, clock });
  try {
    niwa.use(sessionRecords, ...use);
    await niwa.serve();
    await run({ niwa, clock });
  } finally {
    await niwa.close();
    await home?.cleanup();
  }
}

const flagsOf = async (niwa: Rig["niwa"]): Promise<StoredRecord[]> =>
  (await niwa.records.read()).filter((row) => row.type === "watch.stuck" || row.type === "watch.recovered");

const typesOf = (rows: StoredRecord[]): string[] => rows.map((row) => row.type as string);

async function beginTurn(niwa: Rig["niwa"]): Promise<void> {
  await niwa.emit(Started, { session: ME, id: "s-1" });
  await niwa.emit(TurnStarted, { session: ME, turn: 1 });
}

test("a session that goes quiet is flagged once, when its time runs out", async () => {
  await rig([watch()], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    await clock.advance(9 * MINUTE);
    expect(await flagsOf(niwa)).toEqual([]);

    await clock.advance(2 * MINUTE);
    const flags = await flagsOf(niwa);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ type: "watch.stuck", data: { subject: me, kind: "silent", last: START, since: START + 10 * MINUTE } });

    await clock.advance(30 * MINUTE);
    expect(await flagsOf(niwa)).toHaveLength(1);
    expect(await niwa.call(watchGet, { subject: me })).toMatchObject({ state: "stuck", kind: "silent" });
  });
});

test("a sign of life from a flagged session is recorded as a recovery, and a new silence is a new flag", async () => {
  await rig([watch()], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    await clock.advance(11 * MINUTE);
    await niwa.emit(Activity, { session: ME, tool: "Bash" });
    await clock.advance(MINUTE);

    const flags = await flagsOf(niwa);
    expect(typesOf(flags)).toEqual(["watch.stuck", "watch.recovered"]);
    expect(flags[1]?.data).toEqual({ subject: me, kind: "silent", since: START + 10 * MINUTE });
    expect(await niwa.call(watchGet, { subject: me })).toMatchObject({ state: "working" });

    await clock.advance(12 * MINUTE);
    expect(typesOf(await flagsOf(niwa))).toEqual(["watch.stuck", "watch.recovered", "watch.stuck"]);
  });
});

test("a session that ends while flagged has its flag closed", async () => {
  await rig([watch()], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    await clock.advance(11 * MINUTE);
    await niwa.emit(TurnEnded, { session: ME, turn: 1 });
    await clock.advance(MINUTE);
    expect(typesOf(await flagsOf(niwa))).toEqual(["watch.stuck", "watch.recovered"]);
    expect(await niwa.call(watchGet, { subject: me })).toMatchObject({ state: "idle" });
  });
});

test("a flag survives a restart without a second record, and a sign of life after it still recovers", async () => {
  const home = await tempHome();
  try {
    await rig([watch()], async ({ niwa, clock }) => {
      await beginTurn(niwa);
      await clock.advance(11 * MINUTE);
      expect(await flagsOf(niwa)).toHaveLength(1);
    }, { home: home.path });

    await rig([watch()], async ({ niwa, clock }) => {
      await clock.advance(5 * MINUTE);
      expect(typesOf(await flagsOf(niwa))).toEqual(["watch.stuck"]);
      expect(await niwa.call(watchGet, { subject: me })).toMatchObject({ state: "stuck", kind: "silent", since: START + 10 * MINUTE });

      await niwa.emit(Activity, { session: ME });
      await clock.advance(MINUTE);
      expect(typesOf(await flagsOf(niwa))).toEqual(["watch.stuck", "watch.recovered"]);
    }, { home: home.path, start: START + 3 * 60 * MINUTE });
  } finally {
    await home.cleanup();
  }
});

test("time the host was down is not counted as silence", async () => {
  const home = await tempHome();
  try {
    await rig([watch()], async ({ niwa }) => {
      await beginTurn(niwa);
    }, { home: home.path });

    await rig([watch()], async ({ niwa, clock }) => {
      await clock.advance(9 * MINUTE);
      expect(await flagsOf(niwa)).toEqual([]);
      await clock.advance(2 * MINUTE);
      expect(await flagsOf(niwa)).toHaveLength(1);
    }, { home: home.path, start: START + 5 * 60 * MINUTE });
  } finally {
    await home.cleanup();
  }
});

test("a workflow-like subscriber is woken by the records it filters for, and by no others", async () => {
  const silent: string[] = [];
  const looping: string[] = [];
  const reactions = plugin("react", (api) => {
    api.on(WatchStuck, { id: "poke", filter: { kind: "silent" } }, (data) => void silent.push(data.subject));
    api.on(WatchStuck, { id: "kill", filter: { kind: "looping" } }, (data) => void looping.push(data.subject));
    api.on(WatchRecovered, { id: "relax" }, () => undefined);
  });
  await rig([watch(), reactions], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    await clock.advance(11 * MINUTE);
    await eventually(() => silent.length === 1);
    expect(silent).toEqual([me]);
    expect(looping).toEqual([]);
  });
});

test("a session looping on the same activity is flagged as looping", async () => {
  await rig([watch({ sessionLoopRepeats: 3 })], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    for (let n = 0; n < 3; n += 1) {
      await clock.advance(1000);
      await niwa.emit(Activity, { session: ME, tool: "Edit" });
    }
    await clock.advance(20_000);
    const flags = await flagsOf(niwa);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ type: "watch.stuck", data: { subject: me, kind: "looping" } });
  });
});

test("watch.get and watch.list read the states now, with records written since the last look", async () => {
  await rig([watch({ silentAfter: 5 * MINUTE })], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    expect((await niwa.call(watchList, {})).subjects).toEqual([{ subject: me, state: "working", since: START, last: START }]);

    await niwa.emit(Started, { session: "claude other", id: "s-2" });
    const other = sessionSubject("claude", "other");
    expect(await niwa.call(watchGet, { subject: other })).toEqual({ subject: other, state: "idle", since: START, last: START });
    expect((await niwa.call(watchList, {})).subjects.map((one) => [one.subject, one.state])).toEqual([
      [me, "working"],
      [other, "idle"],
    ]);

    await clock.advance(6 * MINUTE);
    expect((await niwa.call(watchList, { state: "stuck" })).subjects.map((one) => one.subject)).toEqual([me]);
    await expect(niwa.call(watchGet, { subject: sessionSubject("claude", "nobody") })).rejects.toThrow(/does not follow/);
  });
});

test("a record is counted once however many looks read past it", async () => {
  await rig([watch({ sessionLoopRepeats: 3 })], async ({ niwa, clock }) => {
    await beginTurn(niwa);
    await niwa.emit(Activity, { session: ME, tool: "Edit" });
    await niwa.emit(Activity, { session: ME, tool: "Edit" });
    // Many looks pass over the two records; two repeats are not three.
    await clock.advance(5 * MINUTE);
    expect(await flagsOf(niwa)).toEqual([]);
    expect(await niwa.call(watchGet, { subject: me })).toMatchObject({ state: "working" });
  });
});

test("the limits must be positive numbers", () => {
  expect(() => watch({ silentAfter: 0 })).toThrow(/silentAfter/);
  expect(() => watch({ tick: -1 })).toThrow(/tick/);
  expect(() => watch({ loopRepeats: Number.NaN })).toThrow(/loopRepeats/);
  expect(() => watch({ silentAfter: undefined })).not.toThrow();
});

/** The actions a plugin registers, read by running its setup against a recording api. */
function actionsOf(source: Plugin): Map<string, Action<any, any, any>> {
  const found = new Map<string, Action<any, any, any>>();
  const api = new Proxy({} as PluginApi, {
    get: (_target, name) => (name === "action" ? (one: Action<any, any, any>) => void found.set(one.name, one) : () => undefined),
  });
  source.setup(api);
  return found;
}

test("the watch only reads: its actions are reads of niwa's own state", () => {
  const actions = actionsOf(watch());
  expect([...actions.keys()].sort()).toEqual(["watch.get", "watch.list"]);
  for (const one of actions.values()) expect(one).toMatchObject({ effect: "read", world: "niwa", recovery: "repeat" });
  expect(actions.get("watch.get")?.target?.({ subject: me })).toBe(me);
});
