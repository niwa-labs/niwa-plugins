import { expect, test } from "bun:test";

import { CatchableError, IntegrityError, NotSent, effectPossibleAfter, isCallTarget, matchesQuery, recordId, stableJson } from "@niwa-labs/core";
import type { Action, ActionContext, JournalReader, NewRecord, OperationId, ResolvedQuery, StoredRecord } from "@niwa-labs/core";
import { createNiwa, tempHome, testClock } from "@niwa-labs/testing";
import type { Plugin, PluginApi } from "@niwa-labs/plugin";

import { PlanRefusal, plan } from "../src/index.ts";
import { PlanRevised, planGet, planList, planSet, planTarget } from "../src/records.ts";
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

test("the target of a plan is one a grant can name, whatever the plan is of", () => {
  for (const of of ["task-1", "a b", "feature/x", "star*", "{id}@host:1"]) expect(isCallTarget(planTarget(of))).toBe(true);
  expect(planTarget("feature/x*")).toBe("feature%2Fx%2A");
});

test("a set equal to the latest revision still answers to expect", async () => {
  await withPlans(async (niwa) => {
    await niwa.call(planSet, { of: "p", items: [build] });
    await expect(niwa.call(planSet, { of: "p", items: [build], expect: 90 })).rejects.toThrow(/revision 1, not 90/);
    await expect(niwa.call(planSet, { of: "p", items: [build], expect: 0 })).rejects.toThrow(/revision 1, not 0/);
    expect(await niwa.call(planSet, { of: "p", items: [build], expect: 1 })).toEqual({ of: "p", rev: 1, revised: false });
  });
});

test("a stale write records its refusal and leaves the plan unchanged", async () => {
  await withPlans(async (niwa) => {
    await niwa.call(planSet, { of: "p", items: [build] });
    const stale = await niwa.call(planSet, { of: "p", items: [decide], expect: 0 }).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(PlanRefusal);
    expect(stale).toBeInstanceOf(CatchableError);
    expect(stale).toMatchObject({ code: "stale", effectPossible: false });
    expect(effectPossibleAfter(stale)).toBe(false);
    expect(await niwa.records.read({ types: ["niwa.record.refused"] })).toHaveLength(1);
    expect(await niwa.call(planGet, { of: "nothing" }).catch((error: unknown) => error)).toMatchObject({ code: "unknown-plan" });
    expect(await niwa.call(planGet, { of: "p", rev: 9 }).catch((error: unknown) => error)).toMatchObject({ code: "unknown-revision" });
  });
});

test("a subject is read the way a grant names it, and text that cannot be encoded is refused", async () => {
  expect(planTarget(" p ")).toBe("p");
  expect(planTarget("  a b ")).toBe("a%20b");
  expect(() => planTarget("bad\ud800")).toThrow(/surrogate/);
  await withPlans(async (niwa) => {
    await expect(niwa.call(planSet, { of: "bad\udc00", items: [] })).rejects.toThrow(/surrogate/);
    await expect(niwa.call(planGet, { of: "\ud800x" })).rejects.toThrow(/surrogate/);
    await niwa.call(planSet, { of: "  spaced  ", items: [build] });
    expect(await niwa.call(planGet, { of: "spaced" })).toMatchObject({ of: "spaced", rev: 1 });
  });
});

/** A journal in memory that keeps what the real one keeps: records in commit order, written once by id. */
class MemoryJournal {
  readonly rows: StoredRecord[] = [];

  append(record: NewRecord): StoredRecord {
    const same = this.rows.find((row) => row.id === record.id);
    if (same !== undefined) {
      if (stableJson(same.data) !== stableJson(record.data)) throw new IntegrityError(record.id);
      return same;
    }
    const stored = { ...record, seq: this.rows.length + 1, at: 1_000_000 } as unknown as StoredRecord;
    this.rows.push(stored);
    return stored;
  }

  reader(): JournalReader {
    return {
      get: (id: string) => this.rows.find((row) => row.id === id),
      query: (query: ResolvedQuery) => this.rows.filter((row) => matchesQuery(query, row)),
    } as unknown as JournalReader;
  }
}

