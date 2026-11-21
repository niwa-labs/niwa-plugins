// The top layer: the notes a memory shows first, lifted by hand or by consolidation, for a project and
// within a size; the briefing of an agent carries it for the project the agent works on.

import { afterEach, expect, test } from "bun:test";

import { AgentAttached } from "@niwa-labs/agent/records";

import { bob, closeAll, memoryHost, owner, rin } from "./fixtures/host.ts";

afterEach(closeAll);

type Top = { memory: string; text: string; notes: string[]; left: number };

async function noted(host: Awaited<ReturnType<typeof memoryHost>>, input: Record<string, unknown>, who = rin): Promise<string> {
  return (await host.as<{ note: string }>(who, "memory.note", input)).note;
}

test("the top layer of a project holds the lifted notes about the owner, for the project and in general", async () => {
  const host = await memoryHost();
  const tea = await noted(host, { memory: "rin", text: "I drink tea, not coffee.", about: "owner", source: { kind: "owner" } }, owner);
  const nightly = await noted(host, { text: "Invoices are made nightly.", project: "/work/billing" });
  const general = await noted(host, { text: "Reviews come before merges." });
  const elsewhere = await noted(host, { text: "The site is built with Astro.", project: "/work/site" });
  const unlifted = await noted(host, { text: "Not shown first." });
  for (const note of [nightly, general, elsewhere]) expect(await host.as(rin, "memory.lift", { note })).toEqual({ note, top: true });
  await host.as(owner, "memory.lift", { memory: "rin", note: tea });

  const top = await host.as<Top>(rin, "memory.top", { project: "/work/billing" });
  expect(top.notes).toEqual([tea, nightly, general]);
  expect(top.text).toBe(
    ["About the owner:", `- I drink tea, not coffee. (${tea})`, "For /work/billing:", `- Invoices are made nightly. (${nightly})`, "In general:", `- Reviews come before merges. (${general})`].join("\n"),
  );
  expect(top.notes).not.toContain(unlifted);
  // Without a project, the top layer is the owner and what holds in general.
  expect((await host.as<Top>(rin, "memory.top", {})).notes).toEqual([tea, general]);

  await host.as(rin, "memory.drop", { note: general });
  await host.as(rin, "memory.retract", { note: nightly });
  expect((await host.as<Top>(rin, "memory.top", { project: "/work/billing" })).notes).toEqual([tea]);
  await expect(host.as(bob, "memory.lift", { memory: "rin", note: tea })).rejects.toThrow(/only its own memory/);
});

test("the top layer stays within its size, and says how many lifted notes it left out", async () => {
  const host = await memoryHost({ limits: { top: 120 } });
  const notes: string[] = [];
  for (const text of ["First note that is lifted.", "Second note that is lifted.", "Third note that is lifted.", "Fourth note that is lifted."]) {
    const note = await noted(host, { text });
    await host.as(rin, "memory.lift", { note });
    notes.push(note);
  }
  const top = await host.as<Top>(rin, "memory.top", {});
  expect(top.text.length).toBeLessThanOrEqual(120);
  expect(top.notes.length + top.left).toBe(4);
  expect(top.left).toBeGreaterThan(0);
  // The newest are shown first: they are what the agent knows best now.
  expect(top.notes[0]).toBe(notes[3]!);
});

test("an agent's briefing carries the top layer of its memory for the project it works on", async () => {
  const host = await memoryHost({}, { agents: [{ name: "rin", harness: "h", prompt: "p" }, { name: "lead", harness: "h", prompt: "p", project: { cwd: "/work/billing" } }] });
  const billing = await noted(host, { memory: "lead", text: "Invoices are made nightly.", project: "/work/billing" }, owner);
  const site = await noted(host, { memory: "rin", text: "The site is built with Astro.", project: "/work/site" }, owner);
  await host.as(owner, "memory.lift", { memory: "lead", note: billing });
  await host.as(owner, "memory.lift", { memory: "rin", note: site });

  const lead = await host.as<{ text: string }>(owner, "agent.briefing", { agent: "lead" });
  expect(lead.text).toBe(`What it remembers:\nFor /work/billing:\n- Invoices are made nightly. (${billing})`);
  // Rin has no project of her own: the session attached to her last says where she works.
  expect((await host.as<{ text: string }>(owner, "agent.briefing", { agent: "rin" })).text).toBe("");
  await host.host.emit(AgentAttached, { agent: "rin", session: "h n-1", cwd: "/work/site" });
  expect((await host.as<{ text: string }>(owner, "agent.briefing", { agent: "rin" })).text).toContain("The site is built with Astro.");
  // Another agent asking for Rin's briefing does not get her memory.
  expect((await host.as<{ text: string }>(bob, "agent.briefing", { agent: "rin" })).text).toBe("");
  expect((await host.as<{ text: string }>(rin, "agent.briefing", { agent: "rin" })).text).toContain("Astro");
});
