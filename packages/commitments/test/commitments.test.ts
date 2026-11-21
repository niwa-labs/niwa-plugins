// Commitments on a real host: a promise is made, comes due at its deadline into an agent's inbox,
// and is done, missed or cancelled. A promise for the owner stands only on his own word.

import { afterEach, expect, test } from "bun:test";

import { action, actionRef, grant, principalOf, record } from "@niwa-labs/core";
import type { Address, Caller, StoredRecord } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import { plugin } from "@niwa-labs/plugin";
import { agentNotify } from "@niwa-labs/agent/records";
import { requestAnswer, requestAsk } from "@niwa-labs/requests/records";
import { baseStack, connect, connectAsOwner, createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import type { NiwaApi, TestClock } from "@niwa-labs/testing";
import { z } from "zod";

import { commitments } from "../src/index.ts";
import {
  commitmentBriefing,
  commitmentCancel,
  commitmentDone,
  commitmentGet,
  commitmentList,
  commitmentMake,
} from "../src/records.ts";

const START = 1_700_000_000_000;
const HOUR = 3_600_000;
const GRACE = 2 * HOUR;

/** What the stub of the agents plugin was told: the agent and the text of each fact. */
type Told = { agent: string; text: string };

/** The agents plugin, as far as commitments use it: a fact told to an agent lands in its inbox. */
function agentsStub(told: Told[]) {
  return plugin("agents", (api) => {
    api.action(
      action(agentNotify, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input) => {
          told.push({ agent: input.agent, text: input.text });
          return { turn: `fact-${(told.length + 0xa00000).toString(16)}` };
        },
      }),
    );
  });
}

/** A record the owner writes himself: a sentence of his, as a message would be. */
const Said = record("test.said", z.object({ text: z.string() }));
const say = actionRef("test.say", { description: "Write a sentence.", input: z.object({ text: z.string() }), output: z.object({ record: z.string() }) });
const words = plugin("words", (api) => {
  api.declare(Said);
  api.action(
    action(say, {
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => ({ record: String((await ctx.emit(Said, input)).id) }),
    }),
  );
});

/** The owner is the owner; a session `rin` speaks as the agent `rin`. */
function bind(caller: Caller): Address | undefined {
  if (caller.kind !== "client") return undefined;
  if (caller.principal?.kind === "owner") return { kind: "owner" };
  if (caller.principal?.kind === "session") return { kind: "agent", id: String(caller.principal.id) };
  return { kind: "client", id: caller.id };
}

