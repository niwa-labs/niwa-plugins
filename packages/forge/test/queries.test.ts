// The query builders of the forge records: the records of one pull request, commit or repository, as
// a script waits for them, a reader reads them and a handler subscribes to them. A filter is held to
// the data the record's own schema gives, so a path that names no field of it cannot pass.

import { expect, test } from "bun:test";

import { resolveQuery } from "@niwa-labs/core";
import type { TypeQuery } from "@niwa-labs/core";

import {
  ChecksObserved,
  JobObserved,
  MergeArmed,
  MergeDisarmed,
  MergeSettled,
  PipelineObserved,
  PrClosed,
  PrComment,
  PrHead,
  PrMerged,
  PrOpened,
  PrReview,
  PrUpdated,
  Pushed,
} from "../src/record-types.ts";
import {
  jobsOf,
  mergeArmed,
  mergeDisarmed,
  mergeSettled,
  pipelineOf,
  pipelinesOfPr,
  prChecks,
  prClosed,
  prComment,
  prHead,
  prMerged,
  prOpened,
  prReview,
  prUpdated,
  pushed,
} from "../src/queries.ts";
import type { PrKey } from "../src/queries.ts";
import { sha } from "./fake-gitlab.ts";

const repo = { host: "gitlab.example.com", path: "acme/billing", projectId: 42 };
const pr = { repo, number: 7 };
const other = { repo, number: 8 };
const head = sha("topic-1");
const source = { kind: "observed", version: 1 } as const;

/** The value at a dotted path of data, as the journal's equality filter reads it. */
function at(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], data);
}

/** The names of the types a query holds, as the journal reads them. */
function names(query: TypeQuery<any>): string[] {
  return (resolveQuery(query).types ?? []).map(String);
}

/** Whether data answers the filter of a query: equality on every path. */
function answers(query: TypeQuery<any>, data: unknown): boolean {
  return Object.entries(resolveQuery(query).filter ?? {}).every(([path, value]) => at(data, path) === value);
}

const prData = { pr: { repo, number: 7 } };
const pipelineData = { repo, pipeline: 5, kind: "merge-result", ref: "refs/merge-requests/7/merge", sourceSha: head, state: "running", pr: 7, source };

test("a pull request's records are queries of their type, filtered on its repository and number", () => {
  const filter = { "pr.repo.host": repo.host, "pr.repo.path": repo.path, "pr.number": 7 };
  expect(prHead(pr)).toEqual({ types: [PrHead], filter });
  expect(prMerged(pr)).toEqual({ types: [PrMerged], filter });
  expect(prClosed(pr)).toEqual({ types: [PrClosed], filter });
  expect(prChecks(pr)).toEqual({ types: [ChecksObserved], filter });
  expect(names(prHead(pr))).toEqual(["forge.pr.head"]);
  expect(resolveQuery(prHead(pr)).filter).toEqual(filter);
  expect(names(mergeArmed(pr))).toEqual(["forge.pr.merge.armed"]);
});

test("every pull request builder holds a record of its pull request and no other", () => {
  const cases: Array<[TypeQuery<any>, (key: PrKey) => TypeQuery<any>, unknown]> = [
    [prOpened(pr), prOpened, PrOpened],
    [prUpdated(pr), prUpdated, PrUpdated],
    [prHead(pr), prHead, PrHead],
    [prReview(pr), prReview, PrReview],
    [prComment(pr), prComment, PrComment],
    [prMerged(pr), prMerged, PrMerged],
    [prClosed(pr), prClosed, PrClosed],
    [prChecks(pr), prChecks, ChecksObserved],
    [mergeArmed(pr), mergeArmed, MergeArmed],
    [mergeDisarmed(pr), mergeDisarmed, MergeDisarmed],
    [mergeSettled(pr), mergeSettled, MergeSettled],
  ];
  for (const [query, build, type] of cases) {
    expect(query.types).toEqual([type as never]);
    expect(answers(query, prData)).toBe(true);
    expect(answers(build(other), prData)).toBe(false);
    expect(answers(build({ repo: { ...repo, path: "acme/other" }, number: 7 }), prData)).toBe(false);
  }
});

test("a repository given with its project id is read for its name only", () => {
  expect(prHead({ repo: { host: repo.host, path: repo.path }, number: 7 })).toEqual(prHead(pr));
});

test("the pipelines of a commit are filtered on the commit, and on the kind when one is asked", () => {
  const all = pipelineOf({ repo, sha: head });
  expect(all).toEqual({ types: [PipelineObserved], filter: { "repo.host": repo.host, "repo.path": repo.path, sourceSha: head } });
  const merged = pipelineOf({ repo, sha: head, kind: "merge-result" });
  expect(resolveQuery(merged).filter).toEqual({ "repo.host": repo.host, "repo.path": repo.path, sourceSha: head, kind: "merge-result" });
  expect(answers(all, pipelineData)).toBe(true);
  expect(answers(merged, pipelineData)).toBe(true);
  expect(answers(pipelineOf({ repo, sha: head, kind: "head" }), pipelineData)).toBe(false);
  expect(answers(pipelineOf({ repo, sha: sha("another") }), pipelineData)).toBe(false);
});

test("the pipelines of a pull request are filtered on the number the server gave the pipeline", () => {
  expect(answers(pipelinesOfPr(pr), pipelineData)).toBe(true);
  expect(answers(pipelinesOfPr(other), pipelineData)).toBe(false);
});

test("the jobs of a pipeline, and the pushes to a repository or a ref", () => {
  const job = { repo, pipeline: 5, job: 9, name: "test", stage: "test", state: "running", source };
  expect(jobsOf({ repo, pipeline: 5 }).types).toEqual([JobObserved]);
  expect(answers(jobsOf({ repo, pipeline: 5 }), job)).toBe(true);
  expect(answers(jobsOf({ repo, pipeline: 6 }), job)).toBe(false);

  const push = { repo, ref: "main", refType: "branch", after: head, source };
  expect(pushed(repo).types).toEqual([Pushed]);
  expect(answers(pushed(repo), push)).toBe(true);
  expect(answers(pushed(repo, "main"), push)).toBe(true);
  expect(answers(pushed(repo, "release"), push)).toBe(false);
});

test("a name that is not a repository, a number or a commit is refused when the query is made", () => {
  expect(() => prHead({ repo: { host: "https://gitlab.example.com", path: "acme/billing" }, number: 7 })).toThrow();
  expect(() => prHead({ repo, number: 0 })).toThrow();
  expect(() => prHead({ repo, number: 1.5 })).toThrow();
  expect(() => pipelineOf({ repo, sha: "abc" })).toThrow();
  expect(() => pipelinesOfPr({ repo: { host: repo.host, path: "billing" }, number: 1 })).toThrow();
  expect(() => jobsOf({ repo, pipeline: 0 })).toThrow();
  expect(() => pushed(repo, "")).toThrow();
});