/** The plan actions run by hand over a journal of their own, as the host would run them. */
async function withJournal(
  run: (probe: {
    readonly journal: MemoryJournal;
    write(rev: number, items: PlanItem[], id: string): void;
    set(operation: string, input: Parameters<typeof planSet.input.parse>[0]): Promise<unknown>;
    get(input: Parameters<typeof planGet.input.parse>[0]): Promise<unknown>;
    list(input?: Parameters<typeof planList.input.parse>[0]): Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const journal = new MemoryJournal();
  const reader = journal.reader();
  const found = new Map<string, Action<any, any, any>>();
  const api = new Proxy({} as PluginApi, {
    get: (_target, name) => {
      if (name === "action") return (one: Action<any, any, any>) => void found.set(one.name, one);
      if (name === "journal") return () => reader;
      return () => undefined;
    },
  });
  plan().setup(api);
  // The context of one call: a call made again is a new context under the same operation.
  const context = (operationId: string): ActionContext => {
    let ordinal = 0;
    return {
      operationId: operationId as OperationId,
      caller: { kind: "host" },
      emit: async (type: { name: string; version: number }, data: unknown) => {
        ordinal += 1;
        const id = recordId(`${operationId}/emit/${ordinal}`);
        return journal.append({ id, stream: `input:${type.name}`, type: type.name, schema: type.version, data, actor: { kind: "host" }, cause: null, root: id } as unknown as NewRecord);
      },
    } as unknown as ActionContext;
  };
  const called = (name: string, input: unknown, operation: string): Promise<unknown> =>
    Promise.resolve(found.get(name)?.run(input, context(operation)));
  await run({
    journal,
    write: (rev, items, id) =>
      void journal.append({
        id: recordId(id),
        stream: "input:plan.revised",
        type: PlanRevised.name,
        schema: PlanRevised.version,
        data: { of: "p", rev, items },
        actor: { kind: "host" },
        cause: null,
        root: recordId(id),
      } as unknown as NewRecord),
    set: (operation, input) => called("plan.set", planSet.input.parse(input), operation),
    get: (input) => called("plan.get", planGet.input.parse(input), "op-get"),
    list: (input = {}) => called("plan.list", planList.input.parse(input), "op-list"),
  });
}

test("a set made again finds the revision it wrote, after another writer revised the plan", async () => {
  await withJournal(async (probe) => {
    expect(await probe.set("op-a", { of: "p", items: [build] })).toEqual({ of: "p", rev: 1, revised: true });
    // The call is made again at once: it is the same write, not a set that changes nothing.
    expect(await probe.set("op-a", { of: "p", items: [build] })).toEqual({ of: "p", rev: 1, revised: true });
    expect(await probe.set("op-b", { of: "p", items: [decide] })).toEqual({ of: "p", rev: 2, revised: true });
    // Made again after that, with and without the revision it was based on.
    expect(await probe.set("op-a", { of: "p", items: [build] })).toEqual({ of: "p", rev: 1, revised: true });
    expect(await probe.set("op-a", { of: "p", items: [build], expect: 0 })).toEqual({ of: "p", rev: 1, revised: true });
    expect(probe.journal.rows).toHaveLength(2);
  });
});

test("a revision is read by the number it carries, and the first of a number written twice stands", async () => {
  await withJournal(async (probe) => {
    const write = probe.write;
    write(7, [build], "seven");
    write(7, [decide], "seven-again");
    write(9, [decide], "nine");
    write(8, [build, decide], "eight");

    expect(await probe.get({ of: "p" })).toMatchObject({ rev: 9, items: [decide], revisions: 3 });
    expect(await probe.get({ of: "p", rev: 7 })).toMatchObject({ rev: 7, items: [build] });
    expect(await probe.get({ of: "p", rev: 8 })).toMatchObject({ rev: 8, items: [build, decide] });
    await expect(probe.get({ of: "p", rev: 1 })).rejects.toThrow(/no revision 1/);
    expect(await probe.list()).toEqual({ plans: [{ of: "p", rev: 9, items: 1, open: 1 }] });
    // The next revision follows the highest number, not the last record written.
    expect(await probe.set("op-next", { of: "p", items: [build] })).toEqual({ of: "p", rev: 10, revised: true });
  });
});

test("another plan's records are not read for this one", async () => {
  await withJournal(async (probe) => {
    await probe.set("op-1", { of: "a", items: [build] });
    await probe.set("op-2", { of: "b", items: [decide] });
    expect(await probe.get({ of: "a" })).toMatchObject({ rev: 1, revisions: 1, items: [build] });
    await expect(probe.get({ of: "c" })).rejects.toThrow(/no plan/);
  });
});

test("with no journal to read, the actions say so instead of showing no plans", async () => {
  const found = actionsOf(plan());
  const run = (name: string, input: unknown) => Promise.resolve(found.get(name)?.run(input, { operationId: "op" } as unknown as ActionContext));
  for (const [name, input] of [
    ["plan.list", {}],
    ["plan.get", { of: "p" }],
    ["plan.set", { of: "p", items: [] }],
  ] as const) {
    const error = await run(name, input).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NotSent);
    expect(error).toMatchObject({ message: expect.stringContaining("not serving") });
  }
});

test("two writers of the same expected revision cannot both commit", async () => {
  await withPlans(async niwa => {
    const results = await Promise.allSettled([build, decide].map(item =>
      niwa.call(planSet, { of: "shared", expect: 0, items: [item] })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await niwa.call(planGet, { of: "shared" })).toMatchObject({ rev: 1, revisions: 1 });
  });
});

test("an unchanged plan returns its original revision after another writer revises it", async () => {
  await withJournal(async probe => {
    await probe.set("create", { of: "p", items: [build] });
    const first = await probe.set("equal", { of: "p", items: [build] });
    await probe.set("change", { of: "p", items: [decide] });
    expect(await probe.set("equal", { of: "p", items: [build] })).toEqual(first);
    expect(await probe.get({ of: "p" })).toMatchObject({ rev: 2 });
  });
});
