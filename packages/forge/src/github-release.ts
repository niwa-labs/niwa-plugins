/**
 * The read-only port a release workflow speaks to a GitHub server through: the evidence a gate
 * needs, at an exact revision, and the state of a tag and its release.
 *
 * The port answers questions, it does not judge them: `ci` reports what the branch requires, which
 * runs of the required workflows stand at the revision (the current attempt of each, with its
 * jobs), which required checks stand at it and which app made them, and whether the revision is on
 * the branch. A workflow that has not run at the revision, a check nothing has reported, one still
 * queued or running, and two that disagree, are answers of their own: the evidence is incomplete,
 * never silently green. `release` peels a tag — a lightweight one to its commit, an annotated one
 * through the tag object to the commit it names — and reports the flags of the release that holds
 * it and the SHA-256 of the bytes of each of its assets, read from the server. The slug names a
 * repository; which repositories those are is the caller's to say, and none is named here.
 *
 * The shapes are the ones a release consumer expects: an adapter between that consumer and this
 * port is written where the consumer lives, and needs no more than these types structurally.
 */

import { ForgeError } from "./gitlab.ts";
import { GitHub } from "./github.ts";
import type { ServersPlace, ForgeServer } from "./servers.ts";
import { resolveSecret } from "./secrets.ts";

/** A repository a release is made of: its slug, the exact revision the gate is about, and the branch. */
export interface ReleaseRepository {
  readonly slug: string;
  readonly revision: string;
  readonly branch: string;
}

/** What a gate requires of a repository: workflow files by name, and checks by name and app. */
export interface RequiredCi {
  readonly workflows: readonly string[];
  readonly checks: readonly { readonly name: string; readonly appId: number }[];
}

