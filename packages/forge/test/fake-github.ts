// A GitHub server in memory: the part of the REST API the module speaks, over a model a test
// changes by hand. Every request is kept, with its headers, so a test sees what was asked and with
// which token. A read answers an ETag and a `304` to a matching `If-None-Match`; a test may queue
// an answer of its own (a 429, a 503) for the next request that matches a path. A list that says
// `per_page` is cut to the page asked for and answers the `Link` of the page that comes next.

import { createHash } from "node:crypto";

import { sha } from "./fake-gitlab.ts";

export interface FakeRule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface FakeCheckRun {
  sha: string;
  name: string;
  appId: number | null;
  status: string;
  conclusion: string | null;
}

export interface FakeStatus {
  sha: string;
  context: string;
  state: string;
}

export interface FakeWorkflowRun {
  id: number;
  file: string;
  sha: string;
  attempt: number;
  status: string;
  conclusion: string | null;
}

export interface FakeWorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface FakePull {
  number: number;
  state: "open" | "closed";
  title: string;
  draft: boolean;
  merged: boolean;
  branch: string;
  base: string;
  sha: string;
  author: string;
  merge_commit_sha: string | null;
  auto_merge: unknown;
}

export interface FakeRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ id?: number; name: string; bytes: Uint8Array }>;
}

export interface FakeRepo {
  id: number;
  slug: string;
  /** The tip of each branch, by name. */
  branches: Map<string, string>;
  /** The rules that apply to a branch, by name; an answer of the rules endpoint. */
  rules: Map<string, FakeRule[]>;
  /** The classic protection of a branch, by name; `undefined` answers with a 404. */
  protection: Map<string, unknown>;
  /** What a comparison of two revisions answers, by `base...head`. */
  compares: Map<string, { status: string; merge_base_commit: { sha: string } }>;
  pulls: Map<number, FakePull>;
  checkRuns: FakeCheckRun[];
  statuses: FakeStatus[];
  workflowRuns: FakeWorkflowRun[];
  jobs: Map<number, FakeWorkflowJob[]>;
  /** What a tag ref answers, by name. */
  tags: Map<string, { object: { sha: string; type: string } }>;
  /** What a tag object answers, by its own sha. */
  tagObjects: Map<string, { object: { sha: string; type: string } }>;
  releases: Map<string, FakeRelease>;
}

export interface SeenRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

