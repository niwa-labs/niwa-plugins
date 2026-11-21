// A GitLab server in memory: the part of the REST API the forge module speaks, over a model a test
// changes by hand. Every request is kept, with its headers, so a test sees what was asked and with
// which token. A read answers an ETag and a `304` to a matching `If-None-Match`; a test may queue an
// answer of its own (a 429, a 409) for the next request that matches a path.

import { createHash } from "node:crypto";

export interface FakeMr {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed" | "merged" | "locked";
  source_branch: string;
  target_branch: string;
  sha: string;
  draft: boolean;
  author: string;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  merge_when_pipeline_succeeds: boolean;
  in_train: boolean;
  approvals: string[];
  updated_at: string;
}

export interface FakePipeline {
  id: number;
  sha: string;
  ref: string;
  status: string;
  source: string;
  tag: boolean;
  updated_at: string;
}

export interface FakeJob {
  id: number;
  pipeline: number;
  name: string;
  stage: string;
  status: string;
  ref: string;
  trace: string;
}

export interface FakeNote {
  id: number;
  body: string;
  author: string;
  resolvable: boolean;
  resolved: boolean;
  system: boolean;
}

export interface FakeDiscussion {
  id: string;
  mr: number;
  notes: FakeNote[];
}

export interface FakeEvent {
  id: number;
  action_name: string;
  target_type: string | null;
  target_iid: number | null;
  author: { username: string };
  push_data?: { ref: string; ref_type: "branch" | "tag"; commit_from: string | null; commit_to: string | null };
  note?: { id: number; body: string; noteable_type: string; noteable_iid: number; author: { username: string } };
  created_at: string;
}

export interface FakeProject {
  id: number;
  path_with_namespace: string;
  mrs: Map<number, FakeMr>;
  pipelines: FakePipeline[];
  jobs: FakeJob[];
  discussions: FakeDiscussion[];
  events: FakeEvent[];
  commits: Map<string, string[]>;
  /** The tip of each branch, by name. */
  branches: Map<string, string>;
  /** The variables each triggered pipeline was given, by pipeline id. */
  variables: Map<number, Array<{ key: string; value: string }>>;
  /** The project merges by fast-forward: a merge makes no merge commit, and a squash is the commit that lands. */
  fastForward: boolean;
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

/** A commit id of 40 hex characters made from a word, so a test can name commits. */
export function sha(word: string): string {
  return createHash("sha1").update(word).digest("hex");
}

export class FakeGitLab {
  readonly url: string;
  readonly projects = new Map<number, FakeProject>();
  readonly requests: SeenRequest[] = [];
  /** Headers every answer carries, such as the counts of the limit. */
  headers: Record<string, string> = {};
  /** The time the server stamps on what changes. */
  clock = Date.parse("2026-11-20T10:00:00Z");
  readonly #queued: Queued[] = [];
  #ids = 1000;

  constructor(url = "https://gitlab.example.com") {
    this.url = url;
  }

