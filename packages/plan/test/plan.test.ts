import { expect, test } from "bun:test";

import type { Action } from "@niwa-labs/core";
import { createNiwa, tempHome, testClock } from "@niwa-labs/testing";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";

import { plan } from "../src/index.ts";
import { planGet, planList, planSet } from "../src/records.ts";
import type { PlanItem } from "../src/records.ts";

const decide: PlanItem = { id: "shape", text: "Choose the storage shape", state: "open" };
const build: PlanItem = { id: "build", text: "Build the reader", state: "planned" };

async function withPlans(run: (niwa: ReturnType<typeof createNiwa>) => Promise<void>): Promise<void> {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path, clock: testClock(1_000_000) });
  try {
    niwa.use(plan());
    await niwa.serve();
    await run(niwa);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
}

test("each set is the next revision, and any revision can be read back", async () => {
  await withPlans(async (niwa) => {
    expect(await niwa.call(planSet, { of: "task-1", goal: "Ship the reader", items: [decide, build] })).toEqual({
      of: "task-1",
      rev: 1,
      revised: true,
    });
    const second = [{ ...decide, state: "done" as const, note: "one table" }, build];
    expect(await niwa.call(planSet, { of: "task-1", items: second })).toEqual({ of: "task-1", rev: 2, revised: true });

    const latest = await niwa.call(planGet, { of: "task-1" });
    expect(latest).toMatchObject({ of: "task-1", rev: 2, revisions: 2, items: second });
    expect(latest.goal).toBeUndefined();
    const first = await niwa.call(planGet, { of: "task-1", rev: 1 });
    expect(first).toMatchObject({ rev: 1, revisions: 2, goal: "Ship the reader", items: [decide, build] });
    expect(latest.at).toBe(1_000_000);
  });
});

test("a set equal to the latest revision writes nothing", async () => {
  await withPlans(async (niwa) => {
    await niwa.call(planSet, { of: "p", goal: "g", items: [build] });
    expect(await niwa.call(planSet, { of: "p", goal: "g", items: [build] })).toEqual({ of: "p", rev: 1, revised: false });
    const written = (await niwa.records.read()).filter((row) => row.type === "plan.revised");
    expect(written).toHaveLength(1);
    // A different goal over the same items is a revision.
    expect(await niwa.call(planSet, { of: "p", goal: "other", items: [build] })).toMatchObject({ rev: 2, revised: true });
  });
});

test("two sets at once are revisions 1 and 2, never the same number twice", async () => {
  await withPlans(async (niwa) => {
    const results = await Promise.all([
      niwa.call(planSet, { of: "race", items: [build] }),
      niwa.call(planSet, { of: "race", items: [decide] }),
    ]);
    expect(results.map((one) => one.rev).sort()).toEqual([1, 2]);
    const written = (await niwa.records.read()).filter((row) => row.type === "plan.revised");
    expect(written.map((row) => (row.data as { rev: number }).rev)).toEqual([1, 2]);
  });
});

test("expect refuses a set made on a revision that is no longer the latest", async () => {
  await withPlans(async (niwa) => {
    await expect(niwa.call(planSet, { of: "p", items: [build], expect: 3 })).rejects.toThrow(/revision 0/);
    await niwa.call(planSet, { of: "p", items: [build], expect: 0 });
    await niwa.call(planSet, { of: "p", items: [decide], expect: 1 });
    await expect(niwa.call(planSet, { of: "p", items: [build, decide], expect: 1 })).rejects.toThrow(/revision 2/);
    expect(await niwa.call(planGet, { of: "p" })).toMatchObject({ rev: 2, items: [decide] });
  });
});

test("a plan that does not exist, or a revision it never had, is refused", async () => {
  await withPlans(async (niwa) => {
    await expect(niwa.call(planGet, { of: "nothing" })).rejects.toThrow(/no plan/);
    await niwa.call(planSet, { of: "p", items: [] });
    await expect(niwa.call(planGet, { of: "p", rev: 2 })).rejects.toThrow(/no revision 2/);
  });
});

test("two items with one id are refused", async () => {
  await withPlans(async (niwa) => {
    await expect(niwa.call(planSet, { of: "p", items: [build, { ...decide, id: "build" }] })).rejects.toThrow(/used twice/);
  });
});

test("list shows each plan at its latest revision, and keeps those with a decision ahead", async () => {
  await withPlans(async (niwa) => {
    await niwa.call(planSet, { of: "a", goal: "A", items: [decide, build] });
    await niwa.call(planSet, { of: "b", items: [build] });
    await niwa.call(planSet, { of: "a", goal: "A", items: [{ ...decide, state: "done" }, build] });
    await niwa.call(planSet, { of: "c", items: [decide, { ...decide, id: "other" }] });

    const all = await niwa.call(planList, {});
    expect(all.plans).toEqual([
      { of: "a", rev: 2, goal: "A", items: 2, open: 0 },
      { of: "b", rev: 1, items: 1, open: 0 },
      { of: "c", rev: 1, items: 2, open: 2 },
    ]);
    const ahead = await niwa.call(planList, { open: true });
    expect(ahead.plans.map((one) => one.of)).toEqual(["c"]);
  });
});

test("the plan survives a restart of the host", async () => {
  const home = await tempHome();
  try {
    const first = createNiwa({ home: home.path });
    first.use(plan());
    await first.serve();
    await first.call(planSet, { of: "p", items: [build] });
    await first.close();

    const second = createNiwa({ home: home.path });
    second.use(plan());
    await second.serve();
    try {
      expect(await second.call(planSet, { of: "p", items: [decide] })).toMatchObject({ rev: 2 });
    } finally {
      await second.close();
    }
  } finally {
    await home.cleanup();
  }
});

/** The actions a plugin registers, read by running its setup against a recording api. */
function actionsOf(source: Plugin): Map<string, Action<any, any, any>> {
  const found = new Map<string, Action<any, any, any>>();
  const api = new Proxy({} as PluginApi, {
    get: (_target, name) =>
      name === "action" ? (one: Action<any, any, any>) => void found.set(one.name, one) : () => undefined,
  });
  source.setup(api);
  return found;
}

test("setting a plan is a record of niwa's own, and reading is a read", () => {
  const actions = actionsOf(plan());
  const set = actions.get("plan.set");
  expect(set).toMatchObject({ effect: "record", world: "niwa", idempotent: true });
  expect(actions.get("plan.get")).toMatchObject({ effect: "read", world: "niwa" });
  expect(actions.get("plan.list")).toMatchObject({ effect: "read", world: "niwa" });
  expect(set?.target?.({ of: "task-1", items: [] })).toBe("task-1");
});
