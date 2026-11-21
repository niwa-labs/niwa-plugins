/**
 * The records entry of commitments: the records the plugin writes and the typed references of its
 * actions; no factory and nothing that runs.
 *
 * A commitment is a promise with an author, an agent whose inbox it is delivered to, and maybe a
 * deadline. At the deadline it is delivered as a fact; when it is still not done after the grace
 * period, it is missed. The one who made it, or the owner, says it is done; either may cancel it.
 *
 * An agent's own promise is its to make. A promise on the owner's behalf, or one that sets him a
 * deadline, comes only from his own words: he makes it himself, an agent cites a record of his
 * that says it, or he confirms what an agent proposed.
 */

import { Address, EntityDescription, IdText, actionRef, getRef, idSchema, listRef, queryOf, record } from "@niwa-labs/core";
import type { Id, TypeQuery } from "@niwa-labs/core";
import { AgentName, BriefingSectionInput, BriefingSectionOutput } from "@niwa-labs/agent/records";
import { QuestionName, RequestId } from "@niwa-labs/requests/records";
import { z } from "zod";

/** The id of a commitment, `com-3fa9c2`. */
export const CommitmentId = idSchema("commitment");
export type CommitmentId = Id<"commitment">;

/** Who a promise binds: the one who makes it, or the owner. */
export const CommitmentParty = z.enum(["self", "owner"]);
export type CommitmentParty = z.infer<typeof CommitmentParty>;

/** A moment in milliseconds since the epoch. */
export const Moment = z.number().int().nonnegative();

/** Why a commitment stands: whose word made it. */
export const CommitmentBasis = z.discriminatedUnion("kind", [
  /** The one who made it promised it for itself. */
  z.strictObject({ kind: z.literal("own") }),
  /** The owner made it himself. */
  z.strictObject({ kind: z.literal("owner") }),
  /** An agent made it from a record of the owner's words: a message or a turn he wrote. */
  z.strictObject({ kind: z.literal("owner-words"), record: z.string().min(1) }),
  /** The owner confirmed what an agent proposed, by answering this request. */
  z.strictObject({ kind: z.literal("owner-confirmed"), request: RequestId }),
]);
export type CommitmentBasis = z.infer<typeof CommitmentBasis>;

/** What every commitment says about itself, proposed or made. */
const Terms = {
  id: CommitmentId,
  /** What is promised. */
  text: z.string().min(1),
  /** A few words a person reads in a list. */
  description: EntityDescription,
  /** Who made it. */
  by: Address,
  /** The agent whose inbox it is delivered to when it comes due. */
  to: AgentName,
  party: CommitmentParty,
  /** The deadline. A commitment without one is open until it is done or cancelled. */
  due: Moment.optional(),
};

/** A commitment was made: it stands from now on. */
export const CommitmentMade = record("commitment.made", z.object({ ...Terms, basis: CommitmentBasis }));

/** An agent proposed a commitment for the owner: it stands only when he confirms it. */
export const CommitmentProposed = record("commitment.proposed", z.object(Terms));

/** The owner did not confirm a proposed commitment. */
export const CommitmentDeclined = record("commitment.declined", z.object({ id: CommitmentId, request: RequestId.optional() }));

/** A commitment came due and was delivered to its agent's inbox. */
export const CommitmentDelivered = record("commitment.delivered", z.object({ id: CommitmentId, due: Moment, at: Moment }));

/** A commitment was done. */
export const CommitmentKept = record(
  "commitment.kept",
  z.object({ id: CommitmentId, by: Address.optional(), note: z.string().min(1).optional() }),
);

/** A commitment was not done by its deadline and the grace after it. */
export const CommitmentMissed = record("commitment.missed", z.object({ id: CommitmentId, due: Moment, at: Moment }));

/** A commitment was cancelled: it is no longer promised. */
export const CommitmentCancelled = record(
  "commitment.cancelled",
  z.object({ id: CommitmentId, by: Address.optional(), reason: z.string().min(1).optional() }),
);

/**
 * The records of one commitment, as a script waits for or reads them with their data typed:
 * `await wait(commitmentKept(id), { timeout: "2h" })`. A text that is not the id of a commitment is
 * refused here.
 */
export function commitmentMade(id: string): TypeQuery<z.output<typeof CommitmentMade.schema>> {
  return queryOf(CommitmentMade, { id: CommitmentId.parse(id) });
}

/** A proposal of one commitment. */
export function commitmentProposed(id: string): TypeQuery<z.output<typeof CommitmentProposed.schema>> {
  return queryOf(CommitmentProposed, { id: CommitmentId.parse(id) });
}

/** The owner did not confirm one proposed commitment. */
export function commitmentDeclined(id: string): TypeQuery<z.output<typeof CommitmentDeclined.schema>> {
  return queryOf(CommitmentDeclined, { id: CommitmentId.parse(id) });
}

