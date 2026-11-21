/**
 * The forge module: a GitLab server in the words of pull requests, pipelines, jobs, checks and
 * comments.
 *
 * - Reads (`forge.pr.read`, `forge.checks.read`, `forge.pipeline.read`, `forge.job.read`, `forge.job.log`,
 *   `forge.comment.read`) target the repository, `<host>/<path>`.
 * - Writes on a pull request (`forge.pr.ensure`, `.retarget`, `.close`, `forge.comment.*`) target it,
 *   `<host>/<path>/pr/<n>`, and land in the external world.
 * - `forge.pr.merge` is irreversible and is not repeated after a cut: its check reads the pull request
 *   back. A merge the server takes for later is shown by `forge.pr.merge.pending` with the action that
 *   calls it off, because a hold of niwa cannot stop it.
 * - Pipelines and jobs (`forge.pipeline.trigger`, `.retry`, `.cancel`, `forge.job.retry`, `.cancel`,
 *   `.run`) target the ref they run on, `<host>/<path>/ref/<ref>`. The module does not know what a
 *   pipeline does, and one on a protected branch or a tag may publish, so they are irreversible: a
 *   grant names each of them, and a hold refuses them.
 *
 * The token of a server is a secret reference resolved by the host where the call runs; it reaches a
 * request header and nothing else. `fetch` may be given, so a test speaks to a fake server.
 */

import { action } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import {
  forgeChecksRead,
  forgeCommentCreate,
  forgeCommentRead,
  forgeCommentReply,
  forgeCommentResolve,
  forgeJobCancel,
  forgeJobLog,
  forgeJobRead,
  forgeJobRetry,
  forgeJobRun,
  forgePipelineCancel,
  forgePipelineRead,
  forgePipelineRetry,
  forgePipelineTrigger,
  forgePrClose,
  forgePrEnsure,
  forgePrMerge,
  forgePrMergeCancel,
  forgePrMergePending,
  forgePrRead,
  forgePrRetarget,
  forgeRepoList,
  forgeRepoUnwatch,
  forgeRepoWatch,
} from "./actions.ts";
import { ForgeError } from "./gitlab.ts";
import type { FetchLike, GitLab } from "./gitlab.ts";
import { cancelMerge, checkMerge, merge, pendingMerges } from "./merge.ts";
import { checksOf, kindOf, pipelineOf, pullRequestOf, runStateOf } from "./normalize.ts";
import type { GitLabJob, GitLabMr, GitLabPipeline } from "./normalize.ts";
import { FORGE_TYPES, MergeArmed, MergeDisarmed, RepoUnwatched, RepoWatched } from "./record-types.ts";
import type { Pipeline, Repo } from "./record-types.ts";
import { resolveSecret } from "./secrets.ts";
import { Servers, projectPath, repoKey, watchedRepos } from "./servers.ts";
import type { ForgeServer } from "./servers.ts";

export * from "./records.ts";
export { ForgeError } from "./gitlab.ts";
export type { FetchLike, ForgeErrorCode } from "./gitlab.ts";
export type { ForgeServer } from "./servers.ts";

