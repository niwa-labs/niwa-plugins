// The targets a grant names: a repository, a pull request, a ref, and the templates a run fills.

import { expect, test } from "bun:test";

import { fillRule, grant, match } from "@niwa-labs/core";

import { RepoName, forgePipelineRetry, forgePrEnsure, forgePrMerge, forgePrRead, prRule, refRule } from "../src/records.ts";

const repo = { host: "gitlab.example.com", path: "acme/billing" };
const head = "a".repeat(40);

test("a pull request, a ref and a repository have the targets a rule names", () => {
  expect(forgePrMerge.target?.({ repo, number: 7, expectHead: head, method: "merge" })).toBe("gitlab.example.com/acme/billing/pr/7");
  expect(forgePipelineRetry.target?.({ repo, ref: "feature/login", pipeline: 3 })).toBe("gitlab.example.com/acme/billing/ref/feature/login");
  expect(forgePrRead.target?.({ repo, number: 7 })).toBe("gitlab.example.com/acme/billing");
});

test("a pull request that does not exist yet is pr/new, which a rule on every pull request covers", () => {
  const target = forgePrEnsure.target?.({ repo, branch: "topic", base: "main", title: "Topic" });
  expect(target).toBe("gitlab.example.com/acme/billing/pr/new");
  expect(match(grant(["forge.pr.ensure@gitlab.example.com/acme/billing/pr/*"]), "call", "forge.pr.ensure", target)).toBeDefined();
});

test("a template filled from the input of a run covers that repository's pull requests and no other's", () => {
  const rule = fillRule(prRule("forge.pr.merge"), { repo });
  expect(rule).toBe("forge.pr.merge@gitlab.example.com/acme/billing/pr/*");
  const rules = grant([rule]);
  const ours = forgePrMerge.target?.({ repo, number: 7, expectHead: head, method: "merge" });
  const theirs = forgePrMerge.target?.({ repo: { ...repo, path: "acme/payroll" }, number: 7, expectHead: head, method: "merge" });
  expect(match(rules, "call", "forge.pr.merge", ours, { irreversible: true })).toBeDefined();
  expect(match(rules, "call", "forge.pr.merge", theirs, { irreversible: true })).toBeUndefined();
  expect(fillRule(refRule("forge.pipeline.retry"), { repo })).toBe("forge.pipeline.retry@gitlab.example.com/acme/billing/ref/*");
});

test("a repository name cannot widen a target: no wildcard, no port, no empty segment", () => {
  expect(RepoName.safeParse({ host: "gitlab.example.com", path: "acme/*" }).success).toBe(false);
  expect(RepoName.safeParse({ host: "gitlab.example.com:8443", path: "acme/billing" }).success).toBe(false);
  expect(RepoName.safeParse({ host: "gitlab.example.com", path: "acme//billing" }).success).toBe(false);
  expect(RepoName.safeParse({ host: "gitlab.example.com", path: "billing" }).success).toBe(false);
  expect(forgePipelineRetry.input.safeParse({ repo, ref: "release/*", pipeline: 1 }).success).toBe(false);
  expect(forgePipelineRetry.input.safeParse({ repo, ref: "a//b", pipeline: 1 }).success).toBe(false);
});
