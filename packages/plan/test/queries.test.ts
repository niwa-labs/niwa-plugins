// The query builder of the plan records: what a script waits for when it waits for a plan to be revised.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import { PlanRevised, planRevised } from "../src/records.ts";

test("the revisions of a plan are a query of their type, filtered on what the plan is of", () => {
  expect(planRevised("task-3fa9c2")).toEqual({ types: [PlanRevised], filter: { of: "task-3fa9c2" } });
  expect(resolveQuery(planRevised("task-3fa9c2")).types?.map(String)).toEqual(["plan.revised"]);
  expect(planRevised("task-3fa9c2", 3).filter).toEqual({ of: "task-3fa9c2", rev: 3 });
});

test("the subject is read as an action reads it, trimmed, and a bad one is refused", () => {
  expect(planRevised("  task-3fa9c2 ").filter).toEqual({ of: "task-3fa9c2" });
  expect(() => planRevised("   ")).toThrow();
  expect(() => planRevised("task-3fa9c2", 0)).toThrow();
});