  /** The fetch the module is given. */
  readonly fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    const parsed = new URL(url);
    if (!url.startsWith(this.url)) return json(502, { message: "unknown server" });
    // The project is one segment, its path encoded: decode it alone, then the rest.
    const raw = parsed.pathname.replace(/^\/api\/v4/, "");
    const project = /^\/projects\/([^/]+)(.*)$/.exec(raw);
    const path = project === null ? decodeURIComponent(raw) : `/projects/${decodeURIComponent(project[1] as string)}${decodeURIComponent(project[2] ?? "")}`;
    const query = Object.fromEntries(parsed.searchParams);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method: init.method, path, query, headers: init.headers, body });
    const queued = this.#queued.findIndex((one) => one.method === init.method && one.path.test(path));
    if (queued !== -1) {
      const [one] = this.#queued.splice(queued, 1);
      if (one !== undefined) return json(one.status, one.body, { ...this.headers, ...one.headers });
    }
    if (init.headers["PRIVATE-TOKEN"] !== this.token) return json(401, { message: "401 Unauthorized" });
    const answer = this.#route(init.method, path, query, body);
    if (init.method === "GET" && answer.status === 200) {
      const etag = `W/"${createHash("sha1").update(JSON.stringify(answer.body)).digest("hex")}"`;
      if (init.headers["If-None-Match"] === etag) return new Response(null, { status: 304, headers: { ETag: etag, ...this.headers } });
      return json(200, answer.body, { ETag: etag, ...this.headers, ...answer.headers });
    }
    return json(answer.status, answer.body, { ...this.headers, ...answer.headers });
  };

  /** The token the server takes. */
  token = "glpat-test-token";

  /** Answer the next request of this method whose path matches with this, once. */
  queue(method: string, path: RegExp, status: number, body: unknown = {}, headers: Record<string, string> = {}): void {
    this.#queued.push({ method, path, status, headers, body });
  }

  /** The requests whose path matches. */
  seen(method: string, path: RegExp): SeenRequest[] {
    return this.requests.filter((one) => one.method === method && path.test(one.path));
  }

  project(id: number, path: string): FakeProject {
    const made: FakeProject = {
      id,
      path_with_namespace: path,
      mrs: new Map(),
      pipelines: [],
      jobs: [],
      discussions: [],
      events: [],
      commits: new Map(),
      branches: new Map(),
      variables: new Map(),
      fastForward: false,
    };
    this.projects.set(id, made);
    return made;
  }

  /** The time, moved on by a second: what a change is stamped with. */
  stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  mr(project: FakeProject, fields: Partial<FakeMr> & { iid: number; source_branch: string; sha: string }): FakeMr {
    const made: FakeMr = {
      title: `MR ${String(fields.iid)}`,
      description: "",
      state: "opened",
      target_branch: "main",
      draft: false,
      author: "dev",
      merge_commit_sha: null,
      squash_commit_sha: null,
      merge_when_pipeline_succeeds: false,
      in_train: false,
      approvals: [],
      updated_at: this.stamp(),
      ...fields,
    };
    project.mrs.set(made.iid, made);
    return made;
  }

  pipeline(project: FakeProject, fields: Partial<FakePipeline> & { sha: string; ref: string }): FakePipeline {
    const made: FakePipeline = { id: this.#next(), status: "running", source: "push", tag: false, updated_at: this.stamp(), ...fields };
    project.pipelines.push(made);
    return made;
  }

  job(project: FakeProject, fields: Partial<FakeJob> & { pipeline: number; ref: string }): FakeJob {
    const made: FakeJob = { id: this.#next(), name: "test", stage: "test", status: "running", trace: "", ...fields };
    project.jobs.push(made);
    return made;
  }

  event(project: FakeProject, fields: Partial<FakeEvent> & { action_name: string }): FakeEvent {
    const made: FakeEvent = { id: this.#next(), target_type: null, target_iid: null, author: { username: "dev" }, created_at: this.stamp(), ...fields };
    project.events.push(made);
    return made;
  }

  #next(): number {
    this.#ids += 1;
    return this.#ids;
  }

  #mrJson(project: FakeProject, mr: FakeMr): unknown {
    return {
      id: project.id * 10_000 + mr.iid,
      iid: mr.iid,
      project_id: project.id,
      title: mr.title,
      description: mr.description,
      state: mr.state,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      sha: mr.sha,
      draft: mr.draft,
      author: { username: mr.author },
      merge_commit_sha: mr.merge_commit_sha,
      squash_commit_sha: mr.squash_commit_sha,
      merge_when_pipeline_succeeds: mr.merge_when_pipeline_succeeds,
      updated_at: mr.updated_at,
      web_url: `${this.url}/${project.path_with_namespace}/-/merge_requests/${String(mr.iid)}`,
    };
  }

  /** A pipeline as the server shows it: a list gives the short form, which does not say whether the ref is a tag. */
  #pipelineJson(project: FakeProject, pipeline: FakePipeline, short = false): unknown {
    const fields = { id: pipeline.id, project_id: project.id, sha: pipeline.sha, ref: pipeline.ref, status: pipeline.status, source: pipeline.source, updated_at: pipeline.updated_at };
    return short ? fields : { ...fields, tag: pipeline.tag };
  }

  #jobJson(job: FakeJob): unknown {
    return { id: job.id, name: job.name, stage: job.stage, status: job.status, ref: job.ref, pipeline: { id: job.pipeline } };
  }

  #route(method: string, path: string, query: Record<string, string>, body: any): { status: number; body: unknown; headers?: Record<string, string> } {
    const project = [...this.projects.values()]
      .filter((one) => path === `/projects/${String(one.id)}` || path.startsWith(`/projects/${String(one.id)}/`) || path === `/projects/${one.path_with_namespace}`)
      .at(0);
    if (project === undefined) return { status: 404, body: { message: "404 Project Not Found" } };
    const rest = path.startsWith(`/projects/${String(project.id)}`) ? path.slice(`/projects/${String(project.id)}`.length) : "";
    const m = (pattern: RegExp) => pattern.exec(rest);
    const mrOf = (iid: string | undefined) => project.mrs.get(Number(iid));
    const notFound = { status: 404, body: { message: "404 Not found" } };
    let hit: RegExpExecArray | null;

    if (method === "GET" && rest === "") return { status: 200, body: { id: project.id, path_with_namespace: project.path_with_namespace } };

    if (method === "GET" && rest === "/merge_requests") {
      const items = [...project.mrs.values()].filter(
        (mr) =>
          (query["source_branch"] === undefined || mr.source_branch === query["source_branch"]) &&
          (query["state"] === undefined || query["state"] === "all" || mr.state === query["state"]) &&
          (query["updated_after"] === undefined || mr.updated_at > query["updated_after"]),
      );
      return { status: 200, body: items.map((mr) => this.#mrJson(project, mr)) };
    }
    if (method === "POST" && rest === "/merge_requests") {
      const iid = Math.max(0, ...project.mrs.keys()) + 1;
      const head = project.branches.get(body.source_branch) ?? sha(`${String(body.source_branch)}-head`);
      const mr = this.mr(project, { iid, source_branch: body.source_branch, target_branch: body.target_branch, title: body.title, description: body.description ?? "", sha: head });
      return { status: 201, body: this.#mrJson(project, mr) };
    }
    if ((hit = m(/^\/merge_requests\/(\d+)$/))) {
      const mr = mrOf(hit[1]);
      if (mr === undefined) return notFound;
      if (method === "GET") return { status: 200, body: this.#mrJson(project, mr) };
      if (method === "PUT") {
        if (body.title !== undefined) mr.title = body.title;
        if (body.description !== undefined) mr.description = body.description;
        if (body.target_branch !== undefined) mr.target_branch = body.target_branch;
        if (body.state_event === "close" && mr.state === "opened") mr.state = "closed";
        if (body.state_event === "reopen" && mr.state === "closed") mr.state = "opened";
        mr.updated_at = this.stamp();
        return { status: 200, body: this.#mrJson(project, mr) };
      }
    }
    if (method === "PUT" && (hit = m(/^\/merge_requests\/(\d+)\/merge$/))) {
      const mr = mrOf(hit[1]);
      if (mr === undefined) return notFound;
      if (mr.state !== "opened") return { status: 405, body: { message: "405 Method Not Allowed" } };
      if (body.sha !== undefined && body.sha !== mr.sha) return { status: 409, body: { message: "SHA does not match HEAD of source branch" } };
      if (body.merge_when_pipeline_succeeds === true || body.auto_merge === true) {
        mr.merge_when_pipeline_succeeds = true;
        mr.updated_at = this.stamp();
        return { status: 200, body: this.#mrJson(project, mr) };
      }
      mr.state = "merged";
      if (!project.fastForward) mr.merge_commit_sha = sha(`merge-${String(mr.iid)}-${mr.sha}`);
      if (body.squash === true) mr.squash_commit_sha = sha(`squash-${String(mr.iid)}`);
      mr.updated_at = this.stamp();
      return { status: 200, body: this.#mrJson(project, mr) };
    }
    if (method === "POST" && (hit = m(/^\/merge_requests\/(\d+)\/cancel_merge_when_pipeline_succeeds$/))) {
      const mr = mrOf(hit[1]);
      if (mr === undefined) return notFound;
      if (!mr.merge_when_pipeline_succeeds) return { status: 406, body: { message: "406 Not Acceptable" } };
      mr.merge_when_pipeline_succeeds = false;
      return { status: 201, body: this.#mrJson(project, mr) };
    }
    if ((hit = m(/^\/merge_trains\/merge_requests\/(\d+)$/))) {
      const mr = mrOf(hit[1]);
      if (mr === undefined) return notFound;
      if (method === "GET") return mr.in_train ? { status: 200, body: { merge_request: { iid: mr.iid }, status: "idle" } } : notFound;
      if (method === "POST") {
        if (body.sha !== undefined && body.sha !== mr.sha) return { status: 409, body: { message: "SHA does not match HEAD of source branch" } };
        mr.in_train = true;
        return { status: 201, body: [{ id: 1, merge_request: { iid: mr.iid }, status: "idle" }] };
      }
      if (method === "DELETE") {
        if (!mr.in_train) return notFound;
        mr.in_train = false;
        return { status: 204, body: null };
      }
    }
    if (method === "GET" && (hit = m(/^\/merge_requests\/(\d+)\/pipelines$/))) {
      const mr = mrOf(hit[1]);
      if (mr === undefined) return notFound;
      const items = project.pipelines.filter((one) => one.ref.startsWith(`refs/merge-requests/${String(mr.iid)}/`)).reverse();
      return { status: 200, body: items.map((one) => this.#pipelineJson(project, one, true)) };
    }
    if (method === "GET" && (hit = m(/^\/merge_requests\/(\d+)\/discussions$/))) {
      return { status: 200, body: project.discussions.filter((one) => one.mr === Number(hit?.[1])).map((one) => ({ id: one.id, notes: one.notes.map((note) => ({ ...note, author: { username: note.author } })) })) };
    }
    if (method === "POST" && (hit = m(/^\/merge_requests\/(\d+)\/discussions$/))) {
      const note: FakeNote = { id: this.#next(), body: body.body, author: "niwa", resolvable: true, resolved: false, system: false };
      const discussion: FakeDiscussion = { id: `d${String(note.id)}`, mr: Number(hit[1]), notes: [note] };
      project.discussions.push(discussion);
      return { status: 201, body: { id: discussion.id, notes: [{ ...note, author: { username: note.author } }] } };
    }
    if (method === "POST" && (hit = m(/^\/merge_requests\/(\d+)\/discussions\/([^/]+)\/notes$/))) {
      const discussion = project.discussions.find((one) => one.id === hit?.[2]);
      if (discussion === undefined) return notFound;
      const note: FakeNote = { id: this.#next(), body: body.body, author: "niwa", resolvable: true, resolved: false, system: false };
      discussion.notes.push(note);
      return { status: 201, body: { ...note, author: { username: note.author } } };
    }
    if (method === "PUT" && (hit = m(/^\/merge_requests\/(\d+)\/discussions\/([^/]+)$/))) {
      const discussion = project.discussions.find((one) => one.id === hit?.[2]);
      if (discussion === undefined) return notFound;
      for (const note of discussion.notes) note.resolved = query["resolved"] === "true";
      return { status: 200, body: { id: discussion.id, notes: discussion.notes.map((note) => ({ ...note, author: { username: note.author } })) } };
    }
    if (method === "GET" && rest === "/pipelines") {
      const items = project.pipelines
        .filter((one) => (query["sha"] === undefined || one.sha === query["sha"]) && (query["updated_after"] === undefined || one.updated_at > query["updated_after"]))
        .reverse();
      return { status: 200, body: items.map((one) => this.#pipelineJson(project, one, true)) };
    }
    if (method === "POST" && rest === "/pipeline") {
      const made = this.pipeline(project, { sha: sha(`${String(body.ref)}-tip`), ref: body.ref, status: "created", source: "api" });
      project.variables.set(made.id, body.variables ?? []);
      return { status: 201, body: this.#pipelineJson(project, made) };
    }
    if ((hit = m(/^\/pipelines\/(\d+)(\/retry|\/cancel|\/jobs)?$/))) {
      const pipeline = project.pipelines.find((one) => one.id === Number(hit?.[1]));
      if (pipeline === undefined) return notFound;
      if (method === "GET" && hit[2] === undefined) return { status: 200, body: this.#pipelineJson(project, pipeline) };
      if (method === "GET" && hit[2] === "/jobs") return { status: 200, body: project.jobs.filter((one) => one.pipeline === pipeline.id).map((one) => this.#jobJson(one)) };
      if (method === "POST" && hit[2] === "/retry") {
        pipeline.status = "running";
        pipeline.updated_at = this.stamp();
        return { status: 201, body: this.#pipelineJson(project, pipeline) };
      }
      if (method === "POST" && hit[2] === "/cancel") {
        pipeline.status = "canceled";
        pipeline.updated_at = this.stamp();
        return { status: 200, body: this.#pipelineJson(project, pipeline) };
      }
    }
    if ((hit = m(/^\/jobs\/(\d+)(\/retry|\/cancel|\/play|\/trace)?$/))) {
      const job = project.jobs.find((one) => one.id === Number(hit?.[1]));
      if (job === undefined) return notFound;
      if (method === "GET" && hit[2] === undefined) return { status: 200, body: this.#jobJson(job) };
      if (method === "GET" && hit[2] === "/trace") return { status: 200, body: job.trace };
      if (method === "POST" && hit[2] === "/retry") {
        const again = this.job(project, { pipeline: job.pipeline, ref: job.ref, name: job.name, stage: job.stage, status: "pending" });
        return { status: 201, body: this.#jobJson(again) };
      }
      if (method === "POST" && hit[2] === "/cancel") {
        job.status = "canceled";
        return { status: 201, body: this.#jobJson(job) };
      }
      if (method === "POST" && hit[2] === "/play") {
        if (job.status !== "manual") return { status: 400, body: { message: "400 Unplayable Job" } };
        job.status = "pending";
        return { status: 200, body: this.#jobJson(job) };
      }
    }
    if (method === "GET" && rest === "/events") {
      const items = [...project.events].sort((a, b) => (query["sort"] === "asc" ? a.id - b.id : b.id - a.id));
      return { status: 200, body: items };
    }
    if (method === "GET" && (hit = m(/^\/repository\/commits\/([0-9a-f]+)$/))) {
      const parents = project.commits.get(hit[1] as string);
      if (parents === undefined) return notFound;
      return { status: 200, body: { id: hit[1], parent_ids: parents } };
    }
    return { status: 404, body: { message: `404 no route ${method} ${rest}` } };
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (typeof body === "string") return new Response(body, { status, headers: { "Content-Type": "text/plain", ...headers } });
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
