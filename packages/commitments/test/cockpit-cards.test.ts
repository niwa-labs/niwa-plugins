// The commitment cards: which ring each status is drawn with, and which commitments a card can still cancel.

import { expect, test } from "bun:test";

import { CommitmentStatus } from "../src/cockpit/actions.ts";
import { RING, cancellable } from "../src/cockpit/cards.ts";

test("a commitment can be cancelled until it ends", () => {
  expect(CommitmentStatus.options.filter(cancellable)).toEqual(["proposed", "open", "due"]);
});

test("every status has a ring, and an ended one is not drawn as still going", () => {
  expect(Object.keys(RING).sort()).toEqual([...CommitmentStatus.options].sort());
  expect(RING.kept).toBe("done");
  expect(RING.missed).toBe("failed");
  expect(RING.cancelled).toBe("stopped");
  expect(RING.due).toBe("running");
});
