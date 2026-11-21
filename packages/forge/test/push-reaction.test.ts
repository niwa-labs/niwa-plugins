// The push reaction: a built-in workflow of forge and git, offered only when it is asked for, that
// answers which worktrees a push to their base branch left behind.

import { afterEach, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eventually, git, tempDir, workflow } from "@niwa-labs/testing";

import { forgeRepoSync, forgeRepoWatch } from "../src/index.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

/** A git repository on `main` with one commit. */
async function repository(remote?: string): Promise<string> {
  const dir = realpathSync(await tempDir("checkout"));
  const run = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
  };
  run("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "billing\n");
  run("add", "README");
  run("commit", "-q", "-m", "Start");
  if (remote !== undefined) run("remote", "add", "origin", remote);
  return dir;
}

const installations = async (host: ForgeHost) => ((await host.niwa.call("workflow.installation.list" as never, {} as never)) as { items: unknown[] }).items;

test("on a push to a branch, the run names the worktrees of the repository's checkouts made from that branch", async () => {
  const checkout = await repository();
  const other = await repository();
  const host = await forgeHost({
    before: [git({ cleanup: false })],
    after: [workflow()],
    forge: { pushReaction: { checkouts: { "gitlab.example.com/acme/billing": [checkout] } } },
  });
  hosts.push(host);
  await eventually(async () => (await installations(host)).length === 1, 20_000, "the push reaction was not installed");

  const create = (repo: string) => host.niwa.call("git.worktree.create" as never, { repo, base: "main", description: "work" } as never) as Promise<{ id: string }>;
  const ours = await create(checkout);
  await create(other);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  host.server.event(host.billing, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: sha("main-1"), commit_to: sha("main-2") } });
  host.server.event(host.billing, { action_name: "pushed new", push_data: { ref: "v1.0", ref_type: "tag", commit_from: null, commit_to: sha("main-2") } });
  await host.niwa.call(forgeRepoSync, { repo: BILLING });

  const finished = async () => (await host.records(["workflow.run.finished"])).map((one) => (one.data as { outcome: { result?: unknown } }).outcome.result);
  await eventually(async () => (await finished()).length >= 1, 20_000, "the push reaction did not finish");
  expect(await finished()).toEqual([{ ref: "main", behind: [ours.id] }]);
}, 60_000);

test("without a list of checkouts, the run finds the worktrees whose base pushes to the repository that was pushed to", async () => {
  const cloned = await repository("https://gitlab.example.com/acme/billing.git");
  const elsewhere = await repository("https://gitlab.example.com/acme/shipping.git");
  const unconnected = await repository();
  const host = await forgeHost({ before: [git({ cleanup: false })], after: [workflow()], forge: { pushReaction: {} } });
  hosts.push(host);
  await eventually(async () => (await installations(host)).length === 1, 20_000, "the push reaction was not installed");

  const create = (repo: string) => host.niwa.call("git.worktree.create" as never, { repo, base: "main", description: "work" } as never) as Promise<{ id: string }>;
  const ours = await create(cloned);
  await create(elsewhere);
  await create(unconnected);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  host.server.event(host.billing, { action_name: "pushed to", push_data: { ref: "main", ref_type: "branch", commit_from: sha("main-1"), commit_to: sha("main-2") } });
  await host.niwa.call(forgeRepoSync, { repo: BILLING });

  const finished = async () => (await host.records(["workflow.run.finished"])).map((one) => (one.data as { outcome: { result?: unknown } }).outcome.result);
  await eventually(async () => (await finished()).length >= 1, 20_000, "the push reaction did not finish");
  expect(await finished()).toEqual([{ ref: "main", behind: [ours.id] }]);
}, 60_000);

test("without the option nothing is offered, and a host without the workflow module serves", async () => {
  const bare = await forgeHost();
  hosts.push(bare);
  const described = (await bare.niwa.describe()).actions.map((one) => one.name as string);
  expect(described).not.toContain("forge.push.config");

  const withWorkflow = await forgeHost({ after: [workflow()] });
  hosts.push(withWorkflow);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await installations(withWorkflow)).toEqual([]);
});
