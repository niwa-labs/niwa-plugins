/**
 * The targets of forge actions, as the rules of a grant name them.
 *
 * A target is segments between `/`: `<host>/<path>` for a repository, `<host>/<path>/pr/<n>` for a
 * pull request and `<host>/<path>/ref/<ref>` for a branch or a tag. A rule may end in `/*`, so
 * `forge.pr.merge@gitlab.example.com/acme/billing/pr/*` covers every pull request of one project and
 * nothing else. A template fills the repository from the input of a run:
 * `forge.pr.merge@{repo.host}/{repo.path}/pr/*`.
 */

import { callTarget } from "@niwa-labs/core";
import { z } from "zod";

/**
 * The name of a GitLab server as a target names it: a DNS name, lower case, without a scheme or a
 * port. A target segment cannot hold `:`, so a server on a port is configured by its URL and named
 * here by its host alone.
 */
export const ForgeHost = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/, "a host name, lower case, without a scheme or a port");
export type ForgeHost = z.infer<typeof ForgeHost>;

/** One segment of a project path: what GitLab allows in a group or project name. */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The full path of a project, `group/subgroup/project`. */
export const ProjectPath = z
  .string()
  .refine((path) => path.split("/").length >= 2 && path.split("/").every((segment) => PATH_SEGMENT.test(segment) && !segment.endsWith(".git")), {
    message: "a project path is its groups and its name between \"/\", such as acme/billing",
  });
export type ProjectPath = z.infer<typeof ProjectPath>;

/** A repository as a caller names it: the server and the path of the project. */
export const RepoName = z.strictObject({ host: ForgeHost, path: ProjectPath });
export type RepoName = z.infer<typeof RepoName>;

/**
 * A branch or a tag, as GitLab names it. It may hold `/` (`feature/login`); it may not be empty,
 * hold whitespace, `*`, `@`, `:` or braces, or have an empty segment: the target it makes must name
 * one place and widen nothing.
 */
export const RefName = z
  .string()
  .min(1)
  .refine((ref) => ref.split("/").every((segment) => segment.length > 0 && !/[\s*@:{}]/.test(segment)), {
    message: "a ref is segments between \"/\", none empty, without whitespace, \"*\", \"@\", \":\" or braces",
  });

/** The target of a repository: `<host>/<path>`. */
export function repoTarget(repo: RepoName): string {
  return callTarget(`${repo.host}/${repo.path}`);
}

/**
 * The target of a pull request: `<host>/<path>/pr/<n>`. A pull request that does not exist yet has
 * the number `new`, which a rule `…/pr/*` covers.
 */
export function prTarget(repo: RepoName, number: number | "new"): string {
  return callTarget(`${repoTarget(repo)}/pr/${String(number)}`);
}

/** The target of a branch or a tag: `<host>/<path>/ref/<ref>`. */
export function refTarget(repo: RepoName, ref: string): string {
  return callTarget(`${repoTarget(repo)}/ref/${ref}`);
}

/** The template of a rule on the pull requests of the repository a run is given as `repo`. */
export function prRule(action: string): string {
  return `${action}@{repo.host}/{repo.path}/pr/*`;
}

/** The template of a rule on the refs of the repository a run is given as `repo`. */
export function refRule(action: string): string {
  return `${action}@{repo.host}/{repo.path}/ref/*`;
}

/** The template of a rule on the repository a run is given as `repo`. */
export function repoRule(action: string): string {
  return `${action}@{repo.host}/{repo.path}`;
}
