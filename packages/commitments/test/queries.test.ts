// The query builders of the commitment records: what a script waits for when it waits for one promise.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import {
  CommitmentCancelled,
  CommitmentId,
  CommitmentDeclined,
  CommitmentDelivered,
  CommitmentKept,
  CommitmentMade,
  CommitmentMissed,
  CommitmentProposed,
  commitmentCancelled,
  commitmentDeclined,
  commitmentDelivered,
  commitmentKept,
  commitmentMade,
  commitmentMissed,
  commitmentProposed,
} from "../src/records.ts";

const id = CommitmentId.parse("com-3fa9c2");

test("each record of a commitment is a query of its type, filtered on the commitment", () => {
  expect(commitmentMade(id)).toEqual({ types: [CommitmentMade], filter: { id } });
  expect(commitmentProposed(id)).toEqual({ types: [CommitmentProposed], filter: { id } });
  expect(commitmentDeclined(id)).toEqual({ types: [CommitmentDeclined], filter: { id } });
  expect(commitmentDelivered(id)).toEqual({ types: [CommitmentDelivered], filter: { id } });
  expect(commitmentKept(id)).toEqual({ types: [CommitmentKept], filter: { id } });
  expect(commitmentMissed(id)).toEqual({ types: [CommitmentMissed], filter: { id } });
  expect(commitmentCancelled(id)).toEqual({ types: [CommitmentCancelled], filter: { id } });
  expect(resolveQuery(commitmentKept(id)).types?.map(String)).toEqual(["commitment.kept"]);
});

test("a text that is not the id of a commitment is refused when the query is made", () => {
  expect(() => commitmentKept("task-3fa9c2")).toThrow();
  expect(() => commitmentMissed("")).toThrow();
});