interface Queued {
  method: string;
  path: RegExp;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class FakeGitHub {
  /** The REST root the module asks at, such as `https://api.github.com` or `https://github.example.com/api/v3`. */
  readonly url: string;
  readonly repos = new Map<string, FakeRepo>();
  readonly requests: SeenRequest[] = [];
  /** Headers every answer carries, such as the counts of the limit. */
  headers: Record<string, string> = {};
  readonly #queued: Queued[] = [];
  #ids = 5000;

  constructor(url = "https://api.github.com") {
    this.url = url;
  }

  /** The fetch the module is given. */
  readonly fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    if (!url.startsWith(this.url)) return json(502, { message: "unknown server" });
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v3/, "");
    const query = Object.fromEntries(parsed.searchParams);
    this.requests.push({ method: init.method, path, query, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const queued = this.#queued.findIndex((one) => one.method === init.method && one.path.test(path));
    if (queued !== -1) {
      const [one] = this.#queued.splice(queued, 1);
      if (one !== undefined) return json(one.status, one.body, { ...this.headers, ...one.headers });
    }
    const auth = init.headers.Authorization ?? "";
    if (auth !== `Bearer ${this.token}`) return json(401, { message: "Bad credentials" });
    const answer = this.#paged(init.method, path, query, init.headers, this.#route(init.method, path, query, init.headers));
    if (init.method === "GET" && answer.status === 200 && answer.etag !== undefined) {
      if (init.headers["If-None-Match"] === answer.etag) return new Response(null, { status: 304, headers: { ETag: answer.etag, ...this.headers } });
      return json(200, answer.body, { ETag: answer.etag, ...this.headers, ...answer.headers });
    }
    return json(answer.status, answer.body, { ...this.headers, ...answer.headers });
  };

  /** The token the server takes. */
  token = "ghp-test-token";

  /** Answer the next request of this method whose path matches with this, once. */
  queue(method: string, path: RegExp, status: number, body: unknown = {}, headers: Record<string, string> = {}): void {
    this.#queued.push({ method, path, status, headers, body });
  }

  /** The requests whose path matches. */
  seen(method: string, path: RegExp): SeenRequest[] {
    return this.requests.filter((one) => one.method === method && path.test(one.path));
  }

  repo(id: number, slug: string): FakeRepo {
    const made: FakeRepo = {
      id,
      slug,
      branches: new Map(),
      rules: new Map(),
      protection: new Map(),
      compares: new Map(),
      pulls: new Map(),
      checkRuns: [],
      statuses: [],
      workflowRuns: [],
      jobs: new Map(),
      tags: new Map(),
      tagObjects: new Map(),
      releases: new Map(),
    };
    this.repos.set(slug, made);
    return made;
  }

  branch(repo: FakeRepo, name: string, tip: string): void {
    repo.branches.set(name, tip);
  }

  rule(repo: FakeRepo, branch: string, type: string, parameters?: Record<string, unknown>): void {
    const rules = repo.rules.get(branch) ?? [];
    rules.push({ type, ...(parameters === undefined ? {} : { parameters }) });
    repo.rules.set(branch, rules);
  }

  compare(repo: FakeRepo, base: string, head: string, status: string, mergeBase: string): void {
    repo.compares.set(`${base}...${head}`, { status, merge_base_commit: { sha: mergeBase } });
  }

  pull(repo: FakeRepo, fields: Partial<FakePull> & { number: number; branch: string; sha: string }): FakePull {
    const made: FakePull = {
      state: "open",
      title: `PR ${String(fields.number)}`,
      draft: false,
      merged: false,
      base: "main",
      author: "dev",
      merge_commit_sha: null,
      auto_merge: null,
      ...fields,
    };
    repo.pulls.set(made.number, made);
    return made;
  }

  checkRun(repo: FakeRepo, fields: Partial<FakeCheckRun> & { name: string }): FakeCheckRun {
    const made: FakeCheckRun = { sha: repo.branches.get("main") ?? sha("head"), appId: 1, status: "completed", conclusion: "success", ...fields };
    repo.checkRuns.push(made);
    return made;
  }

  status(repo: FakeRepo, fields: Partial<FakeStatus> & { context: string }): FakeStatus {
    const made: FakeStatus = { sha: repo.branches.get("main") ?? sha("head"), state: "success", ...fields };
    repo.statuses.push(made);
    return made;
  }

  workflowRun(repo: FakeRepo, fields: Partial<FakeWorkflowRun> & { file: string; sha: string }): FakeWorkflowRun {
    const made: FakeWorkflowRun = { id: this.#next(), attempt: 1, status: "completed", conclusion: "success", ...fields };
    repo.workflowRuns.push(made);
    return made;
  }

  job(repo: FakeRepo, run: FakeWorkflowRun, fields: Partial<FakeWorkflowJob> & { name: string }): FakeWorkflowJob {
    const jobs = repo.jobs.get(run.id) ?? [];
    const made: FakeWorkflowJob = { status: "completed", conclusion: "success", ...fields };
    jobs.push(made);
    repo.jobs.set(run.id, jobs);
    return made;
  }

  /** A lightweight tag points at its commit; an annotated one at the tag object named by `object`. */
  tag(repo: FakeRepo, name: string, object: { sha: string; type: string }): void {
    repo.tags.set(name, { object });
  }

  tagObject(repo: FakeRepo, own: string, object: { sha: string; type: string }): void {
    repo.tagObjects.set(own, { object });
  }

  release(repo: FakeRepo, fields: Partial<FakeRelease> & { tag: string }): FakeRelease {
    const made: FakeRelease = { draft: false, prerelease: false, assets: [], ...fields };
    made.assets = made.assets.map((asset) => ({ ...asset, id: asset.id ?? this.#next() }));
    repo.releases.set(made.tag, made);
    return made;
  }

  #next(): number {
    this.#ids += 1;
    return this.#ids;
  }

  /** A list with `per_page` is cut to the page asked for, and the `Link` names the next page. */
  #paged(
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    answer: { status: number; body: unknown; headers?: Record<string, string>; pageable?: string },
  ): { status: number; body: unknown; headers?: Record<string, string>; etag?: string } {
    const items = answer.pageable === undefined ? answer.body : (answer.body as Record<string, unknown>)[answer.pageable];
    if (method !== "GET" || answer.status !== 200 || !Array.isArray(items) || query["per_page"] === undefined || headers.Accept?.includes("octet-stream") === true) {
      const etag = method === "GET" && answer.status === 200 ? weak(answer.body) : undefined;
      return { ...answer, etag };
    }
    const size = Number(query["per_page"]);
    const page = Number(query["page"] ?? "1");
    const shown = items.slice((page - 1) * size, page * size);
    const more = items.length > page * size;
    const body = answer.pageable === undefined ? shown : { ...(answer.body as Record<string, unknown>), [answer.pageable]: shown };
    if (!more) return { ...answer, body, etag: weak(body) };
    const next = new URL(`${this.url}${path}`);
    for (const [key, value] of Object.entries(query)) if (key !== "page") next.searchParams.set(key, value);
    next.searchParams.set("page", String(page + 1));
    return { ...answer, body, headers: { ...answer.headers, Link: `<${next.toString()}>; rel="next"` }, etag: weak(body) };
  }

  #route(method: string, path: string, query: Record<string, string>, headers: Record<string, string>): { status: number; body: unknown; headers?: Record<string, string>; pageable?: string } {
    const repo = [...this.repos.values()].find((one) => path === `/repos/${one.slug}` || path.startsWith(`/repos/${one.slug}/`));
    if (repo === undefined) return { status: 404, body: { message: "Not Found" } };
    const rest = path.slice(`/repos/${repo.slug}`.length);
    const notFound = { status: 404, body: { message: "Not Found" } };
    const get = (pattern: RegExp) => pattern.exec(rest);

    if (method === "GET" && rest === "") return { status: 200, body: { id: repo.id, full_name: repo.slug } };

    let hit: RegExpExecArray | null;

    if (method === "GET" && (hit = /^\/branches\/([^/]+)$/.exec(rest)) !== null) {
      const name = decodeURIComponent(hit[1] as string);
      const tip = repo.branches.get(name);
      if (tip === undefined) return notFound;
      return { status: 200, body: { name, commit: { sha: tip } } };
    }
    if (method === "GET" && (hit = /^\/branches\/([^/]+)\/protection$/.exec(rest)) !== null) {
      const name = decodeURIComponent(hit[1] as string);
      const protection = repo.protection.get(name);
      if (protection === undefined) return notFound;
      return { status: 200, body: protection };
    }
    if (method === "GET" && (hit = /^\/rules\/branches\/([^/]+)$/.exec(rest)) !== null) {
      const name = decodeURIComponent(hit[1] as string);
      return { status: 200, body: repo.rules.get(name) ?? [], pageable: undefined };
    }
    if (method === "GET" && (hit = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest)) !== null) {
      const compare = repo.compares.get(`${decodeURIComponent(hit[1] as string)}...${decodeURIComponent(hit[2] as string)}`);
      if (compare === undefined) return notFound;
      return { status: 200, body: { ...compare, total_commits: 0, ahead_by: 0, behind_by: 0 } };
    }
    if (method === "GET" && (hit = /^\/pulls\/(\d+)$/.exec(rest)) !== null) {
      const pull = repo.pulls.get(Number(hit[1]));
      if (pull === undefined) return notFound;
      return { status: 200, body: this.#pullJson(repo, pull) };
    }
    if (method === "GET" && rest === "/pulls") {
      const state = query.state ?? "open";
      const items = [...repo.pulls.values()].filter((pull) => state === "all" || pull.state === state);
      return { status: 200, body: items.map((pull) => this.#pullJson(repo, pull)) };
    }
    if (method === "GET" && (hit = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)) !== null) {
      const at = hit[1] as string;
      const runs = repo.checkRuns.filter((run) => run.sha === at);
      return { status: 200, body: { total_count: runs.length, check_runs: runs.map((run, at_) => ({ id: this.#ids + at_ + 1, name: run.name, status: run.status, conclusion: run.conclusion, app: run.appId === null ? null : { id: run.appId } })) }, pageable: "check_runs" };
    }
    if (method === "GET" && (hit = /^\/commits\/([0-9a-f]+)\/statuses$/.exec(rest)) !== null) {
      const at = hit[1] as string;
      return { status: 200, body: repo.statuses.filter((one) => one.sha === at).map((one) => ({ context: one.context, state: one.state })) };
    }
    if (method === "GET" && (hit = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest)) !== null) {
      const file = decodeURIComponent(hit[1] as string);
      const runs = repo.workflowRuns.filter((run) => run.file === file && (query.head_sha === undefined || run.sha === query.head_sha));
      return {
        status: 200,
        body: { total_count: runs.length, workflow_runs: runs.map((run) => ({ id: run.id, head_sha: run.sha, run_attempt: run.attempt, status: run.status, conclusion: run.conclusion, path: `.github/workflows/${file}` })) },
        pageable: "workflow_runs",
      };
    }
    if (method === "GET" && (hit = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)) !== null) {
      const jobs = repo.jobs.get(Number(hit[1])) ?? [];
      return { status: 200, body: { total_count: jobs.length, jobs: jobs.map((job, at) => ({ id: this.#ids + at + 1, name: job.name, status: job.status, conclusion: job.conclusion, steps: [] })) }, pageable: "jobs" };
    }
    if (method === "GET" && (hit = /^\/git\/ref\/tags\/([^/]+)$/.exec(rest)) !== null) {
      const tag = repo.tags.get(decodeURIComponent(hit[1] as string));
      if (tag === undefined) return notFound;
      return { status: 200, body: { ref: `refs/tags/${decodeURIComponent(hit[1] as string)}`, object: tag.object } };
    }
    if (method === "GET" && (hit = /^\/git\/tags\/([0-9a-f]{40})$/.exec(rest)) !== null) {
      const tag = repo.tagObjects.get(hit[1] as string);
      if (tag === undefined) return notFound;
      return { status: 200, body: { object: tag.object } };
    }
    if (method === "GET" && (hit = /^\/releases\/tags\/([^/]+)$/.exec(rest)) !== null) {
      const release = repo.releases.get(decodeURIComponent(hit[1] as string));
      if (release === undefined) return notFound;
      return { status: 200, body: this.#releaseJson(release) };
    }
    if (method === "GET" && (hit = /^\/releases\/assets\/(\d+)$/.exec(rest)) !== null) {
      const asset = [...repo.releases.values()].flatMap((release) => release.assets).find((one) => one.id === Number(hit?.[1]));
      if (asset === undefined) return notFound;
      if (headers.Accept?.includes("octet-stream") === true) {
        return { status: 200, body: asset.bytes, headers: { "Content-Type": "application/octet-stream" } };
      }
      return { status: 200, body: { name: asset.name, size: asset.bytes.length } };
    }
    return notFound;
  }

  #pullJson(repo: FakeRepo, pull: FakePull): unknown {
    return {
      number: pull.number,
      state: pull.state,
      title: pull.title,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.merged ? "2026-11-20T10:00:00Z" : null,
      head: { ref: pull.branch, sha: pull.sha },
      base: { ref: pull.base },
      user: { login: pull.author },
      merge_commit_sha: pull.merge_commit_sha,
      auto_merge: pull.auto_merge,
      html_url: `${this.url.replace(/\/api\/v3$/, "")}/${repo.slug}/pull/${String(pull.number)}`,
    };
  }

  #releaseJson(release: FakeRelease): unknown {
    return {
      tag_name: release.tag,
      draft: release.draft,
      prerelease: release.prerelease,
      assets: release.assets.map((asset) => ({
        id: asset.id ?? 0,
        name: asset.name,
        url: `${this.url}/repos/${this.#slugOf(release)}/releases/assets/${String(asset.id ?? 0)}`,
        browser_download_url: `${this.url.replace(/\/api\/v3$/, "")}/downloads/${asset.name}`,
      })),
    };
  }

  #slugOf(release: FakeRelease): string {
    for (const repo of this.repos.values()) if (repo.releases.get(release.tag) === release) return repo.slug;
    return "unknown/repo";
  }
}

/** A weak ETag of a body, as the server names what it answered. */
function weak(body: unknown): string {
  return `W/"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return new Response(bytes as unknown as BodyInit, { status, headers: { "Content-Type": body instanceof Uint8Array ? "application/octet-stream" : "application/json", ...headers } });
}
