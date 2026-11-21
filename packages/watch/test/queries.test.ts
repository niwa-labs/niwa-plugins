// The query builders of the watch records: what a script waits for when it watches a subject.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";

import { WatchRecovered, WatchStuck, sessionSubject, watchRecovered, watchStuck } from "../src/records.ts";

const me = sessionSubject("claude", "abc");

test("the stuck and recovered records of a subject are queries of their type, filtered on it", () => {
  expect(watchStuck(me)).toEqual({ types: [WatchStuck], filter: { subject: me } });
  expect(watchRecovered(me)).toEqual({ types: [WatchRecovered], filter: { subject: me } });
  expect(resolveQuery(watchStuck(me)).types?.map(String)).toEqual(["watch.stuck"]);
});

test("a condition narrows the query, and the filter paths are fields of the record", () => {
  expect(watchStuck(me, "looping").filter).toEqual({ subject: me, kind: "looping" });
  expect(watchRecovered(me, "silent").filter).toEqual({ subject: me, kind: "silent" });
  const data = WatchStuck.schema.parse({ subject: me, since: 1, last: 0, kind: "looping" });
  for (const [path, value] of Object.entries(watchStuck(me, "looping").filter ?? {})) expect((data as Record<string, unknown>)[path]).toBe(value);
});

test("a text that is not a subject, or a condition, is refused when the query is made", () => {
  expect(() => watchStuck("claude abc")).toThrow();
  expect(() => watchStuck(me, "tired" as never)).toThrow();
});
