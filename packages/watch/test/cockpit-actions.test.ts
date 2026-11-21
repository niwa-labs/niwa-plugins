// The copy of the watch actions the cockpit module keeps reads what the host answers, and the host lists the module.

import { expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { createNiwa, tempHome, unreadable, unsendable } from "@niwa-labs/testing";

import { watch } from "../src/index.ts";
import { watchList } from "../src/records.ts";
import { listAction } from "../src/cockpit/actions.ts";

test("the subjects are read from what the host answers", () => {
  expect(String(listAction.name)).toBe(String(watchList.name));
  expect(unsendable(listAction.input, watchList.input)).toEqual([]);
  expect(unreadable(listAction.output, watchList.output)).toEqual([]);
});

test("the plugin offers its page to the cockpit", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(watch());
    await niwa.serve();
    const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; plugin: string }> };
    expect(catalog.modules).toContainEqual(expect.objectContaining({ id: "watch", plugin: "watch" }));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