/** A workflow, a job or a check at a revision. */
export interface CheckResult {
  readonly revision: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** A workflow the gate requires, with the jobs of its current attempt. */
export interface WorkflowEvidence extends CheckResult {
  readonly file: string;
  readonly jobs?: readonly ({ readonly name: string } & CheckResult)[];
}

/** The evidence a gate needs, at one revision of one repository. */
export interface CiEvidence {
  readonly repository: string;
  readonly revision: string;
  readonly onBranch: boolean;
  readonly complete: boolean;
  readonly effectiveChecks: readonly { readonly name: string; readonly appId: number }[];
  readonly workflows: readonly WorkflowEvidence[];
  readonly checks: readonly ({ readonly name: string; readonly appId: number } & CheckResult)[];
}

/** A tag and the release that holds it. */
export interface GitHubReleaseState {
  readonly tagRevision: string | null;
  readonly release: null | {
    readonly tag: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
    /** The SHA-256 of the bytes of each asset, by name. */
    readonly assets: Readonly<Record<string, string>>;
  };
}

/** The read-only port a release workflow speaks to a GitHub server through. */
export interface GitHubReleaseReader {
  ci(repo: ReleaseRepository, required: RequiredCi): Promise<CiEvidence>;
  release(repo: ReleaseRepository, tag: string): Promise<GitHubReleaseState>;
}

/** A branch, as the branch endpoint answers it. */
interface Branch {
  readonly commit?: { readonly sha?: string };
}

/** A comparison of two revisions, as the compare endpoint answers it. */
interface Compare {
  readonly status?: string;
  readonly merge_base_commit?: { readonly sha?: string };
}

/** A rule that applies to a branch, as the rules endpoint answers it. */
interface Rule {
  readonly type?: string;
  readonly parameters?: {
    readonly required_status_checks?: readonly RequiredAnswer[];
    readonly checks?: readonly RequiredAnswer[];
  };
}

/** One required check of a rule, whichever of the two shapes the server speaks. */
interface RequiredAnswer {
  readonly context?: string;
  readonly integration_id?: number | null;
  readonly app_id?: number | null;
}

/** The classic protection of a branch, as the protection endpoint answers it. */
interface Protection {
  readonly required_status_checks?: {
    readonly checks?: readonly { readonly context?: string; readonly app_id?: number | null }[];
    readonly contexts?: readonly string[];
  };
}

/** A run of a workflow, as the workflow runs endpoint answers it. */
interface WorkflowRun {
  readonly id: number;
  readonly head_sha?: string;
  readonly run_attempt?: number;
  readonly status?: string;
  readonly conclusion?: string | null;
}

/** A job of a workflow run, as the jobs endpoint answers it. */
interface WorkflowJob {
  readonly id: number;
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

/** A check run at a commit, as the check runs endpoint answers it. */
interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly app?: { readonly id?: number } | null;
}

/** A commit status at a commit, as the statuses endpoint answers it: newest first. */
interface CommitStatus {
  readonly context: string;
  readonly state?: string;
}

/** A tag or a commit a ref points at, as the ref and tag endpoints answer it. */
interface GitObject {
  readonly object?: { readonly sha?: string; readonly type?: string };
}

/** A release, as the release endpoint answers it. */
interface ReleaseAnswer {
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly assets?: readonly { readonly name: string; readonly url: string }[];
}

/** The path of a repository's place in the API. */
function repoPath(slug: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new ForgeError("refused", `"${slug}" is not a repository slug of owner and name`);
  return `/repos/${slug}`;
}

/** The answer when the server had none, such as a tag or a release that is not there. */
async function nothing<T>(promise: Promise<T>): Promise<T | undefined> {
  return await promise.catch((error: unknown) => {
    if (error instanceof ForgeError && error.code === "not-found") return undefined;
    throw error;
  });
}

/** Read a release port of one configured server. The token is resolved for each request: a secret
 * the owner replaces is taken without a restart. */
export function githubReleaseReader(server: ForgeServer, place: ServersPlace): GitHubReleaseReader {
  const github = new GitHub({
    host: server.host,
    url: server.url,
    token: () => resolveSecret(place.home(), server.token.secret, place.env),
    fetch: place.fetch,
    now: place.now,
    ...(place.sleep === undefined ? {} : { sleep: place.sleep }),
  });
  const reader: GitHubReleaseReader = {
    async ci(repo, required) {
      const at = repoPath(repo.slug);
      const revision = repo.revision.toLowerCase();
      const branch = await github.get<Branch>(`${at}/branches/${encodeURIComponent(repo.branch)}`);
      const head = branch.commit?.sha?.toLowerCase();
      // The revision is on the branch when it is the branch's tip, or the newest commit the two
      // share: a compare that names the revision as the merge base says the branch carries it.
      let onBranch = head !== undefined && head === revision;
      let known = true;
      if (!onBranch) {
        const compare = await nothing(github.get<Compare>(`${at}/compare/${encodeURIComponent(repo.branch)}...${encodeURIComponent(repo.revision)}`));
        if (compare === undefined) known = false;
        else onBranch = compare.merge_base_commit?.sha?.toLowerCase() === revision;
      }

      const effectiveChecks = await requiredOf(github, at, repo.branch);

      const workflows: WorkflowEvidence[] = [];
      for (const file of required.workflows) {
        const answer = known
          ? await nothing(github.get<{ workflow_runs?: WorkflowRun[] }>(`${at}/actions/workflows/${encodeURIComponent(file)}/runs`, { head_sha: repo.revision }))
          : undefined;
        const runs = (answer?.workflow_runs ?? []).filter((run) => (run.head_sha ?? "").toLowerCase() === revision);
        if (runs.length === 0) {
          workflows.push({ file, revision, status: "missing", conclusion: null });
          continue;
        }
        const current = runs.reduce((best, one) =>
          (one.run_attempt ?? 1) > (best.run_attempt ?? 1) || ((one.run_attempt ?? 1) === (best.run_attempt ?? 1) && one.id > best.id) ? one : best);
        const jobs = await github.get<{ jobs?: WorkflowJob[] }>(`${at}/actions/runs/${String(current.id)}/jobs`, { filter: "latest" });
        workflows.push({
          file,
          revision,
          status: current.status ?? "missing",
          conclusion: current.conclusion ?? null,
          jobs: (jobs.jobs ?? []).map((job) => ({ name: job.name, revision, status: job.status ?? "missing", conclusion: job.conclusion ?? null })),
        });
      }

      const runs = known ? (await github.get<{ check_runs?: CheckRun[] }>(`${at}/commits/${repo.revision}/check-runs`, { filter: "latest" })).check_runs ?? [] : [];
      const checks: ({ name: string; appId: number } & CheckResult)[] = [];
      for (const requiredCheck of required.checks) {
        const mine = runs.filter((run) => run.name === requiredCheck.name && (requiredCheck.appId === 0 || run.app?.id === requiredCheck.appId));
        // A check no app is pinned to may also be a commit status, which no app made.
        const candidates = mine.length > 0 || requiredCheck.appId !== 0 ? mine : await statusesOf(github, at, repo.revision, requiredCheck.name);
        checks.push({ name: requiredCheck.name, appId: requiredCheck.appId, ...resultOf(candidates, revision) });
      }

      const complete = known && onBranch && workflows.every((one) => one.status === "completed") && checks.every((one) => one.status === "completed");
      return { repository: repo.slug, revision: repo.revision, onBranch, complete, effectiveChecks, workflows, checks };
    },

    async release(repo, tag) {
      const at = repoPath(repo.slug);
      const ref = await nothing(github.get<GitObject>(`${at}/git/ref/tags/${encodeURIComponent(tag)}`));
      if (ref === undefined) return { tagRevision: null, release: null };
      let target = ref.object;
      let tagRevision = target?.sha?.toLowerCase() ?? null;
      // An annotated tag points at a tag object, which names the commit: peel until a commit.
      for (let hop = 0; target?.type === "tag" && hop < 3; hop += 1) {
        const tagObject = await nothing(github.get<GitObject>(`${at}/git/tags/${encodeURIComponent(target.sha ?? "")}`));
        if (tagObject?.object === undefined) break;
        target = tagObject.object;
        tagRevision = target.sha?.toLowerCase() ?? tagRevision;
      }
      const answer = await nothing(github.get<ReleaseAnswer>(`${at}/releases/tags/${encodeURIComponent(tag)}`));
      if (answer === undefined) return { tagRevision, release: null };
      const assets: Record<string, string> = {};
      for (const asset of answer.assets ?? []) {
        const { sha256 } = await github.download(asset.url);
        assets[asset.name] = sha256;
      }
      return { tagRevision, release: { tag, draft: answer.draft === true, prerelease: answer.prerelease === true, assets } };
    },
  };
  return reader;
}

/** The checks the branch effectively requires: the rules that apply to it, from rulesets the
 * repository, its organization or its enterprise has; the classic protection of a branch that has
 * no such rule still names its required checks, so it is read then, and only then. */
async function requiredOf(github: GitHub, at: string, branch: string): Promise<{ name: string; appId: number }[]> {
  const rules = await github.list<Rule>(`${at}/rules/branches/${encodeURIComponent(branch)}`);
  const found = new Map<string, number>();
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks ?? rule.parameters?.checks ?? [];
    for (const check of checks) {
      const name = check.context;
      if (name === undefined) continue;
      found.set(name, check.integration_id ?? check.app_id ?? 0);
    }
  }
  if (found.size > 0) return [...found].map(([name, appId]) => ({ name, appId }));
  const protection = await nothing(github.get<Protection>(`${at}/branches/${encodeURIComponent(branch)}/protection`));
  for (const check of protection?.required_status_checks?.checks ?? []) {
    if (check.context !== undefined) found.set(check.context, check.app_id ?? 0);
  }
  for (const context of protection?.required_status_checks?.contexts ?? []) {
    if (!found.has(context)) found.set(context, 0);
  }
  return [...found].map(([name, appId]) => ({ name, appId }));
}

