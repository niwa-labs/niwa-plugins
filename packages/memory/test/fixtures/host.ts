// A host with the base stack, a stand-in for the agents module and the memory module: what the checks of
// the module share. The memory is given a binding the check steers, so a call made from the check speaks
// as the address the check names.

import { action, actionName, actionRef, owner, recordId } from "@niwa-labs/core";
import type { Action, ActionContext, ActionName, Address, OperationId, RecordType, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { z } from "zod";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { AGENT_BRIEFING, AGENT_PROMPT_SECTION, AGENT_TYPES, BriefingSectionOutput, PromptSectionInput, PromptSectionOutput, agentBriefing, agentGet } from "@niwa-labs/agent/records";
import type { AgentDefinitionInput } from "@niwa-labs/agent/records";
import { baseStack, createNiwa, gate, tempHome, testClock } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";

import { memory } from "../../src/index.ts";
import type { MemoryOptions } from "../../src/index.ts";

/** What the stand-in composes of the prompt of an agent's session: the sections plugins offer, as the module reads them at a start. */
export const agentPromptSections = actionRef("agent.prompt.sections", {
  description: "The sections plugins offer to the prompt of an agent's sessions, as the stand-in reads them at a start.",
  input: PromptSectionInput,
  output: z.object({ sections: z.array(z.object({ id: z.string(), text: z.string() })) }),
});

/**
 * The agents module as far as the memory reads it: it declares the agents' records, answers `agent.get`
 * for the agents it is given, and writes a briefing of the sections plugins offer, as the module does.
 */
export function agentsStandIn(agents: readonly AgentDefinitionInput[] = [], hold?: Promise<void>): Plugin {
  return plugin("agents", (api) => {
    api.declare(...AGENT_TYPES);
    api.action(
      action(agentGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async ({ agent }) => {
          // A check holds the answer back to act while a caller waits for the agent's definition.
          await hold;
          const definition = agents.find((one) => one.name === agent);
          if (definition === undefined) throw new Error(`there is no agent "${agent}"`);
          const address = { kind: "agent" as const, id: agent };
          return { name: agent, address, source: "config" as const, status: "asleep" as const, definition: { hands: [], tools: "all" as const, ...definition }, queued: 0, attached: [] };
        },
      }),
    );
    api.action(
      action(agentPromptSections, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async ({ agent }, ctx) => {
          const sections: Array<{ id: string; text: string }> = [];
          for (const { plugin: by, value } of api.offers(AGENT_PROMPT_SECTION)) {
            if (value.agent !== undefined && value.agent !== agent) continue;
            const written = await ctx.step.outcome<unknown, unknown>(actionName(value.action), { agent });
            const parsed = written.status === "completed" ? PromptSectionOutput.safeParse(written.value) : undefined;
            if (parsed?.success === true && parsed.data.text.trim() !== "") sections.push({ id: `${String(by)}:${value.id}`, text: parsed.data.text.trim() });
          }
          return { sections };
        },
      }),
    );
    api.action(
      action(agentBriefing, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async ({ agent }, ctx) => {
          const sections: string[] = [];
          for (const { value } of api.offers(AGENT_BRIEFING)) {
            const written = await ctx.step.outcome<unknown, unknown>(actionName(value.action), { agent });
            const parsed = written.status === "completed" ? BriefingSectionOutput.safeParse(written.value) : undefined;
            if (parsed?.success === true && parsed.data.text.trim() !== "") sections.push(`${value.title}:\n${parsed.data.text.trim()}`);
          }
          return { text: sections.join("\n\n") };
        },
      }),
    );
  });
}

