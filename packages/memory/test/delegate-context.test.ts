// Delegate asks a memory for context without importing it: it sends and reads the part of
// memory.context its records describe. That part must stay one the memory takes and answers.

import { expect, test } from "bun:test";
import { ContextAnswer, ContextRequest } from "@niwa-labs/delegate/records";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { memoryContext } from "../src/records.ts";

test("the memory takes the request for context delegate sends", () => {
  expect(unsendable(ContextRequest, memoryContext.input)).toEqual([]);
});

test("delegate reads what the memory answers", () => {
  expect(unreadable(ContextAnswer, memoryContext.output)).toEqual([]);
});
