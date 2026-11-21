// A host with the base stack, a stand-in for the agents module and the memory module: what the checks of
// the module share. The memory is given a binding the check steers, so a call made from the check speaks
// as the address the check names.

import { action, actionName, owner } from "@niwa-labs/core";
import type { ActionName, Address, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { AGENT_TYPES, agentGet } from "@niwa-labs/agent/records";
import type { AgentDefinitionInput } from "@niwa-labs/agent/records";
import { baseStack, createNiwa, tempHome, testClock } from "@niwa-labs/testing";
import type { Host, TestClock } from "@niwa-labs/testing";

import { memory } from "../../src/index.ts";
import type { MemoryOptions } from "../../src/index.ts";

/**
 * The agents module as far as the memory reads it: it declares the agents' records and answers
 * `agent.get` for the agents it is given.
 */
export function agentsStandIn(agents: readonly AgentDefinitionInput[] = []): Plugin {
  return plugin("agents", (api) => {
    api.declare(...AGENT_TYPES);
    api.action(
      action(agentGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: ({ agent }) => {
          const definition = agents.find((one) => one.name === agent);
          if (definition === undefined) throw new Error(`there is no agent "${agent}"`);
          const address = { kind: "agent" as const, id: agent };
          return { name: agent, address, source: "config" as const, status: "asleep" as const, definition: { hands: [], tools: "all" as const, ...definition }, queued: 0, attached: [] };
        },
      }),
    );
  });
}

export interface MemoryHost {
  readonly host: Host;
  readonly home: string;
  readonly clock: TestClock;
  /** Call an action as an address: an agent, the owner; undefined calls it as the host, bound to nobody. */
  as<O = unknown>(who: Address | undefined, name: string, input: unknown): Promise<O>;
  records(): Promise<StoredRecord[]>;
  close(): Promise<void>;
}

const open: MemoryHost[] = [];

/** Close every host a check opened. */
export async function closeAll(): Promise<void> {
  for (const host of open.splice(0)) await host.close();
}

export const rin: Address = { kind: "agent", id: "rin" };
export const bob: Address = { kind: "agent", id: "bob" };
export { owner };

/** A host with the memory module; the options are the module's, `agents` the agents the stand-in knows. */
export async function memoryHost(options: Omit<MemoryOptions, "bind"> = {}, more: { agents?: AgentDefinitionInput[]; after?: Plugin[] } = {}): Promise<MemoryHost> {
  const home = await tempHome();
  const clock = testClock(Date.UTC(2026, 10, 1));
  const niwa = createNiwa({ home: home.path, clock });
  let speaking: Address | undefined;
  // The check speaks through the host; a client with the owner's token speaks as the owner.
  const bind: CallerBinding = (caller) => {
    if (caller.kind === "host") return speaking;
    if (caller.kind === "client" && caller.principal?.kind === "owner") return owner;
    return undefined;
  };
  niwa.use(...baseStack().plugins, agentsStandIn(more.agents), memory({ ...options, bind }), ...(more.after ?? []));
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
    records: () => niwa.records.read(),
    async close() {
      if (closed) return;
      closed = true;
      await niwa.close();
      await home.cleanup();
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
