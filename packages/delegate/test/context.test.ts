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

/** A data owner that holds one note about the owner and one about a project. */
const dataOwner = plugin("memory", (api) => {
  api.action(
    action(memoryContext, {
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (input) => {
        asked.push(input);
        return {
          sources: [{ owner: input.of, ref: "note-1a2b3c", at: input.asOf ?? 7, text: "Reviews are done in the morning.", scope: "work" }],
          withheld: 1,
        };
      },
    }),
  );
});

test("a data owner answers a request for context with sources that name who holds them", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  try {
    niwa.use(dataOwner);
    await niwa.serve();
    const answer = await niwa.call(memoryContext, {
      what: "When does the owner review code?",
      area: "work",
      of: { kind: "agent", id: "rin" },
      for: { kind: "agent", id: "judge" },
      why: "judge a request for the owner",
      asOf: 3,
    });
    expect(answer).toEqual({
      sources: [{ owner: { kind: "agent", id: "rin" }, ref: "note-1a2b3c", at: 3, text: "Reviews are done in the morning.", scope: "work" }],
      withheld: 1,
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
    const bareReader = niwa.call(memoryContext, {
      what: "anything",
      of: { kind: "agent", id: "rin" },
      for: "judge",
      why: "judge",
    } as never);
    await expect(bareReader).rejects.toThrow();
    const noPurpose = niwa.call(memoryContext, { what: "anything", of: { kind: "agent", id: "rin" }, for: { kind: "owner" } } as never);
    await expect(noPurpose).rejects.toThrow();
    expect(asked.length).toBe(before);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
