/**
 * The request for context: what delegate asks a data owner, and what comes back.
 *
 * Delegate never reads another plugin's data itself. It says what it needs, for whom and why; the
 * plugin that owns the data answers with sources, each naming who holds it and where in the journal
 * it was read. A memory serves this request as an action of its own name, built from
 * `contextSource(name)`, and imports nothing but this entry.
 */

import { Address, actionRef } from "@niwa-labs/core";
import type { ActionRef } from "@niwa-labs/core";
import { z } from "zod";

/** A position in the journal: the sequence number of a record. */
export const JournalPosition = z.number().int().nonnegative();
export type JournalPosition = z.infer<typeof JournalPosition>;

/** What a caller asks a data owner for. */
export const ContextRequest = z.strictObject({
  /** What is needed, in a sentence: the question to be answered. */
  what: z.string().min(1),
  /** The area the question is about, when it names one. */
  area: z.string().min(1).optional(),
  /** Whose data is asked: the agent whose memory is read. */
  of: Address,
  /** Who reads what comes back. A source that may not reach this address is withheld. */
  for: Address,
  /** Why it is needed: what the reader will do with it. */
  why: z.string().min(1),
  /** Read the data as it stood at this position, so a later judgement of an old question sees the old data. */
  asOf: JournalPosition.optional(),
});
export type ContextRequest = z.infer<typeof ContextRequest>;

/** One piece of context, with where it comes from. */
export const SourceRef = z.strictObject({
  /** Who holds the data: the address the source belongs to. */
  owner: Address,
  /** The id of the source inside the owner's data: a note, a page, a record. */
  ref: z.string().min(1),
  /** Where in the journal the source stood when it was read. */
  at: JournalPosition,
  /** What may be passed on: the conclusion, not necessarily the source's own text. */
  text: z.string().min(1),
  /** Where the conclusion holds: an area or a project. Absent when it holds everywhere. */
  scope: z.string().min(1).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** What a data owner answers. */
export const ContextAnswer = z.strictObject({
  sources: z.array(SourceRef),
  /** How many sources were found and not passed on, because the reader may not have them without the owner's answer. */
  withheld: z.number().int().nonnegative(),
});
export type ContextAnswer = z.infer<typeof ContextAnswer>;

/** The action a data owner serves to answer a request for context, under the name it chooses. */
export function contextSource(name: string): ActionRef<ContextRequest, ContextAnswer> {
  return actionRef(name, {
    description:
      "Answers a request for context: what is needed, whose data is read, who will read the answer and why. Returns the sources that may reach that reader, each with the address that holds it and the journal position it was read at, and how many were withheld.",
    input: ContextRequest,
    output: ContextAnswer,
  });
}
