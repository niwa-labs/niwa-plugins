/**
 * The actions the memory page calls, as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const Address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }).loose();
export type Address = z.infer<typeof Address>;

/** The memories are those of the agents, named by the agent. */
export const agentListAction = {
  name: "agent.list",
  input: z.object({}),
  output: z.object({ items: z.array(z.object({ name: z.string() })) }),
} as const;

export const NoteAbout = z.enum(["owner", "work"]);
export type NoteAbout = z.infer<typeof NoteAbout>;

export const NoteSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("inferred") }),
  z.object({ kind: z.literal("session"), session: z.string() }),
  z.object({ kind: z.literal("record"), record: z.string() }),
]);
export type NoteSource = z.infer<typeof NoteSource>;

export const Note = z.object({
  note: z.string(),
  text: z.string(),
  detail: z.string().optional(),
  about: NoteAbout,
  project: z.string().optional(),
  source: NoteSource,
  confirmed: z.boolean(),
  sources: z.number(),
  top: z.boolean(),
  pinned: z.boolean(),
  revision: z.number(),
  written: z.number(),
});
export type Note = z.infer<typeof Note>;

export const MAX_NOTES = 500;

export const noteListAction = {
  name: "memory.list",
  input: z.object({ memory: z.string(), limit: z.number().int().positive().max(MAX_NOTES).optional() }),
  output: z.object({ memory: z.string(), notes: z.array(Note) }),
} as const;

/** One note, as the page reads it to show the text of a question's note: only while it holds as the question named it. */
export const noteGetAction = {
  name: "memory.get",
  input: z.object({ memory: z.string(), note: z.string() }),
  output: z.object({ note: z.string(), text: z.string(), status: z.string(), revision: z.number() }),
} as const;

export const PageSummary = z.object({ page: z.string(), title: z.string(), project: z.string().optional(), revision: z.number() });
export type PageSummary = z.infer<typeof PageSummary>;

export const pageListAction = {
  name: "memory.page.list",
  input: z.object({ memory: z.string() }),
  output: z.object({ memory: z.string(), pages: z.array(PageSummary) }),
} as const;

const PageItem = z.object({
  item: z.string(),
  note: z.string(),
  position: z.number().int().nonnegative(),
  context: z.string().optional(),
  text: z.string(),
  source: NoteSource,
});
export type PageItem = z.infer<typeof PageItem>;

export const pageGetAction = {
  name: "memory.page.get",
  input: z.object({ memory: z.string(), page: z.string() }),
  output: PageSummary.extend({ items: z.array(PageItem) }),
} as const;

const OpenRequest = z.object({
  id: z.string(),
  to: Address,
  question: z.string(),
  input: z.object({ kind: z.string(), title: z.string(), detail: z.string().optional() }).loose(),
  from: Address.optional(),
});
export type OpenRequest = z.infer<typeof OpenRequest>;

const OpenPaused = z.object({ kind: z.literal("paused"), invocation: z.string() });

/** What waits for the owner: the share questions of the memories are among it. */
export const openAction = {
  name: "request.open",
  input: z.object({}),
  output: z.object({ requests: z.array(z.union([OpenPaused, OpenRequest])) }),
} as const;

export type Open = z.infer<typeof openAction.output>["requests"][number];
