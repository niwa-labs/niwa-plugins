// The copy of the plan actions the cockpit module keeps reads what the host answers, and the host lists the module.

import { expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { createNiwa, tempHome, unreadable, unsendable } from "@niwa-labs/testing";

import { plan } from "../src/index.ts";
import { planGet, planList } from "../src/records.ts";
import { getAction, listAction } from "../src/cockpit/actions.ts";

test.each([
  ["plan.list", listAction, planList],
  ["plan.get", getAction, planGet],
] as const)("%s is sent as the host takes it and its answer is read", (name, copy, real) => {
  expect(String(copy.name)).toBe(name);
  expect(String(real.name)).toBe(name);
  expect(unsendable(copy.input, real.input)).toEqual([]);
  expect(unreadable(copy.output, real.output)).toEqual([]);
});

test("the plugin offers its page to the cockpit", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(plan());
    await niwa.serve();
    const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; plugin: string }> };
    expect(catalog.modules).toContainEqual(expect.objectContaining({ id: "plan", plugin: "plan" }));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
