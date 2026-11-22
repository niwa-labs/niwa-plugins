// The plan page: how far a plan has come, what a revision changed, and which revision an address asks for.

import { expect, test } from "bun:test";

import type { PlanItem, PlanSummary } from "../src/cockpit/actions.ts";
import { changeText, changesBetween, plansInOrder, progressOf, revisionOf } from "../src/cockpit/revisions.ts";

const item = (id: string, state: PlanItem["state"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text: `do ${id}`, state, ...extra });

test("dropped work is no longer owed, so it leaves the total", () => {
  const progress = progressOf([item("a", "done"), item("b", "planned"), item("c", "dropped"), item("d", "open")]);
  expect(progress).toMatchObject({ done: 1, total: 3, counts: { open: 1, planned: 1, done: 1, dropped: 1 } });
});

test("plans with a decision ahead come first, then by name", () => {
  const plan = (of: string, open: number): PlanSummary => ({ of, rev: 1, items: 3, open });
  expect(plansInOrder([plan("b", 0), plan("z", 2), plan("a", 0), plan("m", 1)]).map((one) => one.of)).toEqual(["m", "z", "a", "b"]);
});

test("a revision shows the items it added, changed and removed, and the ones it left alone", () => {
  const before = [item("a", "open"), item("b", "planned"), item("c", "planned")];
  const after = [item("b", "planned"), item("a", "done", { note: "chose one table" }), item("d", "planned")];
  const changes = changesBetween(before, after);
  expect(changes.map((one) => [one.kind, one.item.id])).toEqual([
    ["same", "b"],
    ["changed", "a"],
    ["added", "d"],
    ["removed", "c"],
  ]);
  const changed = changes[1];
  if (changed?.kind !== "changed") throw new Error("a was not shown as changed");
  expect(changeText(changed)).toBe("Ждёт решения → Выполнен, Заметка обновлена");
});

test("rewording an item is a change, and so is taking its note away", () => {
  const [reworded] = changesBetween([item("a", "planned")], [item("a", "planned", { text: "do a differently" })]);
  if (reworded?.kind !== "changed") throw new Error("a was not shown as changed");
  expect(changeText(reworded)).toBe("Текст обновлён");
  const [unnoted] = changesBetween([item("a", "dropped", { note: "no longer needed" })], [item("a", "dropped")]);
  if (unnoted?.kind !== "changed") throw new Error("a was not shown as changed");
  expect(changeText(unnoted)).toBe("Заметка удалена");
});

test("an address asks for a whole revision the plan has, and anything else is the latest", () => {
  expect(revisionOf("2", 3)).toBe(2);
  expect(revisionOf("3", 3)).toBe(3);
  expect(revisionOf("4", 3)).toBeUndefined();
  expect(revisionOf("0", 3)).toBeUndefined();
  expect(revisionOf("1.5", 3)).toBeUndefined();
  expect(revisionOf("two", 3)).toBeUndefined();
  expect(revisionOf(undefined, 3)).toBeUndefined();
});