/** One commitment came due and was delivered to its agent's inbox. */
export function commitmentDelivered(id: string): TypeQuery<z.output<typeof CommitmentDelivered.schema>> {
  return queryOf(CommitmentDelivered, { id: CommitmentId.parse(id) });
}

/** One commitment was done. */
export function commitmentKept(id: string): TypeQuery<z.output<typeof CommitmentKept.schema>> {
  return queryOf(CommitmentKept, { id: CommitmentId.parse(id) });
}

/** One commitment was not done by its deadline and the grace after it. */
export function commitmentMissed(id: string): TypeQuery<z.output<typeof CommitmentMissed.schema>> {
  return queryOf(CommitmentMissed, { id: CommitmentId.parse(id) });
}

/** One commitment was cancelled. */
export function commitmentCancelled(id: string): TypeQuery<z.output<typeof CommitmentCancelled.schema>> {
  return queryOf(CommitmentCancelled, { id: CommitmentId.parse(id) });
}

/** The record types the plugin declares. */
export const COMMITMENT_TYPES = [
  CommitmentProposed,
  CommitmentMade,
  CommitmentDeclined,
  CommitmentDelivered,
  CommitmentKept,
  CommitmentMissed,
  CommitmentCancelled,
] as const;

/**
 * Where a commitment stands: proposed to the owner, open, due (delivered and waiting to be done),
 * or how it ended.
 */
export const CommitmentStatus = z.enum(["proposed", "open", "due", "kept", "missed", "cancelled", "declined"]);
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

/** The statuses after which nothing more happens to a commitment. */
export const ENDED: readonly CommitmentStatus[] = ["kept", "missed", "cancelled", "declined"];

/** The name of the question that asks the owner to confirm a proposed commitment. */
export const CONFIRM_QUESTION: QuestionName = QuestionName.parse("commitment.confirm");

export const commitmentMake = actionRef("commitment.make", {
  description:
    "Makes a commitment: what is promised, the agent whose inbox it is delivered to at its deadline, and the deadline if it has one, in milliseconds since the epoch. Your own promise (party self) stands at once. A promise on the owner's behalf or one that sets him a deadline (party owner) stands only from his words: cite a record he wrote that says it (basis owner-words), or it is proposed to him and stands once he confirms. Every commitment is listed with a way to cancel it.",
  input: z.strictObject({
    text: z.string().min(1),
    description: EntityDescription.optional(),
    to: AgentName,
    party: CommitmentParty.default("self"),
    due: Moment.optional(),
    /** The record of the owner's words a promise for him is made from. */
    basis: z.strictObject({ kind: z.literal("owner-words"), record: z.string().min(1) }).optional(),
  }),
  output: z.object({ id: CommitmentId, status: z.enum(["open", "proposed"]) }),
});

export const commitmentDone = actionRef("commitment.done", {
  description: "Says a commitment is done. Only the one who made it, or the owner, may.",
  input: z.strictObject({ id: IdText, note: z.string().min(1).optional() }),
  output: z.object({ id: CommitmentId, status: CommitmentStatus }),
});

export const commitmentCancel = actionRef("commitment.cancel", {
  description:
    "Cancels a commitment that has not ended. The owner may cancel any; the one who made it may cancel its own promise, not one made for the owner.",
  input: z.strictObject({ id: IdText, reason: z.string().min(1).optional() }),
  output: z.object({ id: CommitmentId, status: CommitmentStatus }),
});

export const commitmentList = listRef("commitment.list", {
  kind: "commitment",
  noun: "commitment",
  detail: "Oldest first; the filters narrow by where it stands and by the agent it is delivered to.",
  filter: { status: CommitmentStatus.optional(), to: AgentName.optional() },
  item: { status: CommitmentStatus, party: CommitmentParty, to: AgentName, due: Moment.optional() },
});

/** One commitment, whole. */
export const CommitmentEntity = z.object({
  ...Terms,
  status: CommitmentStatus,
  /** Whose word it stands on; absent while it is proposed. */
  basis: CommitmentBasis.optional(),
  /** Who ended it, when it was done or cancelled by an address. */
  endedBy: Address.optional(),
  /** What was said when it ended: the note of a done one, the reason of a cancelled one. */
  note: z.string().optional(),
});
export type CommitmentEntity = z.infer<typeof CommitmentEntity>;

export const commitmentGet = getRef("commitment.get", {
  kind: "commitment",
  noun: "commitment",
  detail: "It carries what was promised, who made it, whose word it stands on and where it stands.",
  entity: CommitmentEntity,
});

/** The section of an agent's briefing: the commitments delivered to it or made by it that have not ended. */
export const commitmentBriefing = actionRef("commitment.briefing", {
  description: "The open commitments of an agent, one line each: the ones delivered to it and the ones it made.",
  input: BriefingSectionInput,
  output: BriefingSectionOutput,
});
