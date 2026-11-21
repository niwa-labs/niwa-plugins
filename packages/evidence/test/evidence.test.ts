// Attestations: the author the transport binds, and coverage of a merge result bound to the pair of
// commits it ran on.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { grant, principalOf } from "@niwa-labs/core";
import type { Address } from "@niwa-labs/core";
import { connect, createNiwa, connectAsOwner, tempHome } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { Attested, EvidenceRefusal, evidence, evidenceAttest, evidenceCovers, evidenceList, readAttestations } from "../src/index.ts";
import type { EvidenceOptions } from "../src/index.ts";

const sha = (word: string) => createHash("sha1").update(word).digest("hex");
const PR = "gitlab.example.com/acme/billing/pr/7";
const source = sha("head-1");
const target = sha("main-1");

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function served(options: EvidenceOptions = {}) {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(evidence(options));
  await niwa.serve();
  stops.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  const as = async (id: string, rules: string[] = []): Promise<NiwaApi> => {
    const token = niwa.issueToken(principalOf("session", id), { grant: grant(["evidence.*", ...rules]) });
    const client = await connect({ home: home.path, id: `session:${id}`, token });
    stops.push(() => client.close());
    return client;
  };
  const owner = async (): Promise<NiwaApi> => {
    const client = await connectAsOwner(home.path);
    stops.push(() => client.close());
    return client;
  };
  return { niwa, as, owner };
}

const mergeResult = (targetSha: string, pipelineKind: "merge-result" | "train" = "merge-result") => ({
  kind: "ci" as const,
  at: "merge-result" as const,
  sourceSha: source,
  targetSha,
  mergeSha: sha(`merge-${targetSha}`),
  pipeline: 501,
  pipelineKind,
});

test("the author of an attestation is the caller the transport bound, and a payload cannot name another", async () => {
  const { as, owner } = await served();
  const ci = await as("ci-runner");
  expect(await ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target) })).toMatchObject({ author: { kind: "client", id: "session:ci-runner" } });
  expect(await (await owner()).call(evidenceAttest, { subject: PR, claim: { kind: "verdict", name: "gates", outcome: "pass", sha: source } })).toMatchObject({
    author: { kind: "owner" },
  });
  await expect(ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target), author: { kind: "owner" } } as never)).rejects.toThrow();
});

test("a caller that stands for nobody cannot attest", async () => {
  const { niwa } = await served();
  await expect(niwa.call(evidenceAttest, { subject: PR, claim: mergeResult(target) })).rejects.toThrow(/author/);
});

test("a green merge result covers the pair of commits it ran on", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  const { id } = await ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target, "train") });
  const requirement = { kind: "ci" as const, at: "merge-result" as const, subject: PR, sourceSha: source, targetSha: target };
  expect(await ci.call(evidenceCovers, { requirement })).toEqual({ covered: true, by: [id] });
  expect(await ci.call(evidenceCovers, { requirement: { ...requirement, subject: `${PR}0` } })).toEqual({ covered: false, by: [], why: "none" });
});

test("a merge result stops covering when the target branch moved", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  await ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target) });
  const moved = { kind: "ci" as const, at: "merge-result" as const, subject: PR, sourceSha: source, targetSha: sha("main-2") };
  expect(await ci.call(evidenceCovers, { requirement: moved })).toEqual({ covered: false, by: [], why: "target-moved" });
});

test("an ordinary pipeline of the head is not a merge result, though it covers the head", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  const { id } = await ci.call(evidenceAttest, { subject: PR, claim: { kind: "ci", at: "head", sha: source, pipeline: 500 } });
  const merge = { kind: "ci" as const, at: "merge-result" as const, subject: PR, sourceSha: source, targetSha: target };
  expect(await ci.call(evidenceCovers, { requirement: merge })).toEqual({ covered: false, by: [], why: "not-merge-result" });
  expect(await ci.call(evidenceCovers, { requirement: { kind: "ci", at: "head", subject: PR, sha: source } })).toEqual({ covered: true, by: [id] });
});

test("a merge result cannot be attested of a pipeline kind that is not one", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  await expect(ci.call(evidenceAttest, { subject: PR, claim: { ...mergeResult(target), pipelineKind: "head" } as never })).rejects.toThrow();
});

