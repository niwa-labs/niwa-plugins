// The copy of the forge actions the cockpit module keeps reads what the host answers and sends what it takes,
// and the merge it shows can be called off with what the host gave.

import { afterEach, expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { forgePrList, forgePrMerge, forgePrMergeCancel, forgePrMergePending, forgeRepoList, forgeRepoSync, forgeRepoWatch } from "../src/index.ts";
import { cancelMergeAction, pendingAction, prListAction, repoListAction, repoSyncAction } from "../src/cockpit/actions.ts";
import { cancelInput } from "../src/cockpit/pulls.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

test.each([
  ["forge.repo.list", repoListAction, forgeRepoList],
  ["forge.repo.sync", repoSyncAction, forgeRepoSync],
  ["forge.pr.list", prListAction, forgePrList],
  ["forge.pr.merge.pending", pendingAction, forgePrMergePending],
  ["forge.pr.merge.cancel", cancelMergeAction, forgePrMergeCancel],
] as const)("%s is sent as the host takes it and its answer is read", (name, copy, real) => {
  expect(String(copy.name)).toBe(name);
  expect(String(real.name)).toBe(name);
  expect(unsendable(copy.input, real.input)).toEqual([]);
  expect(unreadable(copy.output, real.output)).toEqual([]);
});

test("the plugin offers its page to the cockpit", async () => {
  const host = await forgeHost();
  hosts.push(host);
  const catalog = (await host.niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; plugin: string }> };
  expect(catalog.modules).toContainEqual(expect.objectContaining({ id: "forge", plugin: "forge" }));
});

test("an armed merge is called off with the input the host gave with it", async () => {
  const host = await forgeHost();
  hosts.push(host);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  openMr(host);
  await host.niwa.call(forgePrMerge, { repo: BILLING, number: 7, expectHead: sha("topic-1"), method: "merge", when: "pipeline" });
  const [armed] = (await host.niwa.call(forgePrMergePending, {})).items;
  if (armed === undefined) throw new Error("the merge was not armed");

  const input = cancelInput(armed);
  expect(input).toEqual({ repo: BILLING, number: 7 });
  // What the page sends is what the host's own schema takes, the nested repository included.
  expect(forgePrMergeCancel.input.safeParse(input).success).toBe(true);
  expect(await host.niwa.call(forgePrMergeCancel, input!)).toEqual({ cancelled: true });
  expect((await host.niwa.call(forgePrMergePending, {})).items).toEqual([]);
});
