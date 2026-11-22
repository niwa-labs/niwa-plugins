// The forge page: how pull requests and pipelines are named and grouped, and which merges the page may call off.

import { expect, test } from "bun:test";

import type { ObservedPr, PendingMerge, PrPipeline, PrRef } from "../src/cockpit/actions.ts";
import { armedBy, byRepo, cancelInput, pipelineText, prKey, prLabel, repoLabel } from "../src/cockpit/pulls.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const ref = (path: string, projectId: number, number: number): PrRef => ({ repo: { host: "gitlab.example.com", path, projectId }, number });

const entry = (pr: PrRef): ObservedPr => ({ pr, state: "open", title: "t", branch: "topic", base: "main", draft: false, checks: "none", pipelines: [] });

const pending = (pr: PrRef, action = "forge.pr.merge.cancel"): PendingMerge => ({
  pr,
  mode: "auto-merge",
  externalId: `${pr.repo.host}/${pr.repo.path}!${String(pr.number)}`,
  expectHead: A,
  cancel: { action, input: { repo: { host: pr.repo.host, path: pr.repo.path }, number: pr.number } },
});

test("a pull request is named as the server names it", () => {
  expect(prLabel(ref("acme/billing", 42, 7))).toBe("acme/billing!7");
  expect(repoLabel({ host: "gitlab.example.com", path: "acme/billing" })).toBe("gitlab.example.com/acme/billing");
});

test("a renamed project keeps its pull requests apart from another project's of the same number", () => {
  expect(prKey(ref("acme/billing", 42, 7))).toBe(prKey(ref("acme/invoicing", 42, 7)));
  expect(prKey(ref("acme/billing", 42, 7))).not.toBe(prKey(ref("acme/billing", 43, 7)));
});

test("a pipeline is told by its number, what it ran on, and for a merge result the pair of commits", () => {
  const head: PrPipeline = { pipeline: 5, kind: "head", state: "running", sourceSha: A };
  expect(pipelineText(head)).toBe("#5 коммит aaaaaaaa");
  expect(pipelineText({ pipeline: 6, kind: "merge-result", state: "success", sourceSha: A, targetSha: B, mergeSha: A })).toBe("#6 результат слияния aaaaaaaa → bbbbbbbb");
  expect(pipelineText({ pipeline: 7, kind: "train", state: "success", sourceSha: A, targetSha: B })).toBe("#7 очередь слияния aaaaaaaa → bbbbbbbb");
});

test("pull requests are grouped by project and keep the order they came in", () => {
  const groups = byRepo([entry(ref("acme/billing", 42, 9)), entry(ref("acme/payroll", 43, 1)), entry(ref("acme/billing", 42, 7))]);
  expect(groups.map((group) => [group.repo.path, group.prs.map((one) => one.pr.number)])).toEqual([
    ["acme/billing", [9, 7]],
    ["acme/payroll", [1]],
  ]);
});

test("the merges the server holds are found by the pull request they are for", () => {
  const held = pending(ref("acme/billing", 42, 7));
  const map = armedBy([held]);
  expect(map.get(prKey(ref("acme/billing", 42, 7)))).toBe(held);
  expect(map.get(prKey(ref("acme/billing", 42, 8)))).toBeUndefined();
});

test("a merge is called off with the host's own input, and only through the action the page knows", () => {
  expect(cancelInput(pending(ref("acme/billing", 42, 7)))).toEqual({ repo: { host: "gitlab.example.com", path: "acme/billing" }, number: 7 });
  expect(cancelInput(pending(ref("acme/billing", 42, 7), "forge.pr.merge.dequeue"))).toBeUndefined();
});
