// The query builder of the evidence records: what a script waits for when it waits for an attestation.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import { Attested, attested } from "../src/records.ts";

const subject = "gitlab.example.com/acme/billing/pr/7";

test("the attestations about a subject are a query of their type, filtered on the subject", () => {
  expect(attested(subject)).toEqual({ types: [Attested], filter: { subject } });
  expect(resolveQuery(attested(subject)).types?.map(String)).toEqual(["evidence.attested"]);
});

test("a subject that is empty is refused when the query is made", () => {
  expect(() => attested("")).toThrow();
});
