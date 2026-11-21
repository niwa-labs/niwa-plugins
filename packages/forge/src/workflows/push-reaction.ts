// What a push to a branch of a watched repository means for the worktrees niwa keeps: a built-in
// workflow of the forge module, on the forge's own `forge.push`, that reads the git module's
// worktrees. It lives here, as a workflow of the two, and not in the git module, so local git has no
// hidden need of a forge.
//
// A worktree belongs to the repository that was pushed to when the remote its base pushes to, as
// `git.worktree.list` shows it, is that repository. The owner may also name local checkouts
// (`forge({ pushReaction: { checkouts } })`) for clones whose remote the git module does not verify.
// A push to a branch that such worktrees were made from leaves them behind it, unless their head is
// already the pushed commit; the run answers which, for a composition to act on.

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
  head?: string;
  remote?: { name: string; host: string; path: string };
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
    if (data.after === undefined) return { ref: data.ref, behind: [] };
    const { checkouts } = (await call("forge.push.config", {}, { label: "config" })) as { checkouts: Record<string, string[]> };
    const local = checkouts[`${data.repo.host}/${data.repo.path}`] ?? [];
    const { items } = (await call("git.worktree.list", {}, { label: "worktrees" })) as { items: Listed[] };
    const behind = items
      .filter(
        (item) =>
          item.state === "ok" &&
          item.base === data.ref &&
          item.head !== data.after &&
          ((item.remote?.host === data.repo.host && item.remote.path === data.repo.path) || (item.repo !== undefined && local.includes(item.repo))),
      )
      .map((item) => item.id);
    return { ref: data.ref, behind };
  },
);
