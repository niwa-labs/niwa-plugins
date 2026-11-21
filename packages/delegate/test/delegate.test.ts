// Delegate on a real host: a request put to the agent is answered from the owner's decisions,
// decided within bounds, judged, or forwarded to the owner, and what was forwarded never outlives
// the request it was forwarded for.

import { afterEach, expect, test } from "bun:test";

import { action, grant, principalOf, stableJson } from "@niwa-labs/core";
import type { Address, Caller, Question, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { RequestCreated, requestAnswer, requestAsk, requestCancel, requestGet, requestResolve } from "@niwa-labs/requests/records";
import { baseStack, connect, connectAsOwner, createNiwa, eventually, tempHome, testClock } from "@niwa-labs/testing";
import type { NiwaApi, TestClock } from "@niwa-labs/testing";
import { z } from "zod";

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
          items: [{ text: "The owner indents Go with tabs.", project: "/work/go", source: { owner: { kind: "agent" as const, id: input.memory }, note: "note-5e1f0a2b", seq: at } }],
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
  expect(judged?.input.detail).toContain("/work/go");
  const created = (await w.records("request.created")).find((row) => (row.data as { id: string }).id === asked);
  expect(contextAsked.slice(before)).toEqual([
    expect.objectContaining({ memory: "rin", for: JUDGE, at: created?.seq, query: "Tabs or spaces?", purpose: expect.stringContaining("style") }),
  ]);
  expect(await w.to({ kind: "owner" })).toHaveLength(0);

  await w.owner.call(requestResolve, { id: judged?.id as never, answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  // The owner answered in the judge's place: the decision is his, not the judge's.
  expect((await w.records("delegate.decided"))[0]?.data).toMatchObject({ kind: "owner", area: "style", by: { kind: "owner" } });
  expect(await w.host.call(delegateRecall, { question: "style.indent" as never, input: choice("Tabs or spaces?", "style") })).toMatchObject({ found: true, answer: { ids: ["tabs"] } });
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

const hasDecision = async (w: World, kind: string) => (await w.records("delegate.decided")).some((row) => (row.data as { kind: string }).kind === kind);

/** A permission question with a one-time, a standing and a refusing option. */
function permission(title: string, area?: string): Question {
  return {
    kind: "permission",
    title,
    ...(area === undefined ? {} : { area }),
    options: [
      { id: "once", label: "Allow this once", flavor: "allow_once" },
      { id: "always", label: "Always allow", flavor: "allow_always" },
      { id: "no", label: "Refuse", flavor: "reject_once" },
    ],
    subject: { kind: "execute", target: "make test" },
  } as Question;
}

test("a one-time permission answer is not recalled: the next request goes to the owner again", async () => {
  const w = await world();
  const question = permission("Run make test?", "shell");
  const first = await w.ask(question);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["once"] } });
  await eventually(async () => (await w.status(first)) === "answered");
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  expect(await w.host.call(delegateRecall, { question: "style.indent" as never, input: question })).toEqual({ found: false });

  const second = await w.ask(question);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
  expect(await w.status(second)).toBe("open");

  // A standing permission is recalled, as any other decision.
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[1]?.id as never, answer: { ids: ["always"] } });
  await eventually(async () => (await w.status(second)) === "answered");
  await eventually(async () => (await w.records("delegate.decided")).length === 2);
  const third = await w.ask(question);
  await eventually(async () => (await w.status(third)) === "answered");
  expect(await w.to({ kind: "owner" })).toHaveLength(2);
});

test("a refusal for this time only is not recalled either", async () => {
  const w = await world();
  const question = permission("Run make test?", "shell");
  await w.ask(question);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["no"] } });
  await eventually(async () => (await w.records("delegate.decided")).length === 1);
  await w.ask(question);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
});

test("an answer the request's question does not take is refused and nothing is decided", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);
  await expect(rin.call(delegateDecide, { request: asked as never, area: "style", answer: { text: "either" } })).rejects.toThrow(/not valid|not answered/);
  await expect(rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["elastic"] } })).rejects.toThrow();
  expect(await w.records("delegate.decided")).toHaveLength(0);
  expect(await w.status(asked)).toBe("open");
});

/** A plugin that holds the answer of the agent's decisions where it reaches the request. */
function holdDecided(): { hold: Plugin; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const hold = plugin("hold-decided", (api) => {
    api.adjust(requestResolve, async (input) => {
      if (input.info?.how === "decided") await held;
      return input;
    });
  });
  return { hold, release };
}

test("a request is decided once: a competing answer is refused and the same one gives the first decision back", async () => {
  const { hold, release } = holdDecided();
  const w = await world({ extra: [hold] });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);
  const first = await rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["spaces"] } });
  await expect(rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["tabs"] } })).rejects.toThrow(/decided/);
  const again = await rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["spaces"] } });
  expect(again.decision).toBe(first.decision);
  expect(await w.records("delegate.decided")).toHaveLength(1);
  release();
  await eventually(async () => (await w.status(asked)) === "answered");
  expect(await answerOf(w, asked)).toEqual({ ids: ["spaces"] });
});