/** The module with its actions kept as it registers them, so a check can run one under an operation of its own. */
function capturing(made: Plugin, afterClaim?: () => Promise<void>): { plugin: Plugin; actions: Map<string, Action<any, any>> } {
  const actions = new Map<string, Action<any, any>>();
  const wrapped = plugin(
    made.name,
    (api) => {
      const spy = new Proxy(api, {
        get(target, key) {
          if (key === "action") {
            return (one: Action<any, any>) => {
              actions.set(one.name, one);
              if (one.name !== "memory.consolidate" || afterClaim === undefined) return target.action(one);
              target.action({ ...one, run: (input, ctx) => one.run(input, {
                ...ctx,
                async emit(type, data) {
                  const written = await ctx.emit(type, data);
                  if (type.name === "memory.consolidation.started") await afterClaim();
                  return written;
                },
              }) });
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      made.setup(spy);
    },
    { version: made.version },
  );
  return { plugin: wrapped, actions };
}

export interface MemoryHost {
  readonly host: Host;
  /**
   * Run an action as the host does for an operation, and as it is run again after a cut: the records it writes are
   * given the ids of the operation (`<operation>/emit/<n>`), so a repeat meets what the first run wrote. `cutAfter`
   * stops the run after that many records, as a crash between writing a record and saving the result does.
   */
  again<O = unknown>(name: string, input: unknown, operation: string, cutAfter?: number): Promise<O>;
  readonly home: string;
  readonly clock: TestClock;
  /** Call an action as an address: an agent, the owner; undefined calls it as the host, bound to nobody. */
  as<O = unknown>(who: Address | undefined, name: string, input: unknown): Promise<O>;
  records(): Promise<StoredRecord[]>;
  close(): Promise<void>;
  /** Close the host and keep its home, for a host that is opened on the same home later, which then removes it. */
  leave(): Promise<Home>;
}

/** A home a host runs in, and the way to remove it. */
type Home = Awaited<ReturnType<typeof tempHome>>;

const open: MemoryHost[] = [];

/** Close every host a check opened. */
export async function closeAll(): Promise<void> {
  for (const host of open.splice(0)) await host.close();
}

export const rin: Address = { kind: "agent", id: "rin" };
export const bob: Address = { kind: "agent", id: "bob" };
export { owner };

/** A host with the memory module; the options are the module's, `agents` the agents the stand-in knows. */
export async function memoryHost(options: Omit<MemoryOptions, "bind"> = {}, more: { agents?: AgentDefinitionInput[]; after?: Plugin[]; afterClaim?: () => Promise<void>; hold?: Promise<void>; home?: Home; without?: boolean } = {}): Promise<MemoryHost> {
  const home = more.home ?? (await tempHome());
  const clock = testClock(Date.UTC(2026, 10, 1));
  const niwa = createNiwa({ home: home.path, clock });
  let speaking: Address | undefined;
  // The check speaks through the host; a client with the owner's token speaks as the owner.
  const bind: CallerBinding = (caller) => {
    if (caller.kind === "host") return speaking;
    if (caller.kind === "client" && caller.principal?.kind === "owner") return owner;
    return undefined;
  };
  const { plugin: module, actions } = capturing(memory({ ...options, bind }), more.afterClaim);
  niwa.use(...baseStack().plugins, agentsStandIn(more.agents, more.hold), ...(more.without === true ? [] : [module]), ...(more.after ?? []));
  await niwa.serve();
  let closed = false;
  const made: MemoryHost = {
    host: niwa,
    home: home.path,
    clock,
    async as<O>(who: Address | undefined, name: string, input: unknown): Promise<O> {
      speaking = who;
      try {
        return (await niwa.call(actionName(name) as ActionName, input as never)) as O;
      } finally {
        speaking = undefined;
      }
    },
    async again<O>(name: string, input: unknown, operation: string, cutAfter = Number.POSITIVE_INFINITY): Promise<O> {
      const found = actions.get(name);
      if (found === undefined) throw new Error(`the memory has no action ${name}`);
      let ordinal = 0;
      const ctx = {
        operationId: operation as OperationId,
        caller: { kind: "host" },
        emit: async <T>(type: RecordType<T>, data: T): Promise<StoredRecord> => {
          if (ordinal >= cutAfter) throw new Error("cut");
          ordinal += 1;
          return niwa.emit(type, data, { id: recordId(`${operation}/emit/${ordinal}`) });
        },
      } as unknown as ActionContext;
      return (await found.run(found.input.parse(input), ctx)) as O;
    },
    records: () => niwa.records.read(),
    async close() {
      if (closed) return;
      closed = true;
      await niwa.close();
      await home.cleanup();
    },
    async leave() {
      if (closed) return home;
      closed = true;
      await niwa.close();
      return home;
    },
  };
  open.push(made);
  return made;
}

/** The data of the records of a type, in order. */
export const dataOf = (records: readonly StoredRecord[], type: string): unknown[] => records.filter((one) => one.type === type).map((one) => one.data);

/** Wait until the journal holds as many records of a type. */
export async function until(host: MemoryHost, type: string, count = 1, ms = 10_000): Promise<StoredRecord[]> {
  for (let waited = 0; waited < ms; waited += 20) {
    const all = await host.records();
    if (all.filter((one) => one.type === type).length >= count) return all;
    await Bun.sleep(20);
  }
  throw new Error(`fewer than ${String(count)} ${type} were written`);
}

// The crash test holds a real client call immediately after admission of its claim.
if (import.meta.main) {
  const path = process.argv[2]!;
  await memoryHost({}, {
    home: {path, cleanup: async () => {}},
    afterClaim: () => gate(path, "finish-consolidation").wait(),
  });
}
