/**
 * The request for context: what delegate asks a data owner, and what it reads of the answer.
 *
 * Delegate never reads another plugin's data itself. It says what it needs, of whose memory, for whom
 * and why; the plugin that owns the data answers with conclusions, each with its source: the address
 * of the memory that holds it, the note, and the journal position it stood at. A memory serves this as
 * `memory.context`; delegate knows the action only by the name its composition gives, and the types
 * here are the part of that action it sends and reads. A memory imports them from this entry to keep
 * the two in step.
 */

import { Address, actionRef } from "@niwa-labs/core";
import type { ActionRef } from "@niwa-labs/core";
import { z } from "zod";

/** A position in the journal: the sequence number of a record. */
export const JournalPosition = z.number().int().nonnegative();
export type JournalPosition = z.infer<typeof JournalPosition>;

/** What a caller asks a data owner for. */
export const ContextRequest = z.object({
  /** Whose memory is read: the name of the agent it belongs to. */
  memory: z.string().min(1),
  /** What is needed, in a sentence: the question to be answered. */
  query: z.string().min(1).max(500),
  /** Why it is needed: what the reader will do with it. */
  purpose: z.string().min(1).max(500),
  /** Who reads what comes back. A conclusion that may not reach this address is withheld. */
  for: Address,
  /** Read the data as it stood at this position, so a later judgement of an old question sees the old data. */
  at: JournalPosition.optional(),
});
export type ContextRequest = z.infer<typeof ContextRequest>;

/** Where a conclusion comes from: who holds the data, the note, and the journal position it stood at. */
export const SourceRef = z.object({
  owner: Address,
  note: z.string().min(1),
  seq: JournalPosition,
});
export type SourceRef = z.infer<typeof SourceRef>;

/** One conclusion the data owner lets the reader have. */
export const ContextItem = z.object({
  text: z.string(),
  /** Where it holds: the project the conclusion is about. Without one it holds everywhere. */
  project: z.string().min(1).optional(),
  source: SourceRef,
});
export type ContextItem = z.infer<typeof ContextItem>;

/** What a data owner answers, as far as delegate reads it. */
export const ContextAnswer = z.object({
  /** The position the answer was read at. */
  at: JournalPosition,
  items: z.array(ContextItem),
  /** What bore on the question and was not let out to this reader. */
  withheld: z.array(z.object({ note: z.string().min(1) })),
});
export type ContextAnswer = z.infer<typeof ContextAnswer>;

/** The action a data owner serves to answer a request for context, under the name it chooses. */
export function contextSource(name: string): ActionRef<ContextRequest, ContextAnswer> {
  return actionRef(name, {
    description:
      "Answers a request for context: what is needed, of whose memory, for whom and why. Returns the conclusions that may reach that reader, each with its source (the memory's address, the note and the journal position), and what was withheld.",
    input: ContextRequest,
    output: ContextAnswer,
  });
}
