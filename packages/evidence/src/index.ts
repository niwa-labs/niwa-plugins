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
 *
 * An attestation counts only when the caller the host recorded for it is the author it names, so a
 * principal allowed to write the record type cannot put another's name on it. Reads take the journal by
 * subject, and a list is paged.
 */

import { CatchableError, action, seq, stableJson } from "@niwa-labs/core";
import type { Address, Caller, JournalReader, StoredRecord } from "@niwa-labs/core";
import { bindingOf, plugin } from "@niwa-labs/plugin";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";

import { Attested, EVIDENCE_TYPES, evidenceAttest, evidenceCovers, evidenceList } from "./records.ts";
import type { Attestation, Requirement, Uncovered } from "./records.ts";

export * from "./records.ts";

/** Why an attestation was not written, or a read was not answered. */
export type EvidenceRefusalCode = "no-author" | "journal-unavailable";

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
  /**
   * The address a caller attests as. Default: `principalBinding`.
   *
   * It must be a function of the caller alone: coverage binds the recorded caller of every attestation
   * again when it reads it, and an attestation whose author the binding no longer gives is not counted.
   * A composition that excludes an author by session or agent (`notBy`) supplies a binding that gives
   * that address, so the exclusion holds when the session is relaunched under a new token.
   */
  readonly bind?: CallerBinding;
}

/**
 * The default binding of an author: the principal of the connection's token, which stays the same
 * across the connections of that token but not across a new one (a session relaunched under a new
 * token is another client here). The owner attests as the owner; another principal as the client
 * `<kind>:<id>` (`session:reviewer`, `run:r-12`); a connection with no principal as itself. The host
 * and a handler stand for nobody.
 */
export const principalBinding: CallerBinding = (caller) => {
  if (caller.kind !== "client") return undefined;
  if (caller.principal === undefined) return bindingOf()(caller);
  if (caller.principal.kind === "owner") return { kind: "owner" };
  return { kind: "client", id: `${caller.principal.kind}:${caller.principal.id}` };
};

/** How many attestations a read of the journal takes at a time. */
const BATCH = 500;

/** The default size of a page of `evidence.list`. */
const PAGE = 100;

/**
 * Whether the host-recorded writer of a record stands behind the author in its payload. A client wrote
 * as the address the binding gives it, so a payload that names another author is not its own. The host
 * and a handler (a workflow run attesting through its call) have no principal in the record to check.
 */
function writtenBy(actor: Caller, author: Address, bind: CallerBinding): boolean {
  if (actor.kind !== "client") return true;
  const bound = bind(actor);
  return bound !== undefined && stableJson(bound) === stableJson(author);
}

function attestationOf(stored: StoredRecord, bind: CallerBinding): Attestation | undefined {
  const parsed = Attested.schema.safeParse(stored.data);
  if (!parsed.success || !writtenBy(stored.actor, parsed.data.author, bind)) return undefined;
  return { id: stored.id, seq: stored.seq, at: stored.at, ...parsed.data };
}

/** What a read of the attestations asks for. */
export interface AttestationQuery {
  /** Only this subject's. */
  readonly subject?: string;
  /** Only those written after this position. */
  readonly after?: number;
  /** At most this many. */
  readonly limit?: number;
}

/**
 * The attestations of the journal in the order they were written, the ones a caller really wrote. A
 * subject is read by its key, so the history of other subjects is neither loaded nor parsed. With a
 * `limit`, `next` is the position to go on after when the page is full. A journal that is not there
 * is an error: an empty history is an answer only of a journal that was read.
 */
export function readAttestations(
  journal: JournalReader | undefined,
  bind: CallerBinding,
  query: AttestationQuery,
): { items: Attestation[]; next?: number } {
  if (journal === undefined) throw new EvidenceRefusal("journal-unavailable", "the journal cannot be read now, so nothing can be said about what was attested");
  const items: Attestation[] = [];
  let cursor = query.after ?? 0;
  for (;;) {
    const rows =
      query.subject === undefined
        ? journal.since(seq(cursor), [Attested.name], BATCH)
        : journal.find({ type: Attested.name, field: "subject", equals: query.subject, after: seq(cursor) });
    for (const row of rows) {
      cursor = row.seq;
      const one = attestationOf(row, bind);
      if (one === undefined) continue;
      items.push(one);
      if (query.limit !== undefined && items.length === query.limit) return { items, next: row.seq };
    }
    if (query.subject !== undefined || rows.length < BATCH) return { items };
  }
}

/** Whether the requirement is covered by these attestations of its subject, and by which. */
export function coverage(all: readonly Attestation[], requirement: Requirement): { covered: boolean; by: string[]; why?: Uncovered } {
  const selected = (pipeline: number) => requirement.kind !== "ci" || requirement.at !== "merge-result" || requirement.pipeline === undefined || requirement.pipeline === pipeline;
  const mine = all.filter((one) => one.subject === requirement.subject);
  const no = (why: Uncovered) => ({ covered: false, by: [], why });
  if (requirement.kind === "ci" && requirement.at === "merge-result") {
    const results = mine.flatMap((one) => (one.claim.kind === "ci" && one.claim.at === "merge-result" && one.claim.sourceSha === requirement.sourceSha && selected(one.claim.pipeline) ? [{ one, claim: one.claim }] : []));
    const exact = results.filter(({ claim }) => claim.targetSha === requirement.targetSha);
    if (exact.length > 0) return { covered: true, by: exact.map(({ one }) => one.id) };
    if (results.length > 0) return no("target-moved");
    const head = mine.some((one) => one.claim.kind === "ci" && one.claim.at === "head" && one.claim.sha === requirement.sourceSha && selected(one.claim.pipeline));
    return no(head ? "not-merge-result" : "none");
  }
  if (requirement.kind === "ci") {
    const heads = mine.filter((one) => one.claim.kind === "ci" && one.claim.at === "head" && one.claim.sha === requirement.sha);
    return heads.length > 0 ? { covered: true, by: heads.map((one) => one.id) } : no("none");
  }
  const verdicts = mine.flatMap((one) => (one.claim.kind === "verdict" && one.claim.name === requirement.name && one.claim.sha === requirement.sha ? [{ one, claim: one.claim }] : []));
  if (verdicts.length === 0) return no("none");
  const excluded = new Set((requirement.notBy ?? []).map((address) => stableJson(address)));
  const allowed = verdicts.filter(({ one }) => !excluded.has(stableJson(one.author)));
  if (allowed.length === 0) return no("excluded-author");
  const last = allowed.at(-1);
  if (last === undefined || last.claim.outcome === "fail") return no("failed");
  return { covered: true, by: [last.one.id] };
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
        run: (input) => coverage(readAttestations(journal(), bind, { subject: input.requirement.subject }).items, input.requirement),
      }),
    );

    api.action(
      action(evidenceList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) =>
          readAttestations(journal(), bind, {
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.after === undefined ? {} : { after: input.after }),
            limit: input.limit ?? PAGE,
          }),
      }),
    );
  });
}