test("a decision the request did not take is revoked, not left standing", async () => {
  const { hold, release } = holdDecided();
  const w = await world({ extra: [hold] });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);
  const decided = await rin.call(delegateDecide, { request: asked as never, area: "style", answer: { ids: ["spaces"] } });
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  release();
  await eventually(async () => (await w.records("delegate.revoked")).length === 1);
  expect((await w.records("delegate.revoked"))[0]?.data).toMatchObject({ decision: decided.decision });
  expect(await w.status(asked)).toBe("cancelled");
  const listed = await w.owner.call(delegateDecisionList, {});
  expect(listed.items).toEqual([expect.objectContaining({ id: decided.decision, revoked: true })]);
});

test("a short id of a request names it for a decision", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const rin = await w.session("rin", ["delegate.decide@style"]);
  await rin.call(delegateDecide, { request: asked.slice(-6) as never, area: "style", answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
});

const STARTER: Address = { kind: "agent", id: "starter" };
const OTHER: Address = { kind: "agent", id: "other" };

/** A handler of the agent that asks rin a form of its own, whose value must also pass a refinement. */
function formAsker(): Plugin {
  return plugin("form-asker", (api) => {
    api.on(RequestCreated, { id: "start", filter: { "to.kind": "agent", "to.id": "starter" } }, async (_created, step) => {
      await step(requestAsk, {
        to: RIN,
        question: "size.pick" as never,
        input: { kind: "form", title: "How many?", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } as Question,
        from: LEAD,
        check: z.object({ n: z.number().min(0) }),
      });
    });
  });
}

test("an owner's answer the original form refuses is asked for again, and the corrected one answers the request", async () => {
  const w = await world({ extra: [formAsker()] });
  await w.host.call(requestAsk, { to: STARTER, question: "size.start" as never, input: choice("Go?"), from: LEAD } as never);
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  const original = (await w.to(RIN))[0]?.id ?? "";
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { form: { n: -1 } } });
  await eventually(async () => (await w.to({ kind: "owner" })).length === 2);
  const [, again] = await w.to({ kind: "owner" });
  expect(again?.input.detail).toContain("not accepted");
  expect(await w.status(original)).toBe("open");
  await w.owner.call(requestAnswer, { id: again?.id as never, answer: { form: { n: 3 } } });
  await eventually(async () => (await w.status(original)) === "answered");
  expect(await answerOf(w, original)).toEqual({ form: { n: 3 } });
});

test("an owner who keeps giving an answer the form refuses ends the request", async () => {
  const w = await world({ extra: [formAsker()] });
  await w.host.call(requestAsk, { to: STARTER, question: "size.start" as never, input: choice("Go?"), from: LEAD } as never);
  const original = async () => (await w.to(RIN))[0]?.id ?? "";
  for (let round = 1; round <= 3; round++) {
    await eventually(async () => (await w.to({ kind: "owner" })).length === round);
    await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[round - 1]?.id as never, answer: { form: { n: -round } } });
  }
  await eventually(async () => (await w.status(await original())) === "cancelled");
  expect(await w.to({ kind: "owner" })).toHaveLength(3);
});

test("a question another handler of the agent asked for the same request is not withdrawn with the forward", async () => {
  const rival = plugin("rival", (api) => {
    api.on(RequestCreated, { id: "rival-ask", filter: { "to.kind": "agent", "to.id": "rin" } }, async (_created, step) => {
      await step(requestAsk, { to: OTHER, question: "style.other" as never, input: choice("Which editor?"), from: RIN });
    });
  });
  const w = await world({ extra: [rival] });
  const asked = await w.ask(choice("Tabs or spaces?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1 && (await w.to(OTHER)).length === 1);
  await w.host.call(requestCancel, { id: asked as never, by: LEAD });
  const forward = (await w.to({ kind: "owner" }))[0]?.id ?? "";
  await eventually(async () => (await w.status(forward)) === "cancelled");
  await Bun.sleep(50);
  expect(await w.status((await w.to(OTHER))[0]?.id ?? "")).toBe("open");
});

test("an area named like a property of every object goes to the owner", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs or spaces?", "constructor"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  expect(await w.status(asked)).toBe("open");
});

test("a title on several lines is kept as a decision", async () => {
  const w = await world();
  const asked = await w.ask(choice("Tabs\nor spaces in Go, whatever the editor says about it later?", "style"));
  await eventually(async () => (await w.to({ kind: "owner" })).length === 1);
  await w.owner.call(requestAnswer, { id: (await w.to({ kind: "owner" }))[0]?.id as never, answer: { ids: ["tabs"] } });
  await eventually(async () => (await w.status(asked)) === "answered");
  await eventually(async () => await hasDecision(w, "owner"));
  expect((await w.records("delegate.decided"))[0]?.data).toMatchObject({ description: "Tabs or spaces in Go, whatever the editor says about it lat…" });
});

test("a host without the requests module does not start", async () => {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const host = createNiwa({ home: home.path, clock: testClock(START) });
  cleanups.push(() => host.close());
  host.use(delegate({ agent: "rin" }));
  await expect(host.serve()).rejects.toThrow(/request/);
});
