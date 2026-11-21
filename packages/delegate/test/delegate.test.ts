// Delegate on a real host: a request put to the agent is answered from the owner's decisions,
// decided within bounds, judged, or forwarded to the owner, and what was forwarded never outlives
// the request it was forwarded for.

import { afterEach, expect, test } from "bun:test";

import { action, grant, principalOf, stableJson } from "@niwa-labs/core";
import type { Address, Caller, Question, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { requestAnswer, requestAsk, requestCancel, requestGet, requestResolve } from "@niwa-labs/requests/records";
import { baseStack, connect, connectAsOwner, createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import type { NiwaApi, TestClock } from "@niwa-labs/testing";

import { delegate } from "../src/index.ts";
import { contextSource, delegateDecide, delegateDecisionList, delegateRecall, delegateRevoke } from "../src/records.ts";
import type { ContextRequest } from "../src/records.ts";

const START = 1_700_000_000_000;
const RIN: Address = { kind: "agent", id: "rin" };
// The requests module of the base stack binds a session to a client address of its own, not to an
// agent, so in these tests the owner gives the answer in the judge's place.
const JUDGE: Address = { kind: "agent", id: "judge" };
const LEAD: Address = { kind: "agent", id: "lead" };
const JUDGE_WAIT = 30 * 60_000;

/** The owner is the owner; a session speaks as the agent of its name. */
function bind(caller: Caller): Address | undefined {
  if (caller.kind !== "client") return undefined;
  if (caller.principal?.kind === "owner") return { kind: "owner" };
  if (caller.principal?.kind === "session") return { kind: "agent", id: String(caller.principal.id) };
  return { kind: "client", id: caller.id };
}

/** A question in an area, with a choice of two options. */
function choice(title: string, area?: string): Question {
  return {
    kind: "choice",
    title,
    ...(area === undefined ? {} : { area }),
    options: [
      { id: "tabs", label: "Tabs", flavor: "plain" },
      { id: "spaces", label: "Spaces", flavor: "plain" },
    ],
    allowOther: false,
  } as Question;
}

const memoryContext = contextSource("memory.context");
const contextAsked: ContextRequest[] = [];
/** A memory as delegate sees it: it answers a request for context with one conclusion and keeps two back. */
const memory = plugin("memory", (api) => {
  api.action(
    action(memoryContext, {
      recovery: "repeat",
      effect: "read",
      world: "niwa",
      run: async (input) => {
        contextAsked.push(input);
        const at = input.at ?? 0;
        return {
          at,
          items: [{ text: "The owner indents Go with tabs.", source: { owner: { kind: "agent" as const, id: input.memory }, note: "note-5e1f0a2b", seq: at } }],
          withheld: [{ note: "note-00000001" }, { note: "note-00000002" }],
        };
      },
    }),
  );
});

interface World {
  readonly host: ReturnType<typeof createNiwa>;
  readonly home: string;
  readonly clock: TestClock;
  readonly owner: NiwaApi;
  /** A session that speaks as an agent, held to a grant. */
  readonly session: (name: string, rules: readonly string[]) => Promise<NiwaApi>;
  readonly records: (type: string) => Promise<StoredRecord[]>;
  /** The lead asks rin a question, as a request of its own. */
  readonly ask: (question: Question, deadline?: number) => Promise<string>;
  /** The requests addressed to someone, as they were created. */
  readonly to: (address: Address) => Promise<Array<{ id: string; question: string; input: Question; from?: Address }>>;
  readonly status: (id: string) => Promise<string>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(opts: { judges?: Record<string, Address>; extra?: readonly Plugin[] } = {}): Promise<World> {
  const home = await tempHome();
  const clock = testClock(START);
  const host = createNiwa({ home: home.path, clock });
  cleanups.push(() => home.cleanup());
  cleanups.push(() => host.close());
  host.use(
    ...baseStack().plugins,
    ...(opts.extra ?? []),
    memory,
    delegate({ agent: "rin", messages: { bind }, judgeWaitMs: JUDGE_WAIT, ...(opts.judges === undefined ? {} : { judges: opts.judges, context: ["memory.context"] }) }),
  );
  await host.serve();
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const records = async (type: string) => (await host.records.read()).filter((row) => row.type === type);
  const session = async (name: string, rules: readonly string[]) => {
    const token = host.issueToken(principalOf("session", name), { grant: grant([...rules]) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    cleanups.push(() => client.close());
    return client;
  };
  const ask = async (question: Question, deadline?: number) => {
    const asked = await host.call(requestAsk, {
      to: RIN,
      question: "style.indent" as never,
      input: question,
      from: LEAD,
      ...(deadline === undefined ? {} : { deadline }),
    } as never);
    return (asked as { id: string }).id;
  };
  const to = async (address: Address) =>
    (await records("request.created"))
      .map((row) => row.data as { id: string; to: Address; question: string; input: Question; from?: Address })
      .filter((one) => stableJson(one.to) === stableJson(address));
  const status = async (id: string) => (await host.call(requestGet, { id: id as never })).status;
  return { host, home: home.path, clock, owner, session, records, ask, to, status };
}

/** The answer of a request, once it has one. */
async function answerOf(w: World, id: string): Promise<unknown> {
  return (await w.host.call(requestGet, { id: id as never })).answer;
}

test("a request the owner has not decided is forwarded to him, and his answer is recalled the next time", async () => {
  const w = await world();
  const first = await w.ask(choice("Tabs or spaces in Go?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const [forward] = await w.to({ kind: "owner" });
  expect(forward?.from).toEqual(RIN);
  expect(forward?.input.title).toBe("Tabs or spaces in Go?");

  await w.owner.call(requestAnswer, { id: forward?.id as never, answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(first)) === "answered");
  expect(await answerOf(w, first)).toEqual({ ids: ["tabs"] });
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  expect((await w.records("delegate.decided"))[0]?.data).toMatchObject({ area: "style", kind: "owner", answer: { ids: ["tabs"] } });

  const second = await w.ask(choice("Tabs or spaces in Go?", "style"));
  await eventually(async () => (await w.status(second)) === "answered");
  expect(await answerOf(w, second)).toEqual({ ids: ["tabs"] });
  const answered = (await w.records("request.answered")).map((row) => row.data as { id: string; how?: string; area?: string; source?: string });
  expect(answered.find((one) => one.id === second)).toMatchObject({ how: "recalled", area: "style" });
  expect(await w.to({ kind: "owner" })).toHaveLength(1);
});

test("a decision holds in its own area, and a question without an area is never recalled", async () => {
  const w = await world();
  const first = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(first)) === "answered");

  await w.ask(choice("Tabs or spaces?", "docs"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
  await w.ask(choice("Tabs or spaces?"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 3);
  const recall = await w.host.call(delegateRecall, { question: "style.indent" as never, input: choice("Tabs or spaces?") });
  expect(recall).toEqual({ found: false });
});

test("a revoked decision is no longer recalled, but a recall as of before the revocation still finds it", async () => {
  const w = await world();
  const first = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["spaces"] } });
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  const decision = ((await w.records("delegate.decided"))[0]?.data as { id: string }).id;
  const before = (await w.host.records.read()).at(-1)?.seq ?? 0;

  const rin = await w.session("rin", ["delegate.*"]);
  await expect(rin.call(delegateRevoke, { decision: decision as never })).rejects.toThrow(/owner/);
  await w.owner.call(delegateRevoke, { decision: decision as never, reason: "changed my mind" });

  const input = choice("Tabs or spaces?", "style");
  expect(await w.host.call(delegateRecall, { question: "style.indent" as never, input })).toEqual({ found: false });
  expect(await w.host.call(delegateRecall, { question: "style.indent" as never, input, asOf: before })).toMatchObject({ found: true, decision, answer: { ids: ["spaces"] } });
  expect(await answerOf(w, first)).toEqual({ ids: ["spaces"] });

  await w.ask(input);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
  const listed = await w.owner.call(delegateDecisionList, {});
  expect(listed.items).toEqual([expect.objectContaining({ id: decision, area: "style", kind: "owner", revoked: true })]);
});

test("requests waiting for the owner wait side by side", async () => {
  const w = await world();
  const indent = await w.ask(choice("Tabs or spaces?", "style"));
  const width = await w.ask(choice("80 or 100 columns?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
  const forwards = await w.to({ kind: "owner" });
  const widthForward = forwards.find((one) => one.input.title.startsWith("80"));
  await w.owner.call(requestAnswer, { id: widthForward?.id as never, answer: { ids: ["spaces"] } });
  await eventually(async () => (await w.status(width)) === "answered");
  expect(await w.status(indent)).toBe("open");
});

test("the owner cancelling a forward cancels the request it was forwarded for", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestCancel, { id: (await w.to({ kind: "owner" }))[0]?.id as never, reason: "not now" });
  await eventually(async () => (await w.status(asked)) === "cancelled");
});

test("a forward is withdrawn when its request is cancelled by the asker", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  const forward = (await w.to({ kind: "owner" }))[0]?.id ?? "";
  await eventually(async () => (await w.status(forward)) === "cancelled");
});

test("a forward is withdrawn when its request expires", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"), START + 60_000);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.clock.advance(60_000);
  await eventually(async () => (await w.status(asked)) === "expired");
  const forward = (await w.to({ kind: "owner" }))[0]?.id ?? "";
  await eventually(async () => (await w.status(forward)) === "cancelled");
});

test("a forward asked after its request was over is withdrawn at once", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asking = false;
  const hold = plugin("hold", (api) => {
    api.adjust(requestAsk, async (input) => {
      if (input.to.kind === "owner") {
        asking = true;
        await held;
      }
      return input;
    });
  });
  const w = await world({ extra: [hold] });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(() => asking);
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  release();
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const forward = (await w.to({ kind: "owner" }))[0]?.id ?? "";
  await eventually(async () => (await w.status(forward)) === "cancelled");
});

test("the agent decides within its bounds: the request is answered and the forward withdrawn", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);

  const decided = await rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["spaces"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
  expect(await answerOf(w, asked)).toEqual({ ids: ["spaces"] });
  expect((await w.records("delegate.decided")).map((row) => row.data)).toEqual([
    expect.objectContaining({ id: decided.decision, kind: "agent", area: "style", by: RIN, request: asked }),
  ]);
  const forward = (await w.to({ kind: "owner" }))[0]?.id ?? "";
  await eventually(async () => (await w.status(forward)) === "cancelled");

  // An agent's decision answers its request; it is not the owner's, so it is not recalled.
  expect(await w.host.call(delegateRecall, { question: "style.indent" as never, input: choice("Tabs or spaces?", "style") })).toEqual({ found: false });
});

test("a decision outside the request's own area is refused, whatever the grant allows", async () => {
  const w = await world();
  const asked = await w.ask(choice("Pay the invoice?", "money"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);
  await expect(rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["tabs"] } })).rejects.toThrow(/area/);
  await expect(rin.call(delegateDecide, { request: asked as never, area: "money", answer: { ids: ["tabs"] } })).rejects.toThrow();
  expect(await w.records("delegate.decided")).toHaveLength(0);
  expect(await w.status(asked)).toBe("open");
});

