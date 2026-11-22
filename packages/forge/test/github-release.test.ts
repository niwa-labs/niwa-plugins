// The release port: evidence at an exact revision — the rules the branch effectively requires, the
// current attempt of each required workflow with its jobs, the checks and the apps that made them —
// and the state of a tag and its release, with the SHA-256 of the bytes of each asset.

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { secret } from "../src/actions.ts";
import { githubReleaseReader } from "../src/github-release.ts";
import { ForgeError } from "../src/gitlab.ts";
import { Servers } from "../src/servers.ts";
import { FakeGitHub } from "./fake-github.ts";
import { sha } from "./fake-gitlab.ts";

function reader(server: FakeGitHub, waits: number[] = []) {
  const home = mkdtempSync(join(tmpdir(), "niwa-github-reader-"));
  return githubReleaseReader({ host: "github.com", token: secret("GITHUB_TOKEN") }, {
    home: () => home,
    now: () => 1_000_000,
    fetch: server.fetch,
    env: { NIWA_SECRET_GITHUB_TOKEN: server.token },
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

function made() {
  const server = new FakeGitHub();
  const repo = server.repo(42, "acme/billing");
  const revision = sha("release-head");
  server.branch(repo, "main", revision);
  return { server, repo, revision };
}

const REQUIRED = { workflows: ["cli-release.yml"], checks: [{ name: "gate/ship", appId: 15_368 }] };

test("the evidence of a revision the branch requires, at its tip, all green", async () => {
  const { server, repo, revision } = made();
  server.rule(repo, "main", "required_status_checks", {
    required_status_checks: [{ context: "gate/ship", integration_id: 15_368 }, { context: "any/context", integration_id: null }],
  });
  server.rule(repo, "main", "pull_request", { required_approving_review_count: 1 });
  const first = server.workflowRun(repo, { file: "cli-release.yml", sha: revision, attempt: 1, status: "completed", conclusion: "failure" });
  server.job(repo, first, { name: "build", status: "completed", conclusion: "failure" });
  const current = server.workflowRun(repo, { file: "cli-release.yml", sha: revision, attempt: 2, status: "completed", conclusion: "success" });
  server.job(repo, current, { name: "build", status: "completed", conclusion: "success" });
  server.job(repo, current, { name: "sign", status: "completed", conclusion: "success" });
  server.workflowRun(repo, { file: "other.yml", sha: revision, attempt: 1, status: "completed", conclusion: "success" });
  server.checkRun(repo, { name: "gate/ship", appId: 15_368, status: "completed", conclusion: "success" });
  server.checkRun(repo, { name: "unrelated", appId: 1, status: "completed", conclusion: "success" });

  const evidence = await reader(server).ci({ slug: "acme/billing", revision, branch: "main" }, REQUIRED);
  expect(evidence).toEqual({
    repository: "acme/billing",
    revision,
    onBranch: true,
    complete: true,
    effectiveChecks: [{ name: "gate/ship", appId: 15_368 }, { name: "any/context", appId: 0 }],
    workflows: [
      {
        file: "cli-release.yml",
        revision,
        status: "completed",
        conclusion: "success",
        jobs: [
          { name: "build", revision, status: "completed", conclusion: "success" },
          { name: "sign", revision, status: "completed", conclusion: "success" },
        ],
      },
    ],
    checks: [{ name: "gate/ship", appId: 15_368, revision, status: "completed", conclusion: "success" }],
  });
  // The runs asked are the ones at the exact revision, and the jobs of the current attempt.
  const asked = server.seen("GET", /\/actions\/workflows\/cli-release\.yml\/runs$/);
  expect(asked[0]?.query.head_sha).toBe(revision);
  expect(server.seen("GET", new RegExp(`/actions/runs/${String(current.id)}/jobs$`))).toHaveLength(1);
});

test("a revision the branch has moved past is still on it; one it never had is not", async () => {
  const { server, repo, revision } = made();
  const tip = sha("new-tip");
  server.branch(repo, "main", tip);
  server.compare(repo, "main", revision, "behind", revision);
  server.rule(repo, "main", "required_status_checks", { required_status_checks: [] });
  const onIt = await reader(server).ci({ slug: "acme/billing", revision, branch: "main" }, { workflows: [], checks: [] });
  expect(onIt.onBranch).toBe(true);

  const other = made();
  const diverged = sha("diverged");
  other.server.compare(other.repo, "main", diverged, "diverged", sha("common-base"));
  const notOnIt = await reader(other.server).ci({ slug: "acme/billing", revision: diverged, branch: "main" }, { workflows: [], checks: [] });
  expect(notOnIt.onBranch).toBe(false);
  expect(notOnIt.complete).toBe(false);
});

test("a revision the server does not know is missing everywhere, not an error", async () => {
  const { server } = made();
  const unknown = sha("never-pushed");
  const evidence = await reader(server).ci({ slug: "acme/billing", revision: unknown, branch: "main" }, REQUIRED);
  expect(evidence.onBranch).toBe(false);
  expect(evidence.complete).toBe(false);
  expect(evidence.workflows).toEqual([{ file: "cli-release.yml", revision: unknown, status: "missing", conclusion: null }]);
  expect(evidence.checks).toEqual([{ name: "gate/ship", appId: 15_368, revision: unknown, status: "missing", conclusion: null }]);
  expect(server.seen("GET", /\/check-runs$/)).toHaveLength(0);
});

test("a check still running and a workflow that has not run make the evidence incomplete", async () => {
  const { server, repo, revision } = made();
  server.rule(repo, "main", "required_status_checks", { required_status_checks: [{ context: "gate/ship", integration_id: 15_368 }] });
  server.checkRun(repo, { name: "gate/ship", appId: 15_368, status: "in_progress", conclusion: null });
  server.workflowRun(repo, { file: "cli-release.yml", sha: revision, attempt: 1, status: "queued", conclusion: null });
  const evidence = await reader(server).ci({ slug: "acme/billing", revision, branch: "main" }, { workflows: ["cli-release.yml", "absent.yml"], checks: [{ name: "gate/ship", appId: 15_368 }] });
  expect(evidence.complete).toBe(false);
  expect(evidence.workflows.map((one) => [one.file, one.status, one.conclusion])).toEqual([
    ["cli-release.yml", "queued", null],
    ["absent.yml", "missing", null],
  ]);
  expect(evidence.checks[0]).toMatchObject({ status: "in_progress", conclusion: null });
});

test("checks that finished and disagree are ambiguous, and one a commit status satisfies is found", async () => {
  const { server, repo, revision } = made();
  server.checkRun(repo, { name: "flaky", appId: 7, status: "completed", conclusion: "failure" });
  server.checkRun(repo, { name: "flaky", appId: 7, status: "completed", conclusion: "success" });
  server.status(repo, { context: "legacy/context", state: "success" });
  const evidence = await reader(server).ci(
    { slug: "acme/billing", revision, branch: "main" },
    { workflows: [], checks: [{ name: "flaky", appId: 7 }, { name: "legacy/context", appId: 0 }, { name: "ghost/context", appId: 0 }] },
  );
  expect(evidence.checks.map((one) => [one.name, one.status, one.conclusion])).toEqual([
    ["flaky", "ambiguous", null],
    ["legacy/context", "completed", "success"],
    ["ghost/context", "missing", null],
  ]);
  expect(evidence.complete).toBe(false);
});

test("the classic protection names the required checks when no rule does", async () => {
  const { server, repo, revision } = made();
  server.rule(repo, "main", "required_linear_history", {});
  repo.protection.set("main", { required_status_checks: { checks: [{ context: "classic/check", app_id: 42 }], contexts: ["old/context"] } });
  const evidence = await reader(server).ci({ slug: "acme/billing", revision, branch: "main" }, { workflows: [], checks: [] });
  expect(evidence.effectiveChecks).toEqual([{ name: "classic/check", appId: 42 }, { name: "old/context", appId: 0 }]);

  const bare = made();
  const none = await reader(bare.server).ci({ slug: "acme/billing", revision: bare.revision, branch: "main" }, { workflows: [], checks: [] });
  expect(none.effectiveChecks).toEqual([]);
});

test("a permission failure on the rules of the branch fails the read", async () => {
  const { server } = made();
  server.queue("GET", /\/rules\/branches\/main$/, 403, { message: "Resource not accessible by integration" });
  const error = await reader(server).ci({ slug: "acme/billing", revision: sha("x"), branch: "main" }, { workflows: [], checks: [] }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForgeError);
  expect((error as ForgeError).code).toBe("forbidden");
});

test("a read the server could not answer is asked again, and the evidence still comes", async () => {
  const { server, repo, revision } = made();
  const waits: number[] = [];
  server.queue("GET", /\/check-runs$/, 503, { message: "Service Unavailable" });
  server.checkRun(repo, { name: "gate/ship", appId: 15_368, status: "completed", conclusion: "success" });
  server.workflowRun(repo, { file: "cli-release.yml", sha: revision, attempt: 1, status: "completed", conclusion: "success" });
  const evidence = await reader(server, waits).ci({ slug: "acme/billing", revision, branch: "main" }, REQUIRED);
  expect(evidence.complete).toBe(true);
  expect(waits).toEqual([0]);
});

test("an annotated tag is peeled to its commit, and a lightweight one is its commit", async () => {
  const { server, repo, revision } = made();
  const tagged = sha("tag-object");
  server.tag(repo, "v1.2.3", { sha: tagged, type: "tag" });
  server.tagObject(repo, tagged, { sha: revision, type: "commit" });
  server.release(repo, { tag: "v1.2.3", draft: true, prerelease: true, assets: [{ name: "niwa-1.2.3.tar.gz", bytes: new TextEncoder().encode("release bytes") }] });
  server.tag(repo, "v2.0.0", { sha: revision, type: "commit" });

  const first = await reader(server).release({ slug: "acme/billing", revision, branch: "main" }, "v1.2.3");
  expect(first.tagRevision).toBe(revision);
  expect(first.release).toEqual({
    tag: "v1.2.3",
    draft: true,
    prerelease: true,
    assets: { "niwa-1.2.3.tar.gz": createHash("sha256").update("release bytes").digest("hex") },
  });

  const light = await reader(server).release({ slug: "acme/billing", revision, branch: "main" }, "v2.0.0");
  expect(light.tagRevision).toBe(revision);
  expect(light.release).toBeNull();
});

test("a tag that is not there answers nothing, and so does a tag without a release", async () => {
  const { server, repo, revision } = made();
  server.tag(repo, "v3.0.0", { sha: revision, type: "commit" });
  const missing = await reader(server).release({ slug: "acme/billing", revision, branch: "main" }, "v9.9.9");
  expect(missing).toEqual({ tagRevision: null, release: null });
  const bare = await reader(server).release({ slug: "acme/billing", revision, branch: "main" }, "v3.0.0");
  expect(bare.tagRevision).toBe(revision);
  expect(bare.release).toBeNull();
});

test("the servers of the module look a GitHub repository up, and tell its kind", async () => {
  const server = new FakeGitHub("https://github.example.com/api/v3");
  server.repo(42, "acme/billing");
  const home = mkdtempSync(join(tmpdir(), "niwa-github-servers-"));
  const servers = new Servers([{ host: "github.example.com", kind: "github", token: secret("GITHUB_TOKEN") }], {
    home: () => home,
    now: () => 0,
    fetch: server.fetch,
    env: { NIWA_SECRET_GITHUB_TOKEN: server.token },
  });
  expect(servers.kindOf("github.example.com")).toBe("github");
  expect(await servers.lookup({ host: "github.example.com", path: "acme/billing" })).toEqual({ host: "github.example.com", path: "acme/billing", projectId: 42 });
  expect(() => servers.kindOf("gitlab.example.com")).toThrow(ForgeError);
  expect(() => servers.serverOf("gitlab.example.com")).toThrow(/no forge server/);
});
