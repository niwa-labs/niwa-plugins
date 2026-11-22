/**
 * The REST API of a GitHub server, as the release workflows of the module speak to it: a client
 * that only reads. `github.com` is asked at `https://api.github.com` and any other host is a
 * GitHub Enterprise Server, asked at `<url>/api/v3`; the owner may also name the API root in `url`
 * and the `/api/v3` is not added twice.
 *
 * `fetch` is given, so a test speaks to a fake server and nothing here reaches the network by
 * itself. A read keeps the ETag of every URL it read, page by page, and asks again with
 * `If-None-Match`: a `304` answers what was read before. The pages of a list follow the `Link` the
 * server gives, `rel="next"` by `rel="next"`. The server's own counts of the limit are what the
 * client goes by: when `x-ratelimit-remaining` reaches zero it does not ask again before
 * `x-ratelimit-reset`, and a `429` — or a `403` the server marks with a `Retry-After` — is refused
 * for that long. A read is safe to repeat, so one that the server could not answer is asked again,
 * a few times, after a short wait; a refusal the server means is not. The token goes in a header
 * and nowhere else: no error says it.
 */

import { createHash } from "node:crypto";

import { ForgeError } from "./gitlab.ts";
import type { FetchLike, Query } from "./gitlab.ts";

/** A query string, from values that are set. */
export type { Query };

/** The options a GitHub client is made of. */
export interface GitHubOptions {
  /** The host as the forge names the server, such as `github.com` or `github.example.com`. */
  readonly host: string;
  /** The base URL of the server, such as `https://github.example.com`. Default: `https://<host>`. */
  readonly url?: string;
  /** The token, read when a request is made: the owner may replace it while the host runs. */
  readonly token: () => string;
  readonly fetch: FetchLike;
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number;
  /** How a retry waits. Default: the timer of the process. A test gives one that does not. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What was read from a URL, and the tag that names it. */
interface Cached {
  readonly etag: string;
  readonly body: unknown;
  readonly next: string | undefined;
}

/** The most pages a list reads: past it the list is cut, rather than read for ever. */
const MAX_PAGES = 20;

/** How many times a read the server could not answer is asked again. */
const ATTEMPTS = 3;

/** The longest wait a retry takes: a limit that asks for more is surfaced, not slept away. */
const RETRY_WAIT_MS = 5_000;

/** The version of the API the client pins itself to. */
const API_VERSION = "2022-11-28";

/** The REST root of the server the client speaks to. */
export function apiRoot(options: { readonly host: string; readonly url?: string }): string {
  if (options.host === "github.com" || options.host === "api.github.com") return "https://api.github.com";
  const server = (options.url ?? `https://${options.host}`).replace(/\/+$/, "");
  return `${server.replace(/\/api\/v3$/, "")}/api/v3`;
}

/** A client of one GitHub server, that only reads. */
export class GitHub {
  readonly #options: GitHubOptions;
  readonly #root: string;
  readonly #cache = new Map<string, Cached>();
  /** The moment before which the server is not asked again; 0 when nothing holds it back. */
  #blockedUntil = 0;

  constructor(options: GitHubOptions) {
    this.#options = options;
    this.#root = apiRoot(options);
  }

