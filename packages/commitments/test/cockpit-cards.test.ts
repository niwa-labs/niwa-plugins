// The commitment cards: which ring each status is drawn with, and which commitments a card can still cancel.

import { expect, test } from "bun:test";

import { createViewer } from "@niwa-labs/cockpit-sdk";

import { CommitmentStatus } from "../src/cockpit/actions.ts";
import { RING, canCancel, cancellable } from "../src/cockpit/cards.ts";

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

test("a card offers a cancel to the viewer who may call it and could be let", () => {
  const owner = createViewer({ id: "owner", owner: true, actions: ["commitment.cancel"] });
  const agent = createViewer({ id: "session:rin", owner: false, actions: ["commitment.cancel"] });
  const reader = createViewer({ id: "reader", owner: false, actions: ["commitment.list"] });
  expect(canCancel({ canCancel: true }, owner)).toBe(true);
  expect(canCancel({ canCancel: false }, agent)).toBe(false);
  expect(canCancel({ canCancel: true }, agent)).toBe(true);
  expect(canCancel({ canCancel: true }, reader)).toBe(false);
});
