// Commitments on a real host: a promise is made, comes due at its deadline into an agent's inbox,
// and is done, missed or cancelled. A promise for the owner stands only on his own word.

import { afterEach, expect, test } from "bun:test";

import { action, actionRef, grant, principalOf, record } from "@niwa-labs/core";
import type { Address, Caller, StoredRecord } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import { plugin } from "@niwa-labs/plugin";
import { agentNotify } from "@niwa-labs/agent/records";
import { requestAnswer, requestAsk, requestResolve } from "@niwa-labs/requests/records";
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
          if (input.agent === "ghost") throw new Error("no agent is called ghost");
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
/** A turn some plugin says the owner wrote, as the agents plugin does for his messages. */
const Turn = record("test.turn", z.object({ author: z.object({ kind: z.string() }).loose(), text: z.string() }));
/** A record of the owner's that says nothing in words. */
const Nod = record("test.nod", z.object({}));
const nod = actionRef("test.nod", { description: "Nod.", input: z.object({}), output: z.object({ record: z.string() }) });
const words = plugin("words", (api) => {
  api.declare(Said, Turn, Nod);
  api.action(action(nod, { recovery: "repeat", effect: "record", world: "niwa", run: async (_input, ctx) => ({ record: String((await ctx.emit(Nod, {})).id) }) }));
  api.action(
    action(say, {
      recovery: "repeat",
      effect: "record",
      world: "niwa",
      run: async (input, ctx) => ({ record: String((await ctx.emit(Said, input)).id) }),
    }),
  );
});

/** The messages module's own actions, as far as a test sends a message through them. */
const Place = z.object({ kind: z.string(), id: z.string().optional() }).loose();
const letter = { to: Place, from: Place.optional(), body: z.object({ type: z.literal("update"), text: z.string() }) };
const messageSendRef = actionRef("message.send", { description: "Send a message.", input: z.object(letter), output: z.object({}).loose() });
const messageReceiveRef = actionRef("message.receive", { description: "Receive a message.", input: z.object(letter), output: z.object({}).loose() });