  /** How long until the server may be asked again, in milliseconds; 0 when it may be now. */
  waitMs(): number {
    return Math.max(0, this.#blockedUntil - this.#options.now());
  }

  /** Read one resource. `where` is a path of the API, or the absolute URL of one, such as the URL
   * of a release asset. */
  async get<T>(where: string, query: Query = {}, headers: Record<string, string> = {}): Promise<T> {
    return (await this.#read(this.#url(where, query), headers)).body as T;
  }

  /** Read every page of a list, up to a bound. With `enough`, the reading stops after the first page
   * of which it says the rest is not needed. */
  async list<T>(where: string, query: Query = {}, enough?: (page: readonly T[]) => boolean): Promise<T[]> {
    return (await this.pages<T>(where, query, enough === undefined ? {} : { enough })).items;
  }

  /** The same, with the bound given, and the answer says whether the list was cut by it: `truncated`
   * is true when the server had a page more that was not read and `enough` had not asked to stop. */
  async pages<T>(
    where: string,
    query: Query = {},
    opts: { enough?: (page: readonly T[]) => boolean; maxPages?: number } = {},
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    const bound = opts.maxPages ?? MAX_PAGES;
    let next: string | undefined = this.#url(where, { per_page: 100, ...query, page: 1 });
    for (let read = 0; next !== undefined; read += 1) {
      if (read >= bound) return { items, truncated: true };
      const answer: Cached = await this.#read(next, {});
      const got = answer.body as T[];
      items.push(...got);
      if (opts.enough?.(got) === true) break;
      next = answer.next;
    }
    return { items, truncated: false };
  }

  /** Read a resource of bytes, such as a release asset, and its SHA-256. */
  async download(where: string): Promise<{ bytes: Uint8Array; sha256: string }> {
    const buffer = await this.#retry(async () => {
      const response = await this.#send("GET", this.#url(where, {}), { Accept: "application/octet-stream" });
      return new Uint8Array(await response.arrayBuffer());
    });
    return { bytes: buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
  }

  #url(where: string, query: Query): string {
    // An absolute URL the server named, such as the URL of a release asset, must be this server's.
    if (/^https?:\/\//.test(where) && !where.startsWith(this.#root)) {
      throw new ForgeError("refused", `${pathOf(where)} is not this server's to answer`);
    }
    const full = where.startsWith(this.#root) ? where : `${this.#root}${where.startsWith("/") ? where : `/${where}`}`;
    const url = new URL(full);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async #read(url: string, headers: Record<string, string>): Promise<Cached> {
    const cached = this.#cache.get(url);
    const answer = await this.#retry(() => this.#send("GET", url, cached === undefined ? headers : { "If-None-Match": cached.etag, ...headers }));
    if (answer.status === 304 && cached !== undefined) return cached;
    const body: unknown = answer.headers.get("Content-Type")?.includes("application/json") === false
      ? await answer.text()
      : await answer.json();
    const answerOf: Cached = { etag: answer.headers.get("ETag") ?? "", body, next: nextOf(answer) };
    if (answerOf.etag.length > 0) this.#cache.set(url, answerOf);
    else this.#cache.delete(url);
    return answerOf;
  }

  /** One request, without retries: the caller decides whether the answer is worth asking again. */
  async #send(method: string, url: string, headers: Record<string, string>): Promise<Response> {
    const wait = this.waitMs();
    if (wait > 0) {
      throw new ForgeError("rate-limited", `the server's request limit is spent; it may be asked again in ${String(Math.ceil(wait / 1000))}s`, {
        retryAfterMs: wait,
      });
    }
    const token = this.#options.token();
    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          ...headers,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      throw new ForgeError("server", `${method} ${pathOf(url)} did not reach the server: ${error instanceof Error ? error.name : "error"}`);
    }
    this.#note(response);
    if (response.ok || response.status === 304) return response;
    throw await errorOf(method, url, response, this.waitMs(), [token]);
  }

  /** A read that the server could not answer is asked again, a few times, after a short wait; one
   * it refused is not. Only a `GET` is repeated: nothing else is sent, so all of this is safe. */
  async #retry<T>(read: () => Promise<T>): Promise<T> {
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    let error: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(RETRY_WAIT_MS, waitOf(error)));
      try {
        return await read();
      } catch (caught) {
        error = caught;
        if (!(caught instanceof ForgeError)) throw caught;
        if (caught.code !== "server" && caught.code !== "rate-limited") throw caught;
      }
    }
    throw error;
  }

  /** Take the server's counts of its limit, also of the `403` a limit spends itself with. */
  #note(response: Response): void {
    const now = this.#options.now();
    if (response.status === 429 || response.headers.get("Retry-After") !== null) {
      this.#blockedUntil = Math.max(this.#blockedUntil, now + retryAfterMs(response.headers.get("Retry-After"), now));
      return;
    }
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
    if (remaining === 0 && Number.isFinite(reset)) this.#blockedUntil = Math.max(this.#blockedUntil, reset * 1000);
  }
}

/** The wait an error asks for, when it asks for one. */
function waitOf(error: unknown): number {
  return error instanceof ForgeError ? (error.retryAfterMs ?? 0) : 0;
}

/** `rel="next"` of a `Link` header: the URL of the page that comes next, when there is one. */
function nextOf(response: Response): string | undefined {
  const link = response.headers.get("Link");
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    const found = /^\s*<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (found !== null) return found[1];
  }
  return undefined;
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
async function errorOf(method: string, url: string, response: Response, waitMs: number, secrets: readonly string[]): Promise<ForgeError> {
  const said = await messageOf(response, secrets);
  const what = `${method} ${pathOf(url)}: ${String(response.status)}${said === undefined ? "" : ` ${said}`}`;
  const status = response.status;
  if (status === 429 || (status === 403 && (response.headers.get("Retry-After") !== null || response.headers.get("x-ratelimit-remaining") === "0"))) {
    return new ForgeError("rate-limited", what, { status, retryAfterMs: waitMs });
  }
  if (status === 401) return new ForgeError("unauthorized", what, { status });
  if (status === 403) return new ForgeError("forbidden", what, { status });
  if (status === 404) return new ForgeError("not-found", what, { status });
  if (status === 409) return new ForgeError("conflict", what, { status });
  if (status >= 400 && status < 500) return new ForgeError("refused", what, { status });
  return new ForgeError("server", what, { status });
}

/**
 * The `message` of an answer, as text, bounded. The secrets are taken out of the whole text first:
 * cut before, one that straddles the bound would leave its first characters in.
 */
async function messageOf(response: Response, secrets: readonly string[]): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (body.message === undefined) return undefined;
    let text = typeof body.message === "string" ? body.message : JSON.stringify(body.message);
    for (const value of secrets) if (value.length > 0) text = text.split(value).join("[secret]");
    return text.slice(0, 500);
  } catch {
    return undefined;
  }
}