interface World {
  readonly host: ReturnType<typeof createNiwa>;
  readonly clock: TestClock;
  readonly told: Told[];
  readonly owner: NiwaApi;
  readonly rin: NiwaApi;
  readonly records: (type: string) => Promise<StoredRecord[]>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(extra: readonly Plugin[] = []): Promise<World> {
  const home = await tempHome();
  const clock = testClock(START);
  const host = createNiwa({ home: home.path, clock });
  const told: Told[] = [];
  cleanups.push(() => home.cleanup());
  cleanups.push(() => host.close());
  host.use(...baseStack().plugins, ...extra, agentsStub(told), words, commitments({ messages: { bind }, graceMs: GRACE }));
  await host.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const token = host.issueToken(principalOf("session", "rin"), { grant: grant(["commitment.*", "test.say"]) });
  const rin = await connect({ home: home.path, id: "session:rin", token });
  cleanups.push(() => rin.close());
  const records = async (type: string) => (await host.records.read()).filter((row) => row.type === type);
  return { host, clock, told, owner, rin, records };
}

test("an agent's own promise comes due into its inbox, and is missed when not done after the grace", async () => {
  const w = await world();
  const made = await w.rin.call(commitmentMake, { text: "Check the nightly build", to: "rin", due: START + HOUR });
  expect(made.status).toBe("open");
  const card = await w.owner.call(commitmentGet, { id: made.id });
  expect(card).toMatchObject({ status: "open", party: "self", by: { kind: "agent", id: "rin" }, basis: { kind: "own" } });

  await w.clock.advance(HOUR);
  await eventually(async () => (await w.records("commitment.delivered")).length === 1);
  expect(w.told).toEqual([{ agent: "rin", text: expect.stringContaining("Check the nightly build") }]);
  expect((await w.owner.call(commitmentGet, { id: made.id })).status).toBe("due");

  await w.clock.advance(GRACE);
  await eventually(async () => (await w.records("commitment.missed")).length === 1);
  expect((await w.owner.call(commitmentGet, { id: made.id })).status).toBe("missed");
  expect(w.told).toHaveLength(2);
  expect(w.told[1]?.text).toContain("missed");
});

test("a promise done before its deadline is not delivered", async () => {
  const w = await world();
  const made = await w.rin.call(commitmentMake, { text: "Send the summary", to: "rin", due: START + HOUR });
  expect(await w.rin.call(commitmentDone, { id: made.id, note: "sent" })).toEqual({ id: made.id, status: "kept" });
  await w.clock.advance(HOUR + GRACE);
  await eventually(async () => (await w.host.records.read()).filter((row) => row.type === "timer.slept").length >= 1);
  // The wake came and found the promise kept: nothing reaches the inbox.
  await Bun.sleep(50);
  expect(await w.records("commitment.delivered")).toHaveLength(0);
  expect(await w.records("commitment.missed")).toHaveLength(0);
  expect(w.told).toEqual([]);
});

test("an agent's promise for the owner without his word is only proposed, and stands once he confirms", async () => {
  const w = await world();
  const proposed = await w.rin.call(commitmentMake, { text: "Reply to the landlord", to: "rin", party: "owner", due: START + 24 * HOUR });
  expect(proposed.status).toBe("proposed");
  expect(await w.records("commitment.made")).toHaveLength(0);

  await eventually(async () => (await w.records("request.created")).length === 1);
  const [asked] = await w.records("request.created");
  const request = asked?.data as { id: string; to: Address; question: string; input: { kind: string; title: string } };
  expect(request.to).toEqual({ kind: "owner" });
  expect(request.question).toBe("commitment.confirm");
  expect(request.input.kind).toBe("confirm");
  expect(request.input.title).toContain("Reply to the landlord");

  await w.owner.call(requestAnswer, { id: request.id, answer: { ids: ["yes"] } });
  await eventually(async () => (await w.records("commitment.made")).length === 1);
  const card = await w.owner.call(commitmentGet, { id: proposed.id });
  expect(card).toMatchObject({ status: "open", party: "owner", basis: { kind: "owner-confirmed", request: request.id } });
});

test("a proposed promise the owner does not confirm is declined and never comes due", async () => {
  const w = await world();
  const proposed = await w.rin.call(commitmentMake, { text: "Pay the bill", to: "rin", party: "owner", due: START + HOUR });
  await eventually(async () => (await w.records("request.created")).length === 1);
  const id = ((await w.records("request.created"))[0]?.data as { id: string }).id;
  await w.owner.call(requestAnswer, { id, answer: { ids: ["no"] } });
  await eventually(async () => (await w.records("commitment.declined")).length === 1);
  expect((await w.owner.call(commitmentGet, { id: proposed.id })).status).toBe("declined");
  await w.clock.advance(HOUR + GRACE);
  await Bun.sleep(50);
  expect(await w.records("commitment.made")).toHaveLength(0);
  expect(w.told).toEqual([]);
});

test("the proposals wait for the owner side by side", async () => {
  const w = await world();
  const first = await w.rin.call(commitmentMake, { text: "Book the flight", to: "rin", party: "owner" });
  const second = await w.rin.call(commitmentMake, { text: "Renew the passport", to: "rin", party: "owner" });
  await eventually(async () => (await w.records("request.created")).length === 2);
  const asked = (await w.records("request.created")).map((row) => row.data as { id: string; input: { title: string } });
  const renew = asked.find((one) => one.input.title.includes("passport"));
  await w.owner.call(requestAnswer, { id: renew?.id ?? "", answer: { ids: ["yes"] } });
  await eventually(async () => (await w.records("commitment.made")).length === 1);
  expect((await w.owner.call(commitmentGet, { id: second.id })).status).toBe("open");
  expect((await w.owner.call(commitmentGet, { id: first.id })).status).toBe("proposed");
});

test("a promise for the owner stands on a record of his words, and not on someone else's", async () => {
  const w = await world();
  const his = await w.owner.call(say, { text: "Remind me to call mum on Sunday" });
  const made = await w.rin.call(commitmentMake, {
    text: "Call mum",
    to: "rin",
    party: "owner",
    due: START + 48 * HOUR,
    basis: { kind: "owner-words", record: his.record },
  });
  expect(made.status).toBe("open");
  expect(await w.owner.call(commitmentGet, { id: made.id })).toMatchObject({ basis: { kind: "owner-words", record: his.record } });

  const hers = await w.rin.call(say, { text: "Remind me to sell the car" });
  const forged = w.rin.call(commitmentMake, {
    text: "Sell the car",
    to: "rin",
    party: "owner",
    basis: { kind: "owner-words", record: hers.record },
  });
  await expect(forged).rejects.toThrow(/owner/);
  const missing = w.rin.call(commitmentMake, { text: "Sell the car", to: "rin", party: "owner", basis: { kind: "owner-words", record: "nowhere" } });
  await expect(missing).rejects.toThrow(/owner/);
  expect(await w.records("commitment.made")).toHaveLength(1);
});

test("the owner's own promise stands at once", async () => {
  const w = await world();
  const made = await w.owner.call(commitmentMake, { text: "File the taxes", to: "rin", party: "owner", due: START + HOUR });
  expect(made.status).toBe("open");
  expect(await w.owner.call(commitmentGet, { id: made.id })).toMatchObject({ by: { kind: "owner" }, basis: { kind: "owner" } });
});

test("a promise is made by an address: a caller that speaks as none is refused", async () => {
  const w = await world();
  await expect(w.host.call(commitmentMake, { text: "Anything", to: "rin" })).rejects.toThrow(/address/);
});

test("an agent cancels its own promise, not one made for the owner; the owner cancels any", async () => {
  const w = await world();
  const own = await w.rin.call(commitmentMake, { text: "Tidy the notes", to: "rin", due: START + HOUR });
  const his = await w.owner.call(commitmentMake, { text: "Renew the lease", to: "rin", party: "owner", due: START + HOUR });

  expect(await w.rin.call(commitmentCancel, { id: own.id, reason: "not needed" })).toEqual({ id: own.id, status: "cancelled" });
  await expect(w.rin.call(commitmentCancel, { id: his.id })).rejects.toThrow(/owner/);
  expect(await w.owner.call(commitmentCancel, { id: his.id })).toEqual({ id: his.id, status: "cancelled" });
  await expect(w.owner.call(commitmentCancel, { id: his.id })).rejects.toThrow(/cancelled/);
  await expect(w.rin.call(commitmentDone, { id: his.id })).rejects.toThrow(/cancelled/);

  await w.clock.advance(HOUR + GRACE);
  await Bun.sleep(50);
  expect(w.told).toEqual([]);
});

test("cancelling a proposal withdraws the question put to the owner", async () => {
  const w = await world();
  const proposed = await w.rin.call(commitmentMake, { text: "Call the bank", to: "rin", party: "owner" });
  await eventually(async () => (await w.records("request.created")).length === 1);
  await w.rin.call(commitmentCancel, { id: proposed.id });
  await eventually(async () => (await w.records("request.cancelled")).length === 1);
  const id = ((await w.records("request.created"))[0]?.data as { id: string }).id;
  expect((await w.records("request.cancelled"))[0]?.data).toMatchObject({ id });
  expect((await w.owner.call(commitmentGet, { id: proposed.id })).status).toBe("cancelled");
});

test("a question asked after its proposal was cancelled is withdrawn at once", async () => {
  // The ask is held until the proposal is cancelled, so the question is created after the cancel.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asking = false;
  const hold = plugin("hold", (api) => {
    api.adjust(requestAsk, async (input) => {
      asking = true;
      await held;
      return input;
    });
  });
  const w = await world([hold]);
  const proposed = await w.rin.call(commitmentMake, { text: "Call the plumber", to: "rin", party: "owner" });
  await eventually(() => asking);
  await w.rin.call(commitmentCancel, { id: proposed.id });
  release();
  await eventually(async () => (await w.records("request.cancelled")).length === 1);
  const id = ((await w.records("request.created"))[0]?.data as { id: string }).id;
  expect((await w.records("request.cancelled"))[0]?.data).toMatchObject({ id });
  expect(await w.records("commitment.made")).toHaveLength(0);
});

test("only the one who made a promise, or the owner, says it is done", async () => {
  const w = await world();
  const his = await w.owner.call(commitmentMake, { text: "Water the plants", to: "rin" });
  await expect(w.rin.call(commitmentDone, { id: his.id })).rejects.toThrow(/owner/);
  expect(await w.owner.call(commitmentDone, { id: his.id })).toEqual({ id: his.id, status: "kept" });
});

test("the list and the briefing show where each promise stands", async () => {
  const w = await world();
  const late = await w.rin.call(commitmentMake, { text: "Write the report", to: "rin", due: START + 3 * HOUR });
  const kept = await w.rin.call(commitmentMake, { text: "Fix the typo", to: "rin" });
  await w.rin.call(commitmentDone, { id: kept.id });
  await w.rin.call(commitmentMake, { text: "Ask the owner about Friday", to: "rin", party: "owner" });

  const all = await w.owner.call(commitmentList, {});
  expect(all.items.map((item) => [item.description, item.status])).toEqual([
    ["Write the report", "open"],
    ["Fix the typo", "kept"],
    ["Ask the owner about Friday", "proposed"],
  ]);
  expect((await w.owner.call(commitmentList, { status: "open" })).items.map((item) => item.id)).toEqual([late.id]);

  const briefing = await w.owner.call(commitmentBriefing, { agent: "rin" });
  expect(briefing.text).toContain("Write the report");
  expect(briefing.text).toContain("Ask the owner about Friday");
  expect(briefing.text).not.toContain("Fix the typo");
  expect((await w.owner.call(commitmentBriefing, { agent: "someone-else" })).text).toBe("");
});