test("a verdict covers its commit unless its author is excluded or a later one failed", async () => {
  const { as } = await served();
  const author = await as("patch-author");
  const reviewer = await as("reviewer");
  const verdict = (outcome: "pass" | "fail") => ({ subject: PR, claim: { kind: "verdict" as const, name: "gates", outcome, sha: source } });
  const requirement = { kind: "verdict" as const, subject: PR, name: "gates", sha: source, notBy: [{ kind: "client" as const, id: "session:patch-author" }] };
  await author.call(evidenceAttest, verdict("pass"));
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: false, by: [], why: "excluded-author" });
  const { id } = await reviewer.call(evidenceAttest, verdict("pass"));
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: true, by: [id] });
  await reviewer.call(evidenceAttest, verdict("fail"));
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: false, by: [], why: "failed" });
  expect(await reviewer.call(evidenceCovers, { requirement: { ...requirement, sha: sha("other") } })).toEqual({ covered: false, by: [], why: "none" });
});

test("the attestations of a subject are listed with their authors", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  await ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target) });
  await ci.call(evidenceAttest, { subject: "plan/rev-1/node-1", claim: { kind: "verdict", name: "go", outcome: "pass", sha: source } });
  const { items } = await ci.call(evidenceList, { subject: PR });
  expect(items).toEqual([expect.objectContaining({ subject: PR, author: { kind: "client", id: "session:ci-runner" } })]);
});

const verdictClaim = (outcome: "pass" | "fail") => ({ kind: "verdict" as const, name: "gates", outcome, sha: source });

test("an attestation written straight to the journal is attributed to the caller the host recorded, not to its payload", async () => {
  const { as } = await served();
  const forger = await as("forger", ["emit:evidence.attested"]);
  const reviewer = await as("reviewer");
  const claim = verdictClaim("pass");
  await forger.emit(Attested, { subject: PR, claim, author: { kind: "client", id: "session:reviewer" } });
  const requirement = { kind: "verdict" as const, subject: PR, name: "gates", sha: source };
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: false, by: [], why: "none" });
  expect((await reviewer.call(evidenceList, {})).items).toEqual([]);
  // The same write, naming its true author, is an attestation like any other.
  const honest = await forger.emit(Attested, { subject: PR, claim, author: { kind: "client", id: "session:forger" } });
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: true, by: [honest.id] });
});

test("a merge result of an earlier pipeline does not cover once another pipeline is the selected one", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  const { id } = await ci.call(evidenceAttest, { subject: PR, claim: mergeResult(target) });
  await ci.call(evidenceAttest, { subject: PR, claim: { kind: "ci", at: "head", sha: source, pipeline: 502 } });
  const requirement = { kind: "ci" as const, at: "merge-result" as const, subject: PR, sourceSha: source, targetSha: target };
  expect(await ci.call(evidenceCovers, { requirement: { ...requirement, pipeline: 502 } })).toEqual({ covered: false, by: [], why: "not-merge-result" });
  expect(await ci.call(evidenceCovers, { requirement: { ...requirement, pipeline: 501 } })).toEqual({ covered: true, by: [id] });
  expect(await ci.call(evidenceCovers, { requirement: { ...requirement, pipeline: 503 } })).toEqual({ covered: false, by: [], why: "none" });
  expect(await ci.call(evidenceCovers, { requirement: { ...requirement, targetSha: sha("main-2"), pipeline: 501 } })).toEqual({ covered: false, by: [], why: "target-moved" });
});

test("a verdict names only the passing verdict that stands, not one a later failure superseded", async () => {
  const { as } = await served();
  const reviewer = await as("reviewer");
  await reviewer.call(evidenceAttest, { subject: PR, claim: verdictClaim("pass") });
  await reviewer.call(evidenceAttest, { subject: PR, claim: verdictClaim("fail") });
  const { id } = await reviewer.call(evidenceAttest, { subject: PR, claim: verdictClaim("pass") });
  const requirement = { kind: "verdict" as const, subject: PR, name: "gates", sha: source };
  expect(await reviewer.call(evidenceCovers, { requirement })).toEqual({ covered: true, by: [id] });
});

