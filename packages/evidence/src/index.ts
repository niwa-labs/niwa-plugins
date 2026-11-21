/**
 * The evidence module: attestations and what they cover.
 *
 * `evidence.attest` writes one attestation, with the caller as its author: the transport binds who
 * called (`bind`, by default a client speaks as itself and the owner as the owner), and a caller that
 * stands for nobody (the host, a handler with no address) cannot attest. `evidence.covers` answers
 * whether a requirement is covered, from the attestations alone, and why not when it is not.
 *
 * Coverage is exact: a merge result covers the pair of commits it ran on and no other, so a target
 * branch that moved makes it stale; an ordinary pipeline of the head is not a merge result; a verdict
 * covers the commit it was given on, and not when every passing one is by an author the requirement
 * excludes (the author of the patch, for one) or a later one failed.
 */

import { CatchableError, action, addressText, seq } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";

import { Attested, EVIDENCE_TYPES, evidenceAttest, evidenceCovers, evidenceList } from "./records.ts";
import type { Attestation, Requirement, Uncovered } from "./records.ts";

export * from "./records.ts";

/** Why an attestation was not written. */
export type EvidenceRefusalCode = "no-author";

/** A refusal of the evidence module: the caller's to catch. */
export class EvidenceRefusal extends CatchableError {
  override name = "EvidenceRefusal";
  override readonly code: EvidenceRefusalCode;

  constructor(code: EvidenceRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the evidence module is given. */
export interface EvidenceOptions {
  /** The address a caller attests as. Default: `principalBinding`. */
  readonly bind?: CallerBinding;
}

/**
 * The default binding of an author: the principal of the connection's token, which stays the same
 * across its connections. The owner attests as the owner; another principal as the client
 * `<kind>:<id>` (`session:reviewer`, `run:r-12`); a connection with no principal as itself. The host
 * and a handler stand for nobody.
 */
export const principalBinding: CallerBinding = (caller) => {
  if (caller.kind !== "client") return undefined;
  if (caller.principal === undefined) return bindingOf()(caller);
  if (caller.principal.kind === "owner") return { kind: "owner" };
  return { kind: "client", id: `${caller.principal.kind}:${caller.principal.id}` };
};

/** The attestations of the journal, oldest first. */
function attestations(journal: JournalReader | undefined): Attestation[] {
  if (journal === undefined) return [];
  return journal.since(seq(0), [Attested.name]).flatMap((stored) => {
    const parsed = Attested.schema.safeParse(stored.data);
    return parsed.success ? [{ id: stored.id, at: stored.at, ...parsed.data }] : [];
  });
}

/** Whether the requirement is covered by these attestations of its subject, and by which. */
export function coverage(all: readonly Attestation[], requirement: Requirement): { covered: boolean; by: string[]; why?: Uncovered } {
  const mine = all.filter((one) => one.subject === requirement.subject);
  const no = (why: Uncovered) => ({ covered: false, by: [], why });
  if (requirement.kind === "ci" && requirement.at === "merge-result") {
    const results = mine.flatMap((one) => (one.claim.kind === "ci" && one.claim.at === "merge-result" && one.claim.sourceSha === requirement.sourceSha ? [{ one, claim: one.claim }] : []));
    const exact = results.filter(({ claim }) => claim.targetSha === requirement.targetSha);
    if (exact.length > 0) return { covered: true, by: exact.map(({ one }) => one.id) };
    if (results.length > 0) return no("target-moved");
    const head = mine.some((one) => one.claim.kind === "ci" && one.claim.at === "head" && one.claim.sha === requirement.sourceSha);
    return no(head ? "not-merge-result" : "none");
  }
  if (requirement.kind === "ci") {
    const heads = mine.filter((one) => one.claim.kind === "ci" && one.claim.at === "head" && one.claim.sha === requirement.sha);
    return heads.length > 0 ? { covered: true, by: heads.map((one) => one.id) } : no("none");
  }
  const verdicts = mine.flatMap((one) => (one.claim.kind === "verdict" && one.claim.name === requirement.name && one.claim.sha === requirement.sha ? [{ one, claim: one.claim }] : []));
  if (verdicts.length === 0) return no("none");
  const excluded = new Set((requirement.notBy ?? []).map(addressText));
  const allowed = verdicts.filter(({ one }) => !excluded.has(addressText(one.author)));
  if (allowed.length === 0) return no("excluded-author");
  const last = allowed.at(-1);
  if (last === undefined || last.claim.outcome === "fail") return no("failed");
  return { covered: true, by: allowed.filter(({ claim }) => claim.outcome === "pass").map(({ one }) => one.id) };
}

/** The evidence module. */
export function evidence(options: EvidenceOptions = {}): Plugin {
  const bind = options.bind ?? principalBinding;

  return plugin("evidence", (api) => {
    api.declare(...EVIDENCE_TYPES);
    const journal = (): JournalReader | undefined => api.journal?.();

    api.action(
      action(evidenceAttest, {
        // The record follows the operation, so a repeat answers the attestation it wrote.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        async run(input, ctx) {
          const author = bind(ctx.caller);
          if (author === undefined) throw new EvidenceRefusal("no-author", "an attestation needs an author, and this caller speaks for nobody");
          const stored = await ctx.emit(Attested, { subject: input.subject, claim: input.claim, author });
          return { id: stored.id, author };
        },
      }),
    );

    api.action(
      action(evidenceCovers, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => coverage(attestations(journal()), input.requirement),
      }),
    );

    api.action(
      action(evidenceList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => ({ items: attestations(journal()).filter((one) => input.subject === undefined || one.subject === input.subject) }),
      }),
    );
  });
}
