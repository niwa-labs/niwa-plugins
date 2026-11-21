// A done or a cancel made again under its own operation, after the host stopped before it kept the
// answer, answers what the first call answered; only another operation meets a commitment that ended.

import { expect, test } from "bun:test";

import { recordId } from "@niwa-labs/core";
import type { Action, ActionContext, Address, Caller, JournalReader, NewRecord, OperationId, RecordTypeName, StoredRecord } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";

import { commitments } from "../src/index.ts";

/** A journal in memory: records in commit order, written once by id. */
class MemoryJournal {
  readonly rows: StoredRecord[] = [];

  append(record: NewRecord): StoredRecord {
    const same = this.rows.find((row) => row.id === record.id);
    if (same !== undefined) return same;
    const stored = { ...record, seq: this.rows.length + 1, at: 1_000_000 } as unknown as StoredRecord;
    this.rows.push(stored);
    return stored;
  }

  reader(): JournalReader {
    return {
      get: (id: string) => this.rows.find((row) => row.id === id),
      since: (from: number, types?: RecordTypeName[]) => this.rows.filter((row) => row.seq > from && (types === undefined || types.includes(row.type as RecordTypeName))),
    } as unknown as JournalReader;
  }
}

const rin: Caller = { kind: "client", id: "session:rin", principal: { kind: "session", id: "rin" } } as unknown as Caller;
const bind = (caller: Caller): Address | undefined => (caller.kind === "client" && caller.principal?.kind === "session" ? { kind: "agent", id: String(caller.principal.id) } : undefined);

/** The actions of the plugin run by hand over a journal of its own, as the host would run them. */
function serve() {
  const journal = new MemoryJournal();
  const reader = journal.reader();
  const found = new Map<string, Action<any, any, any>>();
  const api = new Proxy({} as PluginApi, {
    get: (_target, name) => {
      if (name === "action") return (one: Action<any, any, any>) => void found.set(one.name, one);
      if (name === "journal") return () => reader;
      return () => undefined;
    },
  });
  commitments({ messages: { bind } }).setup(api);
  // The context of one call: a call made again is a new context under the same operation.
  const call = async (name: string, input: unknown, operation: string): Promise<{ id: string; status: string }> => {
    let ordinal = 0;
    const ctx = {
      operationId: operation as OperationId,
      caller: rin,
      emit: async (type: { name: string; version: number }, data: unknown) => {
        ordinal += 1;
        const id = recordId(`${operation}/emit/${ordinal}`);
        return journal.append({ id, stream: `input:${type.name}`, type: type.name, schema: type.version, data, actor: rin, cause: null, root: id } as unknown as NewRecord);
      },
    } as unknown as ActionContext;
    const one = found.get(name);
    if (one === undefined) throw new Error(`no action ${name}`);
    return (await one.run(one.input.parse(input), ctx)) as { id: string; status: string };
  };
  return { call };
}

test("a done made again under its operation answers kept, and another operation finds it ended", async () => {
  const world = serve();
  const made = await world.call("commitment.make", { text: "Send the notes", to: "rin" }, "op-make");
  expect(await world.call("commitment.done", { id: made.id }, "op-done")).toEqual({ id: made.id, status: "kept" });
  expect(await world.call("commitment.done", { id: made.id }, "op-done")).toEqual({ id: made.id, status: "kept" });
  await expect(world.call("commitment.done", { id: made.id }, "op-other")).rejects.toThrow(/kept/);
  await expect(world.call("commitment.cancel", { id: made.id }, "op-done")).rejects.toThrow(/kept/);
});

test("a cancel made again under its operation answers cancelled, and another operation finds it ended", async () => {
  const world = serve();
  const made = await world.call("commitment.make", { text: "Send the notes", to: "rin" }, "op-make");
  expect(await world.call("commitment.cancel", { id: made.id }, "op-cancel")).toEqual({ id: made.id, status: "cancelled" });
  expect(await world.call("commitment.cancel", { id: made.id }, "op-cancel")).toEqual({ id: made.id, status: "cancelled" });
  await expect(world.call("commitment.cancel", { id: made.id }, "op-other")).rejects.toThrow(/cancelled/);
  await expect(world.call("commitment.done", { id: made.id }, "op-cancel")).rejects.toThrow(/cancelled/);
});