/** What the forge module is given. */
export interface ForgeOptions {
  /** The GitLab servers it speaks to. */
  readonly servers: readonly ForgeServer[];
  /** How it reaches a server. Default: the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Where `NIWA_SECRET_<name>` is read. Default: the environment of the host's process. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The most bytes of a job log a read answers by default. */
const LOG_BYTES = 65_536;

/** A discussion of a merge request, as much of it as the module reads. */
interface GitLabDiscussion {
  id: string;
  notes: Array<{ id: number; body: string; author?: { username?: string }; resolvable?: boolean; resolved?: boolean; system?: boolean }>;
}

/** The forge module. */
export function forge(options: ForgeOptions): Plugin {
  const fetchOf: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const env = options.env ?? process.env;

  return plugin("forge", (api) => {
    api.declare(...FORGE_TYPES);
    const journal = (): JournalReader | undefined => api.journal?.();
    const servers = new Servers(options.servers, { home: () => api.home(), now: () => Date.now(), fetch: fetchOf, env });
    const gitlab = (host: string): GitLab => servers.client(host);
    const repoOf = (name: { host: string; path: string }) => servers.repo(name, journal());
    const parentsOf = (client: GitLab, repo: Repo) => async (sha: string) => {
      try {
        return (await client.get<{ parent_ids: string[] }>(projectPath(repo, `/repository/commits/${sha}`))).parent_ids;
      } catch (error) {
        if (error instanceof ForgeError && error.code === "not-found") return undefined;
        throw error;
      }
    };
    const pipelinesOf = async (repo: Repo, raw: readonly GitLabPipeline[]): Promise<Pipeline[]> => {
      const client = gitlab(repo.host);
      const made = await Promise.all(raw.map((one) => pipelineOf(repo, one, parentsOf(client, repo))));
      return made.filter((one): one is Pipeline => one !== undefined);
    };

    // --- Repositories ---------------------------------------------------------------------------

    api.action(
      action(forgeRepoWatch, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        async run(input, ctx) {
          const known = watchedRepos(journal()).get(repoKey(input.repo));
          if (known !== undefined) return known;
          const repo = await servers.lookup(input.repo);
          await ctx.emit(RepoWatched, { repo });
          return repo;
        },
      }),
    );

    api.action(
      action(forgeRepoUnwatch, {
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        idempotent: true,
        async run(input, ctx) {
          const known = watchedRepos(journal()).get(repoKey(input.repo));
          if (known === undefined) return { unwatched: false };
          await ctx.emit(RepoUnwatched, { repo: known });
          return { unwatched: true };
        },
      }),
    );

    api.action(
      action(forgeRepoList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: () => ({ items: [...watchedRepos(journal()).values()] }),
      }),
    );

    // --- Reads ----------------------------------------------------------------------------------

    api.action(
      action(forgePrRead, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          return pullRequestOf(repo, await gitlab(repo.host).get<GitLabMr>(projectPath(repo, `/merge_requests/${String(input.number)}`)));
        },
      }),
    );

    api.action(
      action(forgeChecksRead, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const client = gitlab(repo.host);
          const mr = await client.get<GitLabMr>(projectPath(repo, `/merge_requests/${String(input.number)}`));
          const raw = await client.list<GitLabPipeline>(projectPath(repo, `/merge_requests/${String(input.number)}/pipelines`));
          const ofHead = (await pipelinesOf(repo, raw)).filter((one) => one.sourceSha === mr.sha);
          return { pr: { repo, number: input.number }, head: mr.sha, ...checksOf(ofHead) };
        },
      }),
    );

    api.action(
      action(forgePipelineRead, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const client = gitlab(repo.host);
          const raw =
            input.pipeline !== undefined
              ? [await client.get<GitLabPipeline>(projectPath(repo, `/pipelines/${String(input.pipeline)}`))]
              : await client.list<GitLabPipeline>(projectPath(repo, "/pipelines"), input.sha === undefined ? {} : { sha: input.sha });
          let items = await pipelinesOf(repo, raw);
          // A merge result runs on the merge commit, so the pipelines of a change are found by its own commit too.
          if (input.sha !== undefined && input.pipeline === undefined) {
            const merges = await client.get<GitLabPipeline[]>(projectPath(repo, "/pipelines"), { per_page: 50, order_by: "id", sort: "desc" });
            const extra = await pipelinesOf(
              repo,
              merges.filter((one) => kindOf(one).kind === "merge-result" || kindOf(one).kind === "train"),
            );
            const seen = new Set(items.map((one) => one.pipeline));
            items = [...items, ...extra.filter((one) => one.sourceSha === input.sha && !seen.has(one.pipeline))];
          }
          if (input.kind !== undefined) items = items.filter((one) => one.kind === input.kind);
          return { items: items.sort((a, b) => b.pipeline - a.pipeline) };
        },
      }),
    );

    const jobOf = (job: GitLabJob) => ({
      job: job.id,
      pipeline: job.pipeline.id,
      name: job.name,
      stage: job.stage,
      ref: job.ref,
      state: runStateOf(job.status),
      manual: job.status === "manual",
    });

    api.action(
      action(forgeJobRead, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const client = gitlab(repo.host);
          if (input.job !== undefined) return { items: [jobOf(await client.get<GitLabJob>(projectPath(repo, `/jobs/${String(input.job)}`)))] };
          if (input.pipeline === undefined) throw new ForgeError("refused", "forge.job.read needs a pipeline or a job");
          return { items: (await client.list<GitLabJob>(projectPath(repo, `/pipelines/${String(input.pipeline)}/jobs`))).map(jobOf) };
        },
      }),
    );

    api.action(
      action(forgeJobLog, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const whole = await gitlab(repo.host).text(projectPath(repo, `/jobs/${String(input.job)}/trace`));
          const bytes = Buffer.from(whole, "utf8");
          const keep = input.bytes ?? LOG_BYTES;
          const truncated = bytes.length > keep;
          return { job: input.job, log: truncated ? bytes.subarray(bytes.length - keep).toString("utf8") : whole, size: bytes.length, truncated };
        },
      }),
    );

    api.action(
      action(forgeCommentRead, {
        recovery: "repeat",
        effect: "read",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const discussions = await gitlab(repo.host).list<GitLabDiscussion>(projectPath(repo, `/merge_requests/${String(input.number)}/discussions`));
          return {
            items: discussions.flatMap((discussion) =>
              discussion.notes.map((note) => ({
                comment: note.id,
                discussion: discussion.id,
                author: note.author?.username ?? "",
                body: note.body,
                resolvable: note.resolvable ?? false,
                resolved: note.resolved ?? false,
                system: note.system ?? false,
              })),
            ),
          };
        },
      }),
    );

    // --- Writes on a pull request ---------------------------------------------------------------

    api.action(
      action(forgePrEnsure, {
        // An open pull request of the branch is found again, so a repeat updates the one it made.
        recovery: "repeat",
        effect: "write",
        world: "external",
        idempotent: true,
        async run(input) {
          const repo = await repoOf(input.repo);
          const client = gitlab(repo.host);
          const fields = {
            title: input.draft === true && !input.title.startsWith("Draft:") ? `Draft: ${input.title}` : input.title,
            target_branch: input.base,
            ...(input.description === undefined ? {} : { description: input.description }),
          };
          const open =
            input.number !== undefined
              ? await client.get<GitLabMr>(projectPath(repo, `/merge_requests/${String(input.number)}`))
              : (await client.list<GitLabMr>(projectPath(repo, "/merge_requests"), { source_branch: input.branch, state: "opened" }))[0];
          if (open !== undefined) {
            if (open.source_branch !== input.branch) {
              throw new ForgeError("refused", `pull request ${String(open.iid)} is of the branch "${open.source_branch}", not "${input.branch}"`);
            }
            const mr = await client.send<GitLabMr>("PUT", projectPath(repo, `/merge_requests/${String(open.iid)}`), fields);
            return { pr: { repo, number: mr.iid }, created: false, head: mr.sha };
          }
          const mr = await client.send<GitLabMr>("POST", projectPath(repo, "/merge_requests"), { source_branch: input.branch, ...fields });
          return { pr: { repo, number: mr.iid }, created: true, head: mr.sha };
        },
      }),
    );

    api.action(
      action(forgePrRetarget, {
        recovery: "repeat",
        effect: "write",
        world: "external",
        idempotent: true,
        async run(input) {
          const repo = await repoOf(input.repo);
          const mr = await gitlab(repo.host).send<GitLabMr>("PUT", projectPath(repo, `/merge_requests/${String(input.number)}`), { target_branch: input.base });
          return { pr: { repo, number: mr.iid }, base: mr.target_branch };
        },
      }),
    );

    api.action(
      action(forgePrClose, {
        recovery: "repeat",
        effect: "write",
        world: "external",
        idempotent: true,
        async run(input) {
          const repo = await repoOf(input.repo);
          const client = gitlab(repo.host);
          const path = projectPath(repo, `/merge_requests/${String(input.number)}`);
          const before = await client.get<GitLabMr>(path);
          if (before.state !== "opened") return { pr: { repo, number: input.number }, closed: false };
          await client.send("PUT", path, { state_event: "close" });
          return { pr: { repo, number: input.number }, closed: true };
        },
      }),
    );

    api.action(
      action(forgeCommentCreate, {
        // Two calls make two comments: a call that was cut off is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const made = await gitlab(repo.host).send<GitLabDiscussion>("POST", projectPath(repo, `/merge_requests/${String(input.number)}/discussions`), {
            body: input.body,
          });
          const note = made.notes[0];
          if (note === undefined) throw new ForgeError("server", "the server made a discussion with no comment");
          return { comment: note.id, discussion: made.id };
        },
      }),
    );

    api.action(
      action(forgeCommentReply, {
        recovery: "do-not-repeat",
        effect: "write",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          const note = await gitlab(repo.host).send<{ id: number }>(
            "POST",
            projectPath(repo, `/merge_requests/${String(input.number)}/discussions/${encodeURIComponent(input.discussion)}/notes`),
            { body: input.body },
          );
          return { comment: note.id, discussion: input.discussion };
        },
      }),
    );

    api.action(
      action(forgeCommentResolve, {
        recovery: "repeat",
        effect: "write",
        world: "external",
        idempotent: true,
        async run(input) {
          const repo = await repoOf(input.repo);
          const resolved = input.resolved ?? true;
          await gitlab(repo.host).send(
            "PUT",
            projectPath(repo, `/merge_requests/${String(input.number)}/discussions/${encodeURIComponent(input.discussion)}?resolved=${String(resolved)}`),
          );
          return { discussion: input.discussion, resolved };
        },
      }),
    );

    // --- Merging --------------------------------------------------------------------------------

    api.action(
      action(forgePrMerge, {
        recovery: "do-not-repeat",
        effect: "irreversible",
        world: "external",
        destructive: true,
        async run(input, ctx) {
          const repo = await repoOf(input.repo);
          return await merge(
            gitlab(repo.host),
            { pr: { repo, number: input.number }, expectHead: input.expectHead, method: input.method, when: input.when ?? "now" },
            ctx,
          );
        },
        check: (operationId) =>
          checkMerge(
            {
              journal,
              gitlab,
              emit: (data, id) => api.emit(MergeArmed, data, { id }),
            },
            operationId,
          ),
      }),
    );

    api.action(
      action(forgePrMergeCancel, {
        recovery: "repeat",
        effect: "write",
        world: "external",
        idempotent: true,
        async run(input, ctx) {
          const repo = await repoOf(input.repo);
          const cancelled = await cancelMerge(gitlab(repo.host), { repo, number: input.number }, journal(), (data) => ctx.emit(MergeDisarmed, data));
          return { cancelled };
        },
      }),
    );

    api.action(
      action(forgePrMergePending, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: () => ({ items: pendingMerges(journal()) }),
      }),
    );

    // --- Pipelines and jobs ---------------------------------------------------------------------

    /** The ref of a pipeline, which must be the one the call was granted for. */
    const onRef = async (client: GitLab, repo: Repo, what: string, path: string, ref: string): Promise<void> => {
      const found = await client.get<{ ref: string }>(path);
      if (found.ref !== ref) throw new ForgeError("wrong-ref", `${what} ran on "${found.ref}", not on "${ref}" the call names`);
    };

    api.action(
      action(forgePipelineTrigger, {
        recovery: "do-not-repeat",
        effect: "irreversible",
        world: "external",
        async run(input) {
          const repo = await repoOf(input.repo);
          // Every secret is resolved before the request: one that cannot be given stops the call.
          const variables = Object.entries(input.variables ?? {}).map(([key, value]) => ({
            key,
            value: typeof value === "string" ? value : resolveSecret(api.home(), value.secret, env),
          }));
          const made = await gitlab(repo.host).send<GitLabPipeline>("POST", projectPath(repo, "/pipeline"), {
            ref: input.ref,
            ...(variables.length === 0 ? {} : { variables }),
          });
          return { pipeline: made.id, ref: made.ref, sha: made.sha, state: runStateOf(made.status) };
        },
      }),
    );

    for (const [ref, verb, recovery] of [
      [forgePipelineRetry, "retry", "do-not-repeat"],
      [forgePipelineCancel, "cancel", "repeat"],
    ] as const) {
      api.action(
        action(ref, {
          recovery,
          effect: "irreversible",
          world: "external",
          async run(input) {
            const repo = await repoOf(input.repo);
            const client = gitlab(repo.host);
            const path = projectPath(repo, `/pipelines/${String(input.pipeline)}`);
            await onRef(client, repo, `pipeline ${String(input.pipeline)}`, path, input.ref);
            const done = await client.send<GitLabPipeline>("POST", `${path}/${verb}`);
            return { pipeline: done.id, state: runStateOf(done.status) };
          },
        }),
      );
    }

    for (const [ref, verb, recovery] of [
      [forgeJobRetry, "retry", "do-not-repeat"],
      [forgeJobCancel, "cancel", "repeat"],
      [forgeJobRun, "play", "do-not-repeat"],
    ] as const) {
      api.action(
        action(ref, {
          recovery,
          effect: "irreversible",
          world: "external",
          async run(input) {
            const repo = await repoOf(input.repo);
            const client = gitlab(repo.host);
            const path = projectPath(repo, `/jobs/${String(input.job)}`);
            await onRef(client, repo, `job ${String(input.job)}`, path, input.ref);
            const done = await client.send<GitLabJob>("POST", `${path}/${verb}`);
            return { job: done.id, state: runStateOf(done.status) };
          },
        }),
      );
    }
  });
}
