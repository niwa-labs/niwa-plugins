// The copy of the evidence actions the cockpit module keeps reads what the host answers, and the host lists the module.

import { expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { createNiwa, tempHome, unreadable, unsendable } from "@niwa-labs/testing";

import { evidence } from "../src/index.ts";
import { Attestation, Claim, evidenceCovers, evidenceList } from "../src/records.ts";
import { Attestation as AttestationCopy, Claim as ClaimCopy, coversAction, listAction } from "../src/cockpit/actions.ts";

test.each([
  ["evidence.list", listAction, evidenceList],
  ["evidence.covers", coversAction, evidenceCovers],
] as const)("%s is sent as the host takes it and its answer is read", (name, copy, real) => {
  expect(String(copy.name)).toBe(name);
  expect(String(real.name)).toBe(name);
  expect(unsendable(copy.input, real.input)).toEqual([]);
  expect(unreadable(copy.output, real.output)).toEqual([]);
});

test("a claim and an attestation of the host are read whole", () => {
  expect(unreadable(ClaimCopy, Claim)).toEqual([]);
  expect(unreadable(AttestationCopy, Attestation)).toEqual([]);
});

test("the plugin offers its page to the cockpit", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(evidence());
    await niwa.serve();
    const catalog = (await niwa.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; plugin: string }> };
    expect(catalog.modules).toContainEqual(expect.objectContaining({ id: "evidence", plugin: "evidence" }));
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
