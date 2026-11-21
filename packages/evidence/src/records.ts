/**
 * The records entry of the evidence module: an attestation, what it may claim, the requirements it
 * may cover, and the typed references to the actions.
 *
 * An attestation says that something was shown about a subject (a pull request, a plan node) at a
 * precise state of the code. Its author is whoever the transport says called, never a field of the
 * payload. A requirement is covered only by an attestation of the same state: a green merge result
 * covers a merge only for the pair of commits it ran on, so a target branch that moved since, or an
 * ordinary pipeline of the head in place of a merge result, covers nothing.
 *
 * The names of the commits follow those of the forge module's pipelines (`sourceSha`, `targetSha`,
 * `mergeSha`, `pipeline`), so a pipeline record can be attested as it is.
 */

import { Address, actionRef, queryOf, record } from "@niwa-labs/core";
import type { TypeQuery } from "@niwa-labs/core";
import { z } from "zod";

/** A full commit id: a SHA-1 (40 hex characters) or a SHA-256 (64) object id. */
export const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit id");

/** The name of a check (`gates`, `live`), the same for a verdict and for a requirement of one. */
export const VerdictName = z.string().min(1).max(100);

/** What an attestation is about: `gitlab.example.com/acme/billing/pr/7`, `plan/rev-3/node-2`. */
export const Subject = z.string().min(1).max(512);

/** A green pipeline of a merge result or a merge train: the merge of `sourceSha` into `targetSha`. */
export const MergeResultClaim = z.strictObject({
  kind: z.literal("ci"),
  at: z.literal("merge-result"),
  sourceSha: Sha,
  targetSha: Sha,
  mergeSha: Sha,
  pipeline: z.number().int().positive(),
  pipelineKind: z.enum(["merge-result", "train"]),
});

/** A green pipeline of a head, alone. */
export const HeadClaim = z.strictObject({
  kind: z.literal("ci"),
  at: z.literal("head"),
  sha: Sha,
  pipeline: z.number().int().positive(),
});

/** A verdict of a named check (`gates`, `live`) on a commit. */
export const VerdictClaim = z.strictObject({
  kind: z.literal("verdict"),
  name: VerdictName,
  outcome: z.enum(["pass", "fail"]),
  sha: Sha,
});

/** What an attestation claims. */
export const Claim = z.union([MergeResultClaim, HeadClaim, VerdictClaim]);
export type Claim = z.infer<typeof Claim>;

/** Something was attested. The author is the caller's address, as the transport bound it. */
export const Attested = record(
  "evidence.attested",
  z.strictObject({ subject: Subject, claim: Claim, author: Address }),
);
export type AttestedData = z.infer<typeof Attested.schema>;

/**
 * The attestations about one subject, as a script waits for or reads them with their data typed:
 * `await wait(attested(subject), { timeout: "1h" })`.
 */
export function attested(subject: string): TypeQuery<AttestedData> {
  return queryOf(Attested, { subject: Subject.parse(subject) });
}

/** A requirement an attestation may cover. */
export const Requirement = z.union([
  /**
   * A green merge result of exactly this pair of commits. `pipeline` is the pipeline the forge selected
   * for the merge request now: when it is given, only an attestation of that pipeline counts, so an
   * earlier merge result does not cover a merge request whose selected pipeline is an ordinary one.
   */
  z.strictObject({
    kind: z.literal("ci"),
    at: z.literal("merge-result"),
    subject: Subject,
    sourceSha: Sha,
    targetSha: Sha,
    pipeline: z.number().int().positive().optional(),
  }),
  /** A green pipeline of this head. */
  z.strictObject({ kind: z.literal("ci"), at: z.literal("head"), subject: Subject, sha: Sha }),
  /** A passing verdict of this name on this commit, from none of `notBy`. */
  z.strictObject({ kind: z.literal("verdict"), subject: Subject, name: VerdictName, sha: Sha, notBy: z.array(Address).optional() }),
]);
export type Requirement = z.infer<typeof Requirement>;

/**
 * Why a requirement is not covered: nothing was attested; the merge result ran on another target
 * commit (the target branch moved); only an ordinary pipeline of the head ran; the verdict failed;
 * every passing verdict is by an author the requirement excludes.
 */
export const Uncovered = z.enum(["none", "target-moved", "not-merge-result", "failed", "excluded-author"]);
export type Uncovered = z.infer<typeof Uncovered>;

/** One attestation, as the module lists it. */
export const Attestation = z.strictObject({ id: z.string(), seq: z.number().int().nonnegative(), subject: Subject, claim: Claim, author: Address, at: z.number() });
export type Attestation = z.infer<typeof Attestation>;

export const evidenceAttest = actionRef("evidence.attest", {
  description:
    "Attest something about a subject at a precise state of the code: a green merge result of a pair of commits, a green " +
    "pipeline of a head, a verdict of a named check on a commit. The author is the caller, as the connection says; it is not " +
    "given. Answers the attestation's id.",
  input: z.strictObject({ subject: Subject, claim: Claim }),
  output: z.strictObject({ id: z.string(), author: Address }),
});

export const evidenceCovers = actionRef("evidence.covers", {
  description:
    "Whether a requirement is covered by an attestation of the same state, and by which. A merge result covers only the pair " +
    "of commits it ran on: when the target branch moved, or GitLab ran an ordinary pipeline of the head instead of a merge " +
    "result, it is not covered and `why` says so. Give the `pipeline` the forge selected for the merge request to hold the " +
    "requirement to that pipeline alone. A read that cannot reach the journal is refused, not answered as `none`.",
  input: z.strictObject({ requirement: Requirement }),
  output: z.strictObject({ covered: z.boolean(), by: z.array(z.string()), why: Uncovered.optional() }),
});

export const evidenceList = actionRef("evidence.list", {
  description:
    "The attestations of a subject, or every attestation, in the order they were written, a page at a time: `limit` of them " +
    "(default 100) after the position `after`. `next` is the `after` of the following page, and is absent on the last one.",
  input: z.strictObject({ subject: Subject.optional(), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() }),
  output: z.strictObject({ items: z.array(Attestation), next: z.number().int().nonnegative().optional() }),
});

/** Every record type of the evidence module. */
export const EVIDENCE_TYPES = [Attested] as const;
