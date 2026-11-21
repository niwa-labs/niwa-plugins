/**
 * The records entry of delegate: the records it writes, the typed references of its actions, and the
 * request for context a data owner serves. No factory and nothing that runs.
 *
 * Delegate answers for the owner the requests put to one agent. It recalls what the owner decided
 * about the same question in the same area; it lets the agent, or a judge of the area, decide within
 * bounds; and what nobody may decide it forwards to the owner, whose answer becomes his decision.
 */

import { Address, AnswerSchema, EntityDescription, IdText, QuestionSchema, actionRef, idSchema, listRef, record } from "@niwa-labs/core";
import type { Id } from "@niwa-labs/core";
import { QuestionName, RequestId } from "@niwa-labs/requests/records";
import { z } from "zod";

import { JournalPosition } from "./context.ts";

export { ContextAnswer, ContextItem, ContextRequest, JournalPosition, SourceRef, contextSource } from "./context.ts";

/** The id of a decision, `dec-3fa9c2`. */
export const DecisionId = idSchema("decision");
export type DecisionId = Id<"decision">;

/** Who decided: the owner, the agent within its bounds, or the judge of the area. */
export const DecisionKind = z.enum(["owner", "agent", "judge"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

/**
 * A question was decided in an area.
 *
 * The key of a question is its name and what was asked, without the area: the area is the scope of
 * the decision, not part of the question. The owner's decisions are what is recalled.
 */
export const DecisionMade = record(
  "delegate.decided",
  z.object({
    id: DecisionId,
    /** A few words a person reads in a list: the title of the question. */
    description: EntityDescription,
    /** The key of the question. */
    question: z.string().min(1),
    area: z.string().min(1),
    kind: DecisionKind,
    answer: AnswerSchema,
    /** The request the decision answered. */
    request: RequestId,
    /** The records it stands on: the answer of the owner or the judge, the sources an agent read. */
    grounds: z.array(z.string().min(1)),
    /** Who decided, when it speaks as an address. */
    by: Address.optional(),
  }),
);

/** A decision was revoked: it is no longer recalled. */
export const DecisionRevoked = record(
  "delegate.revoked",
  z.object({ decision: DecisionId, by: Address.optional(), reason: z.string().min(1).optional() }),
);

/** A request put to the agent was passed on: to the judge of its area or to the owner. */
export const RequestForwarded = record(
  "delegate.forwarded",
  z.object({ request: RequestId, to: Address }),
);

/** The record types delegate declares. */
export const DELEGATE_TYPES = [DecisionMade, DecisionRevoked, RequestForwarded] as const;

export const delegateRecall = actionRef("delegate.recall", {
  description:
    "Says what the owner decided about a question in its area: the same question name and what was asked, without the area. Give asOf, a journal position, to read the decisions as they stood then. A question without an area recalls nothing.",
  input: z.strictObject({ question: QuestionName, input: QuestionSchema, asOf: JournalPosition.optional() }),
  output: z.union([
    z.object({ found: z.literal(false) }),
    z.object({ found: z.literal(true), answer: AnswerSchema, area: z.string(), decision: DecisionId }),
  ]),
});

export const delegateDecide = actionRef("delegate.decide", {
  description:
    "Decides an open request put to the agent, within bounds: the area must be the area the request names, and a grant allows delegate.decide@<area>. The answer answers the request and is kept as a decision; whatever was forwarded for it is withdrawn.",
  input: z.strictObject({
    request: IdText,
    /** The area of the request: what the grant is checked against. */
    area: z.string().min(1),
    answer: AnswerSchema,
    /** The records the decision stands on, such as the sources read for it. */
    grounds: z.array(z.string().min(1)).default([]),
  }),
  output: z.object({ decision: DecisionId }),
  target: (input) => input.area,
});

export const delegateRevoke = actionRef("delegate.revoke", {
  description: "Revokes a decision so it is no longer recalled. Only the owner may.",
  input: z.strictObject({ decision: IdText, reason: z.string().min(1).optional() }),
  output: z.object({ decision: DecisionId }),
});

export const delegateDecisionList = listRef("delegate.decision.list", {
  kind: "decision",
  noun: "decision",
  detail: "Oldest first, revoked ones too; the filters narrow by area and by who decided.",
  filter: { area: z.string().min(1).optional(), kind: DecisionKind.optional() },
  item: { area: z.string(), kind: DecisionKind, request: RequestId, revoked: z.boolean() },
});
