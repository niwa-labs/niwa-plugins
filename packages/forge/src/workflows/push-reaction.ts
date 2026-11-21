// What a push to a branch of a watched repository means for the worktrees niwa keeps: a built-in
// workflow of the forge module, on the forge's own `forge.push`, that reads the git module's
// worktrees. It lives here, as a workflow of the two, and not in the git module, so local git has no
// hidden need of a forge.
//
// The owner says which local checkout is a clone of which repository (`forge({ pushReaction })`):
// nothing in the journal ties a remote to a project yet. A push to a branch that worktrees of that
// checkout were made from leaves them behind it; the run answers which, for a composition to act on.

/** What the push record holds, as much of it as the script reads. */
interface Push {
  repo: { host: string; path: string };
  ref: string;
  refType: "branch" | "tag";
  after?: string;
}

/** One worktree as `git.worktree.list` shows it. */
interface Listed {
  id: string;
  state: "ok" | "missing" | "orphan";
  repo?: string;
  base?: string;
}

declare const call: (name: string, input: unknown, opts?: { label?: string }) => Promise<any>;
declare const workflow: (
  declaration: { on: Array<string | { type: string; filter?: Record<string, unknown> }>; uses: string[]; output: unknown },
  run: (trigger: { data: Push }) => Promise<{ ref: string; behind: string[] }>,
) => unknown;
declare const z: { object(shape: Record<string, unknown>): unknown; string(): unknown; array(of: unknown): { optional(): unknown } & object };

export default workflow(
  {
    on: [{ type: "forge.push", filter: { refType: "branch" } }],
    uses: ["forge.push.config", "git.worktree.list"],
    output: z.object({ ref: z.string(), behind: z.array(z.string()) }),
  },
  async ({ data }) => {
    const { checkouts } = (await call("forge.push.config", {}, { label: "config" })) as { checkouts: Record<string, string[]> };
    const local = checkouts[`${data.repo.host}/${data.repo.path}`] ?? [];
    if (local.length === 0 || data.after === undefined) return { ref: data.ref, behind: [] };
    const { items } = (await call("git.worktree.list", {}, { label: "worktrees" })) as { items: Listed[] };
    const behind = items
      .filter((item) => item.state === "ok" && item.base === data.ref && item.repo !== undefined && local.includes(item.repo))
      .map((item) => item.id);
    return { ref: data.ref, behind };
  },
);