test("an excluded author is compared as a structured address, not as its display text", async () => {
  // Both sessions read "session a/b/c" as text.
  const bySession = (caller: { kind: string; principal?: { id: string } }): Address | undefined => {
    if (caller.kind !== "client" || caller.principal === undefined) return undefined;
    const [harness = "", id = ""] = caller.principal.id.split("|");
    return { kind: "session", harness, id };
  };
  const { as } = await served({ bind: bySession });
  const wrong = await as("a/b|c");
  const right = await as("a|b/c");
  const { id } = await right.call(evidenceAttest, { subject: PR, claim: verdictClaim("pass") });
  const requirement = {
    kind: "verdict" as const,
    subject: PR,
    name: "gates",
    sha: source,
    notBy: [{ kind: "session" as const, harness: "a/b", id: "c" }],
  };
  expect(await wrong.call(evidenceCovers, { requirement })).toEqual({ covered: true, by: [id] });
});

test("an author bound by the composition stays excluded when its session is relaunched under a new token", async () => {
  const bySession = (caller: { kind: string; principal?: { id: string } }): Address | undefined =>
    caller.kind === "client" && caller.principal !== undefined ? { kind: "session", harness: "claude", id: caller.principal.id.split("@")[0] ?? "" } : undefined;
  const { as } = await served({ bind: bySession });
  const author = await as("patch-author@launch-1");
  await author.call(evidenceAttest, { subject: PR, claim: verdictClaim("pass") });
  const relaunched = await as("patch-author@launch-2");
  const requirement = { kind: "verdict" as const, subject: PR, name: "gates", sha: source, notBy: [{ kind: "session" as const, harness: "claude", id: "patch-author" }] };
  await relaunched.call(evidenceAttest, { subject: PR, claim: verdictClaim("pass") });
  expect(await relaunched.call(evidenceCovers, { requirement })).toEqual({ covered: false, by: [], why: "excluded-author" });
});

test("a read with no journal is refused rather than answered as empty", () => {
  expect(() => readAttestations(undefined, () => undefined, {})).toThrow(EvidenceRefusal);
  expect(() => readAttestations(undefined, () => undefined, {})).toThrow(/journal/);
});

test("a commit id is exactly 40 or 64 hex characters, and a verdict name has one bound for a claim and a requirement", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  const claim = (at: string) => ({ kind: "verdict" as const, name: "gates", outcome: "pass" as const, sha: at });
  await expect(ci.call(evidenceAttest, { subject: PR, claim: claim("a".repeat(41)) })).rejects.toThrow();
  await expect(ci.call(evidenceAttest, { subject: PR, claim: claim("a".repeat(64)) })).resolves.toBeDefined();
  const name = "n".repeat(101);
  await expect(ci.call(evidenceCovers, { requirement: { kind: "verdict", subject: PR, name, sha: source } })).rejects.toThrow();
});

test("the attestations are listed a page at a time, in the order they were written", async () => {
  const { as } = await served();
  const ci = await as("ci-runner");
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) ids.push((await ci.call(evidenceAttest, { subject: index % 2 === 0 ? PR : "plan/x", claim: { kind: "ci", at: "head", sha: source, pipeline: index + 1 } })).id);
  const first = await ci.call(evidenceList, { limit: 2 });
  expect(first.items.map((one) => one.id)).toEqual(ids.slice(0, 2));
  expect(first.next).toBeDefined();
  const second = await ci.call(evidenceList, { limit: 2, after: first.next });
  expect(second.items.map((one) => one.id)).toEqual(ids.slice(2, 4));
  const last = await ci.call(evidenceList, { limit: 2, after: second.next });
  expect(last.items.map((one) => one.id)).toEqual(ids.slice(4));
  expect(last.next).toBeUndefined();
  const mine = await ci.call(evidenceList, { subject: PR, limit: 2 });
  expect(mine.items.map((one) => one.id)).toEqual(ids.filter((_, index) => index === 0 || index === 2));
  expect(mine.next).toBeDefined();
  expect((await ci.call(evidenceList, { subject: PR, limit: 2, after: mine.next })).items.map((one) => one.id)).toEqual(ids.slice(4));
});
