// The request for context is a contract between delegate and a data owner it does not import: the
// owner serves it under its own name, and both sides are held to the same schemas.

import { expect, test } from "bun:test";

import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { createNiwa, tempHome } from "@niwa-labs/testing";

import { contextSource } from "../src/records.ts";
import type { ContextRequest } from "../src/records.ts";

const memoryContext = contextSource("memory.context");

const asked: ContextRequest[] = [];

/** A data owner with one conclusion to tell and one note it keeps back. */
const dataOwner = plugin("memory", (api) => {
  api.action(
    action(memoryContext, {
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (input) => {
        asked.push(input);
        const at = input.at ?? 7;
        return {
          at,
          items: [{ text: "Reviews are done in the morning.", source: { owner: { kind: "agent" as const, id: input.memory }, note: "note-1a2b3c4d", seq: at } }],
          withheld: [{ note: "note-9f8e7d6c" }],
        };
      },
    }),
  );
});

test("a data owner answers a request for context with conclusions that name who holds them", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(dataOwner);
    await niwa.serve();
    const answer = await niwa.call(memoryContext, {
      memory: "rin",
      query: "When does the owner review code?",
      purpose: "judge a request for the owner",
      for: { kind: "agent", id: "judge" },
      at: 3,
    });
    expect(answer).toEqual({
      at: 3,
      items: [{ text: "Reviews are done in the morning.", source: { owner: { kind: "agent", id: "rin" }, note: "note-1a2b3c4d", seq: 3 } }],
      withheld: [{ note: "note-9f8e7d6c" }],
    });
    expect(asked.at(-1)?.for).toEqual({ kind: "agent", id: "judge" });
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});

test("a request for context names its reader by address and says why", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(dataOwner);
    await niwa.serve();
    const before = asked.length;
    const bareReader = niwa.call(memoryContext, { memory: "rin", query: "anything", purpose: "judge", for: "judge" } as never);
    await expect(bareReader).rejects.toThrow();
    const noPurpose = niwa.call(memoryContext, { memory: "rin", query: "anything", for: { kind: "owner" } } as never);
    await expect(noPurpose).rejects.toThrow();
    expect(asked.length).toBe(before);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
