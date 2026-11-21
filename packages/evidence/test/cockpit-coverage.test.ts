// The evidence page: what an attestation says, the requirement it stands for, and the form that asks about one.

import { expect, test } from "bun:test";

import { evidenceCovers } from "../src/records.ts";
import type { Attestation } from "../src/cockpit/actions.ts";
import { EMPTY_FORM, bySubject, claimText, requirementFromForm, requirementKey, requirementOf, shortSha, who } from "../src/cockpit/coverage.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const OWNER = { kind: "owner" };

const merge = (subject: string, at: number): Attestation => ({
  id: `e-${String(at)}`,
  subject,
  at,
  author: OWNER,
  claim: { kind: "ci", at: "merge-result", sourceSha: A, targetSha: B, mergeSha: C, pipeline: 12, pipelineKind: "merge-result" },
});

test("a claim reads as a sentence with short commit ids", () => {
  expect(shortSha(A)).toBe("aaaaaaaa");
  expect(claimText(merge("pr", 1).claim)).toBe("Pipeline 12 is green as a merge result: aaaaaaaa into bbbbbbbb");
  expect(claimText({ kind: "ci", at: "head", sha: A, pipeline: 3 })).toBe("Pipeline 3 of aaaaaaaa is green");
  expect(claimText({ kind: "verdict", name: "gates", outcome: "fail", sha: A })).toBe("gates failed on aaaaaaaa");
  expect(claimText({ kind: "ci", at: "merge-result", sourceSha: A, targetSha: B, mergeSha: C, pipeline: 4, pipelineKind: "train" })).toContain("merge train");
});

test("an author is named by its kind and what it names", () => {
  expect(who(OWNER)).toBe("owner");
  expect(who({ kind: "client", id: "session:reviewer" })).toBe("client session:reviewer");
  expect(who({ kind: "session", harness: "claude", id: "abc" })).toBe("session claude/abc");
});

test("subjects are listed by their latest attestation, and each subject's latest first", () => {
  const groups = bySubject([merge("old", 1), merge("new", 5), merge("old", 3), merge("mid", 4)]);
  expect(groups.map((group) => group.subject)).toEqual(["new", "mid", "old"]);
  expect(groups[2]?.attestations.map((one) => one.at)).toEqual([3, 1]);
});

test("an attestation stands for the requirement it would cover, and equal ones share a key", () => {
  expect(requirementOf(merge("pr", 1))).toEqual({ kind: "ci", at: "merge-result", subject: "pr", sourceSha: A, targetSha: B });
  expect(requirementOf({ subject: "pr", claim: { kind: "ci", at: "head", sha: A, pipeline: 1 } })).toEqual({ kind: "ci", at: "head", subject: "pr", sha: A });
  expect(requirementOf({ subject: "pr", claim: { kind: "verdict", name: "gates", outcome: "pass", sha: A } })).toEqual({ kind: "verdict", subject: "pr", name: "gates", sha: A });
  expect(requirementKey(requirementOf(merge("pr", 1)))).toBe(requirementKey(requirementOf(merge("pr", 9))));
  expect(requirementKey(requirementOf(merge("pr", 1)))).not.toBe(requirementKey(requirementOf(merge("other", 1))));
});

test("every requirement the page builds is one the host takes", () => {
  const requirements = [
    requirementOf(merge("pr", 1)),
    requirementOf({ subject: "pr", claim: { kind: "ci", at: "head", sha: A, pipeline: 1 } }),
    requirementOf({ subject: "pr", claim: { kind: "verdict", name: "gates", outcome: "pass", sha: A } }),
  ];
  const fromForms = [
    requirementFromForm({ kind: "merge-result", subject: "pr", sha: A, targetSha: B, name: "" }),
    requirementFromForm({ kind: "head", subject: "pr", sha: A, targetSha: "", name: "" }),
    requirementFromForm({ kind: "verdict", subject: "pr", sha: A, targetSha: "", name: "gates" }),
  ].map((one) => ("requirement" in one ? one.requirement : undefined));
  for (const requirement of [...requirements, ...fromForms]) {
    expect(requirement).toBeDefined();
    expect(evidenceCovers.input.safeParse({ requirement }).success).toBe(true);
  }
});

test("the form refuses what the host would refuse, and says what is wrong", () => {
  expect(requirementFromForm(EMPTY_FORM)).toEqual({ problem: "Name the subject, such as gitlab.example.com/acme/billing/pr/7." });
  expect(requirementFromForm({ ...EMPTY_FORM, subject: "pr", sha: "abc123" })).toEqual({ problem: "The source commit must be a full commit id." });
  expect(requirementFromForm({ ...EMPTY_FORM, kind: "head", subject: "pr", sha: "abc123" })).toEqual({ problem: "The commit must be a full commit id." });
  expect(requirementFromForm({ ...EMPTY_FORM, subject: "pr", sha: A, targetSha: "nope" })).toEqual({ problem: "The target commit must be a full commit id." });
  expect(requirementFromForm({ ...EMPTY_FORM, kind: "verdict", subject: "pr", sha: A })).toEqual({ problem: "Name the check, such as gates." });
  expect(requirementFromForm({ ...EMPTY_FORM, subject: "x".repeat(513), sha: A, targetSha: B })).toEqual({ problem: "A subject is at most 512 characters." });
});

test("the form trims what is typed and reads commit ids in lower case", () => {
  expect(requirementFromForm({ kind: "head", subject: "  pr  ", sha: ` ${A.toUpperCase()} `, targetSha: "", name: "" })).toEqual({
    requirement: { kind: "ci", at: "head", subject: "pr", sha: A },
  });
});

test("the form takes the commit ids the host takes and no others", () => {
  for (const length of [39, 40, 41, 63, 64, 65]) {
    const id = "d".repeat(length);
    const built = requirementFromForm({ kind: "merge-result", subject: "pr", sha: id, targetSha: id, name: "" });
    const taken = "requirement" in built && evidenceCovers.input.safeParse({ requirement: built.requirement }).success;
    expect([length, "requirement" in built]).toEqual([length, taken]);
  }
});