test("only a request put to the agent, and still open, is decided", async () => {
  const w = await world();
  const rin = await w.session("rin", ["delegate.decide@style"]);
  const elsewhere = (await w.host.call(requestAsk, { to: JUDGE, question: "style.indent" as never, input: choice("Tabs?", "style") })) as { id: string };
  await expect(rin.call(delegateDecide, { request: elsewhere.id as never, area: "style", answer: { ids: ["tabs"] } })).rejects.toThrow(/rin/);
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  await expect(rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["tabs"] } })).rejects.toThrow(/cancelled/);
});

test("a request of an area with a judge goes to the judge, with the context the data owner gives", async () => {
  const w = await world({ judges: { style: JUDGE } });
  const before = contextAsked.length;
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to(JUDGE)).length === 1);
  const [judged] = await w.to(JUDGE);
  expect(judged?.from).toEqual(RIN);
  expect(judged?.input.detail).toContain("The owner indents Go with tabs.");
  expect(judged?.input.detail).toContain("note-5e1f0a2b of agent rin");
  expect(judged?.input.detail).toContain("2 more");
  const created = (await w.records("request.created")).find((row) => (row.data as { id: string }).id === asked);
  expect(contextAsked.slice(before)).toEqual([
    expect.objectContaining({ memory: "rin", for: JUDGE, at: created?.seq, query: "Tabs or spaces?", purpose: expect.stringContaining("style") }),
  ]);
  expect(await w.to({ kind: "owner" })).toHaveLength(0);

  await w.owner.call(requestResolve, { id: judged?.id as never, answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  expect((await w.records("delegate.decided"))[0]?.data).toMatchObject({ kind: "judge", area: "style", by: JUDGE });
});

test("a request the judge does not answer in time goes on to the owner", async () => {
  const w = await world({ judges: { style: JUDGE } });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to(JUDGE)).length === 1);
  const judged = (await w.to(JUDGE))[0]?.id ?? "";
  await w.clock.advance(JUDGE_WAIT - 1);
  await Bun.sleep(50);
  expect(await w.status(judged)).toBe("open");
  await w.clock.advance(1);
  await eventually(async () => (await w.status(judged)) === "expired");
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["spaces"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
  expect(await answerOf(w, asked)).toEqual({ ids: ["spaces"] });
});

test("a judge's question is withdrawn with its request, and nothing goes on to the owner", async () => {
  const w = await world({ judges: { style: JUDGE } });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to(JUDGE)).length === 1);
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  const judged = (await w.to(JUDGE))[0]?.id ?? "";
  await eventually(async () => (await w.status(judged)) === "cancelled");
  await Bun.sleep(50);
  expect(await w.to({ kind: "owner" })).toHaveLength(0);
});