/** The commit statuses of a context, as pseudo check runs: the newest is the current one. */
async function statusesOf(github: GitHub, at: string, revision: string, context: string): Promise<CheckRun[]> {
  const statuses = await github.list<CommitStatus>(`${at}/commits/${encodeURIComponent(revision)}/statuses`, { per_page: 100 });
  return statuses
    .filter((one) => one.context === context)
    .map((one, index) => ({
      id: Number.MAX_SAFE_INTEGER - index,
      name: one.context,
      status: one.state === "pending" ? "pending" : "completed",
      conclusion: one.state === "pending" ? null : (one.state ?? "pending"),
      app: null,
    }));
}

/** The current one of the candidates — the newest, by id — and what the candidates together say:
 * two that finished and disagree are ambiguous, which is an answer, not a verdict. */
function resultOf(candidates: readonly CheckRun[], revision: string): CheckResult {
  if (candidates.length === 0) return { revision, status: "missing", conclusion: null };
  const ordered = [...candidates].sort((one, other) => other.id - one.id);
  const current = ordered[0] as CheckRun;
  const said = new Set(ordered.filter((one) => one.status === "completed" && one.conclusion !== null).map((one) => one.conclusion));
  if (said.size > 1) return { revision, status: "ambiguous", conclusion: null };
  return { revision, status: current.status ?? "missing", conclusion: current.conclusion ?? null };
}
