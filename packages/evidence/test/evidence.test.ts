// Attestations: the author the transport binds, and coverage of a merge result bound to the pair of
// commits it ran on.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { grant, principalOf } from "@niwa-labs/core";
import { connect, createNiwa, connectAsOwner, tempHome } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { evidence, evidenceAttest, evidenceCovers, evidenceList } from "../src/index.ts";

const sha = (word: string) => createHash("sha1").update(word).digest("hex");
const PR = "gitlab.example.com/acme/billing/pr/7";
const source = sha("head-1");
const target = sha("main-1");

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function served() {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(evidence());
  await niwa.serve();
  stops.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  const as = async (id: string): Promise<NiwaApi> => {
    const token = niwa.issueToken(principalOf("session", id), { grant: grant(["evidence.*"]) });
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
