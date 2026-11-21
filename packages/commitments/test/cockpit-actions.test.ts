// The copy of the commitment actions the cockpit module keeps reads what the host answers and sends what it takes.

import { expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { baseStack, createNiwa, tempHome, unreadable, unsendable } from "@niwa-labs/testing";

import { commitments } from "../src/index.ts";
import { commitmentCancel, commitmentList } from "../src/records.ts";
import { cancelAction, listAction } from "../src/cockpit/actions.ts";

test("the cards are read from what the host answers", () => {
  expect(String(listAction.name)).toBe(String(commitmentList.name));
  expect(unsendable(listAction.input, commitmentList.input)).toEqual([]);
  expect(unreadable(listAction.output, commitmentList.output)).toEqual([]);
});

test("a card's cancel sends what the host takes", () => {
  expect(String(cancelAction.name)).toBe(String(commitmentCancel.name));
  expect(unsendable(cancelAction.input, commitmentCancel.input)).toEqual([]);
  expect(unreadable(cancelAction.output, commitmentCancel.output)).toEqual([]);
});

test("the plugin offers its cards to the cockpit", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    // Commitments deliver through the agents plugin and wait on the timers: a host that has them.
    niwa.use(...baseStack().plugins, plugin("agents", () => {}), commitments());
    await niwa.serve();
    const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; package: string }> };
    expect(catalog.modules.map((one) => one.id)).toContain("commitments");
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
