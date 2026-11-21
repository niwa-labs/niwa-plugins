// Intake: the digest of a session attached to an agent is taken into the agent's memory, as where it is
// and what it tells of, not as a copy; a search then finds what the session did.

import { afterEach, expect, test } from "bun:test";

import { AgentAttached, AgentTurnQueued } from "@niwa-labs/agent/records";

import { closeAll, dataOf, memoryHost, rin, until } from "./fixtures/host.ts";

afterEach(closeAll);

const digest = (agent: string, turn: string, text: string, session = "claude s-1") => ({
  agent,
  turn,
  kind: "fact" as const,
  author: { kind: "niwa" as const, by: "workflow" },
  text,
  source: { kind: "session-digest" as const, session, from: "l-1", upto: "l-9" },
});

test("the digest of an attached session is taken into the agent's memory as a pointer, with the session's project", async () => {
  const host = await memoryHost();
  await host.host.emit(AgentAttached, { agent: "rin", session: "claude s-1", cwd: "/work/billing" });
  const told = await host.host.emit(AgentTurnQueued, digest("rin", "fact-a1b2c3", "The session paused. What it did:\nThe owner: move invoices to hourly"));
  // A fact with no digest behind it is not taken.
  await host.host.emit(AgentTurnQueued, { agent: "rin", turn: "fact-d4e5f6", kind: "fact", author: { kind: "owner" }, text: "CI is red" });
  const records = await until(host, "memory.digest.taken");
  expect(dataOf(records, "memory.digest.taken")).toEqual([
    { memory: "rin", turn: "fact-a1b2c3", record: told.id, session: "claude s-1", from: "l-1", upto: "l-9", project: "/work/billing" },
  ]);

  type Hit = { kind: string; id: string; title?: string; text: string; project?: string };
  const { hits } = await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "hourly invoices" });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ kind: "session", id: "fact-a1b2c3", title: "claude s-1", project: "/work/billing" });
  expect(hits[0]!.text).toContain("move invoices to hourly");
  expect((await host.as<{ hits: Hit[] }>(rin, "memory.search", { query: "invoices", project: "/work/site" })).hits).toEqual([]);
});

test("each agent takes its own digests, and the oldest beyond the limit are no longer searched", async () => {
  const host = await memoryHost({ limits: { sessions: 2 } });
  await host.host.emit(AgentTurnQueued, digest("bob", "fact-000001", "The owner: rename the billing module", "claude s-9"));
  for (const [n, word] of ["alpha", "beta", "gamma"].entries()) await host.host.emit(AgentTurnQueued, digest("rin", `fact-00010${String(n)}`, `The owner: talk about ${word}`));
  await until(host, "memory.digest.taken", 4);
  type Hits = { hits: Array<{ id: string }> };
  expect((await host.as<Hits>(rin, "memory.search", { query: "billing" })).hits).toEqual([]);
  expect((await host.as<Hits>({ kind: "agent", id: "bob" }, "memory.search", { query: "billing" })).hits.map((hit) => hit.id)).toEqual(["fact-000001"]);
  expect((await host.as<Hits>(rin, "memory.search", { query: "alpha" })).hits).toEqual([]);
  expect((await host.as<Hits>(rin, "memory.search", { query: "gamma" })).hits.map((hit) => hit.id)).toEqual(["fact-000102"]);
});
