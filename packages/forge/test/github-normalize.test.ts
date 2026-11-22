// A pull request of GitHub in the module's words, and the states of its runs: the lifecycle of a
// pull request and the verdicts of checks, mapped onto what the forge records already say.

import { expect, test } from "bun:test";

import { checksStateOf, pullRequestOf, runStateOf } from "../src/github-normalize.ts";
import type { GitHubPull } from "../src/github-normalize.ts";
import type { Repo } from "../src/record-types.ts";

const repo: Repo = { host: "github.example.com", path: "acme/billing", projectId: 42 };
const head = "0123456789abcdef0123456789abcdef01234567";

function pull(fields: Partial<GitHubPull> & { number: number }): GitHubPull {
  return { state: "open", title: "Ship it", head: { ref: "topic", sha: head }, base: { ref: "main" }, user: { login: "dev" }, ...fields };
}

test("an open pull request is open, a draft one is a draft, and a merged one is merged with its merge commit", () => {
  expect(pullRequestOf(repo, pull({ number: 7 }))).toMatchObject({ pr: { repo, number: 7 }, state: "open", branch: "topic", base: "main", head, draft: false, autoMerge: false, author: "dev" });
  expect(pullRequestOf(repo, pull({ number: 8, draft: true }))).toMatchObject({ pr: { repo, number: 8 }, state: "open", draft: true });
  const mergeCommit = "fedcba9876543210fedcba9876543210fedcba98";
  expect(
    pullRequestOf(repo, pull({ number: 9, state: "closed", merged: true, merge_commit_sha: mergeCommit })),
  ).toMatchObject({ pr: { repo, number: 9 }, state: "merged", mergeSha: mergeCommit });
  expect(pullRequestOf(repo, pull({ number: 10, state: "closed", merged: false }))).toMatchObject({ pr: { repo, number: 10 }, state: "closed" });
});

test("a merge the server will make by itself is an auto-merge, and a placeholder merge commit is not a commit", () => {
  expect(pullRequestOf(repo, pull({ number: 11, auto_merge: { merge_method: "squash" } }))).toMatchObject({ pr: { repo, number: 11 }, autoMerge: true });
  expect(pullRequestOf(repo, pull({ number: 12, state: "closed", merged: true, merge_commit_sha: null }))).not.toHaveProperty("mergeSha");
});

test("the states of a run of GitHub in the states the module records", () => {
  expect(runStateOf("queued", null)).toBe("pending");
  expect(runStateOf("in_progress", null)).toBe("running");
  expect(runStateOf("completed", "success")).toBe("success");
  expect(runStateOf("completed", "failure")).toBe("failed");
  expect(runStateOf("completed", "timed_out")).toBe("failed");
  expect(runStateOf("completed", "startup_failure")).toBe("failed");
  expect(runStateOf("completed", "cancelled")).toBe("canceled");
  expect(runStateOf("completed", "skipped")).toBe("skipped");
  expect(runStateOf("completed", "neutral")).toBe("skipped");
  expect(runStateOf("completed", "action_required")).toBe("manual");
  expect(runStateOf(undefined, undefined)).toBe("created");
  expect(checksStateOf("completed", "success")).toBe("green");
  expect(checksStateOf("completed", "failure")).toBe("red");
  expect(checksStateOf("in_progress", null)).toBe("pending");
  expect(checksStateOf("completed", "skipped")).toBe("none");
});
