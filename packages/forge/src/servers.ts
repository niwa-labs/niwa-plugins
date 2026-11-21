/**
 * The servers the module is configured with, and the repositories it knows on them.
 *
 * One client per server, made when it is first needed and kept, so its ETags and its counts of the
 * limit live as long as the host. The token is resolved for each request: a secret the owner
 * replaces is taken without a restart.
 */

import { seq } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";

import type { SecretRef } from "./actions.ts";
import { ForgeError, GitLab } from "./gitlab.ts";
import type { FetchLike } from "./gitlab.ts";
import { RepoUnwatched, RepoWatched } from "./record-types.ts";
import type { Repo } from "./record-types.ts";
import { resolveSecret } from "./secrets.ts";
import type { RepoName } from "./targets.ts";

/** A GitLab server the module speaks to. */
export interface ForgeServer {
  /** The name of the server as targets name it: its host, without a port. */
  readonly host: string;
  /** Its base URL. Default: `https://<host>`. */
  readonly url?: string;
  /** The secret that holds its token, such as `secret("GITLAB_TOKEN")`. */
  readonly token: SecretRef;
}

/** What the servers need from the host. */
export interface ServersPlace {
  readonly home: () => string;
  readonly now: () => number;
  readonly fetch: FetchLike;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A repository watched now, and the last event of its log when it was watched. */
export interface Watched {
  readonly repo: Repo;
  readonly since: number;
}

/** The repositories watched now, by `<host>/<path>`, folded from the journal. */
export function watching(journal: JournalReader | undefined): Map<string, Watched> {
  const watched = new Map<string, Watched>();
  if (journal === undefined) return watched;
  for (const stored of journal.since(seq(0), [RepoWatched.name, RepoUnwatched.name])) {
    if (stored.type === RepoWatched.name) {
      const parsed = RepoWatched.schema.safeParse(stored.data);
      if (parsed.success) watched.set(repoKey(parsed.data.repo), parsed.data);
      continue;
    }
    const parsed = RepoUnwatched.schema.safeParse(stored.data);
    if (parsed.success) watched.delete(repoKey(parsed.data.repo));
  }
  return watched;
}

/** The repositories watched now, by `<host>/<path>`. */
export function watchedRepos(journal: JournalReader | undefined): Map<string, Repo> {
  return new Map([...watching(journal)].map(([key, one]) => [key, one.repo]));
}

/** The key of a repository: `<host>/<path>`. */
export function repoKey(repo: RepoName): string {
  return `${repo.host}/${repo.path}`;
}

export class Servers {
  readonly #byHost = new Map<string, ForgeServer>();
  readonly #clients = new Map<string, GitLab>();
  readonly #place: ServersPlace;

  constructor(servers: readonly ForgeServer[], place: ServersPlace) {
    for (const server of servers) {
      if (this.#byHost.has(server.host)) throw new TypeError(`forge: the server "${server.host}" is configured twice`);
      this.#byHost.set(server.host, server);
    }
    this.#place = place;
  }

  /** The hosts configured. */
  hosts(): string[] {
    return [...this.#byHost.keys()];
  }

  /** The client of a server. */
  client(host: string): GitLab {
    const known = this.#clients.get(host);
    if (known !== undefined) return known;
    const server = this.#byHost.get(host);
    if (server === undefined) throw new ForgeError("unknown-server", `no GitLab server "${host}" is configured`);
    const made = new GitLab({
      url: server.url ?? `https://${host}`,
      token: () => resolveSecret(this.#place.home(), server.token.secret, this.#place.env),
      fetch: this.#place.fetch,
      now: this.#place.now,
    });
    this.#clients.set(host, made);
    return made;
  }

  /** The repository of a name: as it is watched, else as the server says now. */
  async repo(name: RepoName, journal: JournalReader | undefined): Promise<Repo> {
    const watched = watchedRepos(journal).get(repoKey(name));
    if (watched !== undefined) return watched;
    return await this.lookup(name);
  }

  /** The repository of a name, as the server says now. */
  async lookup(name: RepoName): Promise<Repo> {
    const project = await this.client(name.host).get<{ id: number }>(`/projects/${encodeURIComponent(name.path)}`);
    return { host: name.host, path: name.path, projectId: project.id };
  }
}

/** The path of a project's resource in the API. */
export function projectPath(repo: Repo, rest = ""): string {
  return `/projects/${String(repo.projectId)}${rest}`;
}
