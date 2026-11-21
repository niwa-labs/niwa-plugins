// The copy of the actions the memory page keeps reads what the host answers, the host lists the module, and a share
// question the memory asked is found among what waits for the owner.

import { afterEach, expect, test } from "bun:test";
import { actionName } from "@niwa-labs/core";
import { agentList } from "@niwa-labs/agent/records";
import { requestOpen } from "@niwa-labs/requests/records";
import { unreadable, unsendable } from "@niwa-labs/testing";

import { memoryGet, memoryList, memoryPageGet, memoryPageList } from "../src/records.ts";
import { agentListAction, noteGetAction, noteListAction, openAction, pageGetAction, pageListAction } from "../src/cockpit/actions.ts";
import { shareQuestions } from "../src/cockpit/notes.ts";
import { bob, closeAll, memoryHost, owner, rin, until } from "./fixtures/host.ts";

afterEach(closeAll);

test.each([
  ["agent.list", agentListAction, agentList],
  ["memory.list", noteListAction, memoryList],
  ["memory.get", noteGetAction, memoryGet],
  ["memory.page.list", pageListAction, memoryPageList],
  ["memory.page.get", pageGetAction, memoryPageGet],
  ["request.open", openAction, requestOpen],
] as const)("%s is sent as the host takes it and its answer is read", (name, copy, real) => {
  expect(String(copy.name)).toBe(name);
  expect(String(real.name)).toBe(name);
  expect(unsendable(copy.input, real.input)).toEqual([]);
  expect(unreadable(copy.output, real.output)).toEqual([]);
});

test("the plugin offers its page to the cockpit", async () => {
  const host = await memoryHost();
  const catalog = (await host.host.call(actionName("niwa.cockpit.catalog"), {})) as { modules: Array<{ id: string; plugin: string }> };
  expect(catalog.modules).toContainEqual(expect.objectContaining({ id: "memory", plugin: "memory" }));
});

test("a note about the owner that another agent wanted is a question waiting for him, found for the memory that asked", async () => {
  const host = await memoryHost({}, { agents: [{ name: "rin", harness: "h", prompt: "p" }, { name: "bob", harness: "h", prompt: "p" }] });
  const note = await host.as<{ note: string }>(rin, "memory.note", { text: "He is on leave in May.", about: "owner", source: { kind: "session", session: "claude s-1", upto: "l-3" } });
  await host.as(bob, "memory.context", { memory: "rin", query: "leave May", purpose: "to plan the week" });
  await until(host, "request.created");

  const { requests } = await host.as<{ requests: Parameters<typeof shareQuestions>[0] }>(owner, "request.open", {});
  const found = shareQuestions(requests, "rin");
  expect(found).toHaveLength(1);
  expect(found[0]?.title).toBe("May agent bob be told what agent rin remembers about you?");
  // What waits for him names the note; its text is read when it is shown, not kept in the question.
  expect(found[0]?.detail).not.toContain("He is on leave in May.");
  expect(found[0]?.reference).toEqual({ memory: "rin", note: note.note, revision: 1 });
  expect(found[0]?.purpose).toBe("to plan the week");
  expect(note.note).toMatch(/^note-/);
  expect(shareQuestions(requests, "bob")).toEqual([]);
});
