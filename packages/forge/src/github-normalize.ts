/**
 * A GitHub pull request and its checks, in the words the forge module already speaks of a GitLab
 * merge request: the same pull-request lifecycle, the same run states, the same verdicts. The
 * mapping is what a GitHub server and a GitLab server have in common, no more: what a pull request
 * is on one and is not on the other — a merge train, say — is left to the provider that has it.
 */

import type { PullRequest } from "./actions.ts";
import type { ChecksState, RunState } from "./record-types.ts";
import type { Repo } from "./record-types.ts";

/** A pull request, as the pulls endpoint of GitHub answers it. */
export interface GitHubPull {
  readonly number: number;
  readonly state?: string;
  readonly title?: string;
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly head?: { readonly ref?: string; readonly sha?: string };
  readonly base?: { readonly ref?: string };
  readonly user?: { readonly login?: string } | null;
  readonly merge_commit_sha?: string | null;
  /** Set when the server will merge the pull request by itself once its checks pass. */
  readonly auto_merge?: unknown;
  readonly html_url?: string;
}

/** The head sha of a pull request, or a word for a head the server did not name. */
function headShaOf(pull: GitHubPull): string {
  const sha = pull.head?.sha;
  if (sha !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return sha;
  return "0".repeat(40);
}

/**
 * A pull request of GitHub in the module's words. A closed pull request the server merged is
 * merged; a locked conversation is not a state of its own on GitHub, so it is not one here. The
 * merge commit is named only once the merge happened: before it, the server's answer for it is a
 * placeholder that changes, not a commit.
 */
export function pullRequestOf(repo: Repo, pull: GitHubPull): PullRequest {
  const merged = pull.merged === true || typeof pull.merged_at === "string";
  const state = pull.state === "open" ? "open" : merged ? "merged" : "closed";
  const mergeSha = merged && typeof pull.merge_commit_sha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pull.merge_commit_sha)
    ? pull.merge_commit_sha
    : undefined;
  return {
    pr: { repo, number: pull.number },
    state,
    title: pull.title ?? `PR ${String(pull.number)}`,
    branch: pull.head?.ref ?? "",
    base: pull.base?.ref ?? "",
    head: headShaOf(pull),
    draft: pull.draft === true,
    ...(pull.user?.login === undefined ? {} : { author: pull.user.login }),
    ...(mergeSha === undefined ? {} : { mergeSha }),
    autoMerge: pull.auto_merge != null,
    ...(pull.html_url === undefined ? {} : { webUrl: pull.html_url }),
  };
}

/** A run of GitHub — a workflow run, a job, a check run — in the module's run states. */
export function runStateOf(status: string | undefined, conclusion: string | null | undefined): RunState {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return "success";
      case "failure":
      case "timed_out":
      case "startup_failure":
        return "failed";
      case "cancelled":
        return "canceled";
      case "skipped":
      case "neutral":
        return "skipped";
      case "action_required":
        return "manual";
      default:
        return "pending";
    }
  }
  switch (status) {
    case "in_progress":
      return "running";
    case "queued":
    case "requested":
    case "waiting":
    case "pending":
      return "pending";
    default:
      return "created";
  }
}

/** The verdict of a run of GitHub in the module's checks states, as `verdictOf` does for a pipeline. */
export function checksStateOf(status: string | undefined, conclusion: string | null | undefined): ChecksState {
  const state = runStateOf(status, conclusion);
  if (state === "success") return "green";
  if (state === "failed" || state === "canceled") return "red";
  if (state === "skipped") return "none";
  return "pending";
}