/** The owner is the owner; a session `rin` speaks as the agent `rin`. */
function bind(caller: Caller): Address | undefined {
  if (caller.kind !== "client") return undefined;
  if (caller.principal?.kind === "owner") return { kind: "owner" };
  // Built id first: an address is the same address whatever order its keys come in.
  if (caller.principal?.kind === "session") return { id: String(caller.principal.id), kind: "agent" };
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
  const token = host.issueToken(principalOf("session", "rin"), { grant: grant(["commitment.*", "test.say", "emit:test.turn", "message.send"]) });
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

test("his words stand for the promise as he worded it, not for terms an agent made of them", async () => {
  const w = await world();
  const his = await w.owner.call(say, { text: "I will check the report." });
  const basis = { kind: "owner-words" as const, record: his.record };
  // A deadline cannot be read out of words: the one an agent chose is put to him.
  const dated = await w.rin.call(commitmentMake, { text: "Check the report", to: "rin", party: "owner", due: START + 6 * HOUR, basis });
  expect(dated.status).toBe("proposed");
  // Nor is a promise he did not word: it is put to him as it now reads.
  const reworded = await w.rin.call(commitmentMake, { text: "Finish the report today", to: "rin", party: "owner", basis });
  expect(reworded.status).toBe("proposed");
  expect(await w.records("commitment.made")).toHaveLength(0);
  await eventually(async () => (await w.records("request.created")).length === 2);
  // What he worded, as he worded it, stands at once.
  const quoted = await w.rin.call(commitmentMake, { text: "check the REPORT", to: "rin", party: "owner", basis });
  expect(quoted.status).toBe("open");
  expect(await w.owner.call(commitmentGet, { id: dated.id })).toMatchObject({ status: "proposed" });
});

test("a record counts as the owner's words only when he wrote it, or a plugin says he did, and it has words", async () => {
  const w = await world();
  const relayed = await w.host.emit(Turn, { author: { kind: "owner" }, text: "Remind me to renew the domain" });
  const made = await w.rin.call(commitmentMake, { text: "Renew the domain", to: "rin", party: "owner", basis: { kind: "owner-words", record: String(relayed.id) } });
  expect(made.status).toBe("open");

  // A client that may write the record itself is its author, whatever the record says.
  const claimed = await w.rin.emit(Turn, { author: { kind: "owner" }, text: "Remind me to buy a boat" });
  const forged = w.rin.call(commitmentMake, { text: "Buy a boat", to: "rin", party: "owner", basis: { kind: "owner-words", record: String(claimed.id) } });
  await expect(forged).rejects.toThrow(/owner/);

  const nodded = await w.owner.call(nod, {});
  const wordless = w.rin.call(commitmentMake, { text: "Sell the boat", to: "rin", party: "owner", basis: { kind: "owner-words", record: nodded.record } });
  await expect(wordless).rejects.toThrow(/owner/);
  expect(await w.records("commitment.made")).toHaveLength(1);
});

test("a delivery that fails holds up no other commitment", async () => {
  const w = await world();
  const lost = await w.rin.call(commitmentMake, { text: "Tell the ghost", to: "ghost", due: START + HOUR });
  const mine = await w.rin.call(commitmentMake, { text: "Check the backups", to: "rin", due: START + 2 * HOUR });
  await w.clock.advance(2 * HOUR);
  await eventually(async () => (await w.owner.call(commitmentGet, { id: mine.id })).status === "due");
  expect(w.told).toEqual([{ agent: "rin", text: expect.stringContaining("Check the backups") }]);
  await w.clock.advance(GRACE);
  await eventually(async () => (await w.owner.call(commitmentGet, { id: mine.id })).status === "missed");
  // The one whose inbox could not be reached was never delivered, and still comes to its end.
  expect((await w.owner.call(commitmentGet, { id: lost.id })).status).toBe("missed");
  expect((await w.records("commitment.delivered")).map((row) => (row.data as { id: string }).id)).toEqual([mine.id]);
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
  // The author took it back: the owner did not refuse it.
  await Bun.sleep(50);
  expect(await w.records("commitment.declined")).toHaveLength(0);
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
  expect(all.items.map((item): string[] => [item.description, item.status])).toEqual([
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

test("an answer a resolver found for the owner confirms nothing", async () => {
  const w = await world();
  const proposed = await w.rin.call(commitmentMake, { text: "Wire the deposit", to: "rin", party: "owner", due: START + HOUR });
  await eventually(async () => (await w.records("request.created")).length === 1);
  const id = ((await w.records("request.created"))[0]?.data as { id: string }).id;
  await w.host.call(requestResolve, { id, answer: { ids: ["yes"] }, info: { how: "recalled" } });
  await eventually(async () => (await w.records("commitment.declined")).length === 1);
  expect(await w.records("commitment.made")).toHaveLength(0);
  expect((await w.owner.call(commitmentGet, { id: proposed.id })).status).toBe("declined");
  await w.clock.advance(HOUR + GRACE);
  await Bun.sleep(50);
  expect(w.told).toEqual([]);
});

test("a message he wrote is his words, whether it was sent by him or came in as his", async () => {
  const w = await world();
  const to = { kind: "agent", id: "rin" } as const;
  await w.owner.call(messageSendRef, { to, body: { type: "update", text: "Please renew the lease." } });
  await w.host.call(messageReceiveRef, { from: { kind: "owner" }, to, body: { type: "update", text: "Also ring the plumber" } });
  const [sent] = await w.records("message.sent");
  const [received] = await w.records("message.received");
  expect(sent).toBeDefined();
  expect(received).toBeDefined();
  const lease = await w.rin.call(commitmentMake, { text: "renew the lease", to: "rin", party: "owner", basis: { kind: "owner-words", record: String(sent?.id) } });
  const plumber = await w.rin.call(commitmentMake, { text: "ring the plumber", to: "rin", party: "owner", basis: { kind: "owner-words", record: String(received?.id) } });
  expect([lease.status, plumber.status]).toEqual(["open", "open"]);

  // A message an agent sent is the agent's word, to whoever it is addressed.
  await w.rin.call(messageSendRef, { to: { kind: "owner" }, body: { type: "update", text: "Remind me to sell the car." } });
  const [, agents] = await w.records("message.sent");
  const forged = w.rin.call(commitmentMake, { text: "sell the car", to: "rin", party: "owner", basis: { kind: "owner-words", record: String(agents?.id) } });
  await expect(forged).rejects.toThrow(/owner/);
});

test("a commitment done while its deadline is being told is not delivered, and not missed", async () => {
  // The inbox is slow: the owner marks the promise done while the wake is still telling the agent.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let telling = false;
  const slow = plugin("slow", (api) => {
    api.adjust(agentNotify, async (input) => {
      telling = true;
      await held;
      return input;
    });
  });
  const w = await world([slow]);
  const made = await w.rin.call(commitmentMake, { text: "Send the invoice", to: "rin", due: START + HOUR });
  await w.clock.advance(HOUR);
  await eventually(() => telling);
  await w.owner.call(commitmentDone, { id: made.id });
  release();
  await w.clock.advance(GRACE);
  await Bun.sleep(100);
  expect(await w.records("commitment.delivered")).toHaveLength(0);
  expect(await w.records("commitment.missed")).toHaveLength(0);
  expect((await w.owner.call(commitmentGet, { id: made.id })).status).toBe("kept");
});

test("a deadline a date cannot hold is refused, and so is a grace that ends before it begins", async () => {
  const w = await world();
  await expect(w.rin.call(commitmentMake, { text: "Never", to: "rin", due: 8_640_000_000_000_001 })).rejects.toThrow();
  // The grace after the deadline is past the last moment too.
  await expect(w.rin.call(commitmentMake, { text: "Nearly never", to: "rin", due: 8_640_000_000_000_000 - HOUR })).rejects.toThrow(/last moment/);
  expect(() => commitments({ graceMs: -1 })).toThrow(/graceMs/);
  expect(() => commitments({ graceMs: Number.NaN })).toThrow(/graceMs/);
  expect(await w.records("commitment.proposed")).toHaveLength(0);
});
