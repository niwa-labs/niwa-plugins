/**
 * The evidence actions as the cockpit calls them: name and the part of each schema the page reads.
 *
 * The module runs in the browser and cannot import the host-side schemas, which reach for Node. A field the host
 * stopped sending fails the page that reads it, which `test/cockpit-actions.test.ts` checks against the real actions.
 */

import { z } from "zod";

export const Address = z.object({ kind: z.string(), id: z.string().optional(), harness: z.string().optional() }).loose();
export type Address = z.infer<typeof Address>;

const MergeResultClaim = z.object({
  kind: z.literal("ci"),
  at: z.literal("merge-result"),
  sourceSha: z.string(),
  targetSha: z.string(),
  mergeSha: z.string(),
  pipeline: z.number(),
  pipelineKind: z.enum(["merge-result", "train"]),
});
const HeadClaim = z.object({ kind: z.literal("ci"), at: z.literal("head"), sha: z.string(), pipeline: z.number() });
const VerdictClaim = z.object({ kind: z.literal("verdict"), name: z.string(), outcome: z.enum(["pass", "fail"]), sha: z.string() });

export const Claim = z.union([MergeResultClaim, HeadClaim, VerdictClaim]);
export type Claim = z.infer<typeof Claim>;

export const Attestation = z.object({ id: z.string(), subject: z.string(), claim: Claim, author: Address, at: z.number() });
export type Attestation = z.infer<typeof Attestation>;

export const listAction = {
  name: "evidence.list",
  input: z.object({ subject: z.string().optional() }),
  output: z.object({ items: z.array(Attestation) }),
} as const;

export const Uncovered = z.enum(["none", "target-moved", "not-merge-result", "failed", "excluded-author"]);
export type Uncovered = z.infer<typeof Uncovered>;

export const Requirement = z.union([
  z.object({ kind: z.literal("ci"), at: z.literal("merge-result"), subject: z.string(), sourceSha: z.string(), targetSha: z.string() }),
  z.object({ kind: z.literal("ci"), at: z.literal("head"), subject: z.string(), sha: z.string() }),
  z.object({ kind: z.literal("verdict"), subject: z.string(), name: z.string(), sha: z.string() }),
]);
export type Requirement = z.infer<typeof Requirement>;

export const coversAction = {
  name: "evidence.covers",
  input: z.object({ requirement: Requirement }),
  output: z.object({ covered: z.boolean(), by: z.array(z.string()), why: Uncovered.optional() }),
} as const;
