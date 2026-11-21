/**
 * The REST API of a GitLab server, as the module speaks to it.
 *
 * `fetch` is given, so a test speaks to a fake server and nothing here reaches the network by
 * itself. A read keeps the ETag of every URL it read, page by page, and asks again with
 * `If-None-Match`: a `304` answers what was read before. The server's own counts of the limit are
 * what the client goes by: when `RateLimit-Remaining` reaches zero it does not ask again before
 * `RateLimit-Reset`, and a `429` is refused for its `Retry-After`. The token goes in a header and
 * nowhere else: no error says it.
 */

import { CatchableError } from "@niwa-labs/core";

/** What the client fetches with: the global `fetch`, or a fake server. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

/** Why a call to the server did not do what it was asked. */
export type ForgeErrorCode =
  | "unknown-server"
  | "unknown-secret"
  | "unsafe-secret"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "refused"
  | "rate-limited"
  | "server"
  | "not-watched"
  | "wrong-ref";

/**
 * A refusal of the forge module or of the server: the code says which, the message says why. It is
 * the caller's to catch: a pull request that is gone or a limit that is spent is an answer.
 */
export class ForgeError extends CatchableError {
  override name = "ForgeError";
  override readonly code: ForgeErrorCode;
  /** The HTTP status of the server's answer, when the server answered. */
  readonly status: number | undefined;
  /** For `rate-limited`: how long to wait before asking again. */
  readonly retryAfterMs: number | undefined;

  constructor(code: ForgeErrorCode, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface GitLabOptions {
  /** The base URL of the server, such as `https://gitlab.example.com`. */
  readonly url: string;
  /** The token, read when a request is made: the owner may replace it while the host runs. */
  readonly token: () => string;
  readonly fetch: FetchLike;
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number;
}

/** A query string, from values that are set. */
export type Query = Record<string, string | number | boolean | undefined>;

/** What was read from a URL, and the tag that names it. */
interface Cached {
  readonly etag: string;
  readonly body: unknown;
  readonly next: string | undefined;
}

/** The most pages a list reads: past it the list is cut, rather than read for ever. */
const MAX_PAGES = 20;

/** A client of one GitLab server. */
export class GitLab {
  readonly #options: GitLabOptions;
  readonly #cache = new Map<string, Cached>();
  /** The moment before which the server is not asked again; 0 when nothing holds it back. */
  #blockedUntil = 0;

  constructor(options: GitLabOptions) {
    this.#options = options;
  }

  /** How long until the server may be asked again, in milliseconds; 0 when it may be now. */
  waitMs(): number {
    return Math.max(0, this.#blockedUntil - this.#options.now());
  }

  /** Read one resource. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    return (await this.#read(this.#url(path, { ...query }))).body as T;
  }

  /** Read every page of a list, up to a bound. */
  async list<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    let page: string | undefined = "1";
    for (let read = 0; page !== undefined && read < MAX_PAGES; read += 1) {
      const answer: Cached = await this.#read(this.#url(path, { per_page: 100, ...query, page }));
      items.push(...(answer.body as T[]));
      page = answer.next;
    }
    return items;
  }

  /** Read the text of a resource, such as the log of a job. */
  async text(path: string): Promise<string> {
    const response = await this.#fetch("GET", this.#url(path, {}), {});
    return await response.text();
  }

  /** Change something: `POST`, `PUT` or `DELETE`, with a JSON body. */
  async send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(method, this.#url(path, {}), body === undefined ? {} : { "Content-Type": "application/json" }, body);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  }

  #url(path: string, query: Query): string {
    const url = new URL(`${this.#options.url.replace(/\/+$/, "")}/api/v4${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async #read(url: string): Promise<Cached> {
    const cached = this.#cache.get(url);
    const response = await this.#fetch("GET", url, cached === undefined ? {} : { "If-None-Match": cached.etag });
    if (response.status === 304 && cached !== undefined) return cached;
    const body: unknown = await response.json();
    const next = response.headers.get("X-Next-Page") ?? "";
    const answer: Cached = { etag: response.headers.get("ETag") ?? "", body, next: next.length > 0 ? next : undefined };
    if (answer.etag.length > 0) this.#cache.set(url, answer);
    else this.#cache.delete(url);
    return answer;
  }

  async #fetch(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    const wait = this.waitMs();
    if (wait > 0) {
      throw new ForgeError("rate-limited", `the server's request limit is spent; it may be asked again in ${String(Math.ceil(wait / 1000))}s`, {
        retryAfterMs: wait,
      });
    }
    const init = {
      method,
      headers: { Accept: "application/json", ...headers, "PRIVATE-TOKEN": this.#options.token() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await this.#options.fetch(url, init);
    } catch (error) {
      throw new ForgeError("server", `${method} ${pathOf(url)} did not reach the server: ${error instanceof Error ? error.name : "error"}`);
    }
    this.#note(response);
    if (response.ok || response.status === 304) return response;
    throw await errorOf(method, url, response, this.waitMs());
  }

  /** Take the server's counts of its limit. */
  #note(response: Response): void {
    const now = this.#options.now();
    if (response.status === 429) {
      this.#blockedUntil = Math.max(this.#blockedUntil, now + retryAfterMs(response.headers.get("Retry-After"), now));
      return;
    }
    const remaining = Number(response.headers.get("RateLimit-Remaining") ?? Number.NaN);
    const reset = Number(response.headers.get("RateLimit-Reset") ?? Number.NaN);
    if (remaining === 0 && Number.isFinite(reset)) this.#blockedUntil = Math.max(this.#blockedUntil, reset * 1000);
  }
}

/** `Retry-After` in milliseconds: seconds or an HTTP date; a minute when the server does not say. */
function retryAfterMs(header: string | null, now: number): number {
  if (header === null) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : 60_000;
}

/** The path of a URL, for a message: never its query, never a header. */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** The error a failed answer stands for, with what the server said. */
async function errorOf(method: string, url: string, response: Response, waitMs: number): Promise<ForgeError> {
  const said = await messageOf(response);
  const what = `${method} ${pathOf(url)}: ${String(response.status)}${said === undefined ? "" : ` ${said}`}`;
  const status = response.status;
  if (status === 429) return new ForgeError("rate-limited", what, { status, retryAfterMs: waitMs });
  if (status === 401) return new ForgeError("unauthorized", what, { status });
  if (status === 403) return new ForgeError("forbidden", what, { status });
  if (status === 404) return new ForgeError("not-found", what, { status });
  if (status === 409) return new ForgeError("conflict", what, { status });
  if (status >= 400 && status < 500) return new ForgeError("refused", what, { status });
  return new ForgeError("server", what, { status });
}

/** The `message` or `error` of an answer, as text, bounded. */
async function messageOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const said = body.message ?? body.error;
    if (said === undefined) return undefined;
    const text = typeof said === "string" ? said : JSON.stringify(said);
    return text.slice(0, 500);
  } catch {
    return undefined;
  }
}
