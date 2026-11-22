// The REST client of GitHub: the token in a header and nowhere else, ETags by URL and page, the
// pages of a list by the `Link` the server gives, the server's limit, and a read the server could
// not answer asked again after a wait.

import { expect, test } from "bun:test";

import { GitHub, apiRoot } from "../src/github.ts";
import { ForgeError } from "../src/gitlab.ts";
import { FakeGitHub } from "./fake-github.ts";
import { sha } from "./fake-gitlab.ts";

function client(server: FakeGitHub, now = () => 1_000_000, waits: number[] = []) {
  return new GitHub({
    host: server.url === "https://api.github.com" ? "github.com" : "github.example.com",
    token: () => server.token,
    fetch: server.fetch,
    now,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
}

test("github.com is asked at api.github.com, and another host is an Enterprise Server asked at /api/v3", () => {
  expect(apiRoot({ host: "github.com" })).toBe("https://api.github.com");
  expect(apiRoot({ host: "api.github.com" })).toBe("https://api.github.com");
  expect(apiRoot({ host: "github.example.com" })).toBe("https://github.example.com/api/v3");
  expect(apiRoot({ host: "github.example.com", url: "https://github.example.com/" })).toBe("https://github.example.com/api/v3");
  expect(apiRoot({ host: "github.example.com", url: "https://github.example.com/api/v3" })).toBe("https://github.example.com/api/v3");
});

test("every request carries the token as a bearer, the version and the media type", async () => {
  const server = new FakeGitHub("https://github.example.com/api/v3");
  server.repo(42, "acme/billing");
  await client(server).get("/repos/acme/billing");
  const asked = server.requests[0]?.headers;
  expect(asked?.Authorization).toBe(`Bearer ${server.token}`);
  expect(asked?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
  expect(asked?.Accept).toBe("application/vnd.github+json");
  expect(server.requests[0]?.path).toBe("/repos/acme/billing");
});

test("a list reads every page the Link names, and keeps the ETag of each page apart", async () => {
  const server = new FakeGitHub("https://api.github.com");
  const repo = server.repo(42, "acme/billing");
  const at = sha("main");
  server.branch(repo, "main", at);
  for (let made = 0; made < 3; made += 1) server.status(repo, { context: `check-${String(made)}` });
  const github = client(server);
  const statuses = await github.list<{ context: string }>(`/repos/acme/billing/commits/${at}/statuses`);
  expect(statuses.map((one) => one.context)).toEqual(["check-0", "check-1", "check-2"]);
  // Two pages of two: the second is the Link of the first, an absolute URL of the same server.
  server.queue("GET", /\/statuses$/, 200, [{ context: "one" }], { ETag: "page-1", Link: `<${server.url}/repos/acme/billing/commits/${at}/statuses?per_page=100&page=2>; rel="next"` });
  server.queue("GET", /\/statuses$/, 200, [{ context: "two" }], { ETag: "page-2" });
  expect(await github.list(`/repos/acme/billing/commits/${at}/statuses`)).toEqual([{ context: "one" }, { context: "two" }]);
  server.queue("GET", /\/statuses$/, 304, null, { ETag: "page-1" });
  server.queue("GET", /\/statuses$/, 304, null, { ETag: "page-2" });
  expect(await github.list(`/repos/acme/billing/commits/${at}/statuses`)).toEqual([{ context: "one" }, { context: "two" }]);
  const asked = server.seen("GET", /\/statuses$/);
  expect(asked.map((one) => [one.query["page"], one.headers["If-None-Match"]])).toEqual([
    ["1", undefined],
    // The walk of the queued pages asks page 1 again, conditionally: the one answer the queue held
    // for it is what comes back, not the 304 the tag would have asked for.
    ["1", expect.stringMatching(/^W\//)],
    ["2", undefined],
    ["1", "page-1"],
    ["2", "page-2"],
  ]);
});

test("a read asks again with the ETag it was given, and a 304 answers what was read before", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  const github = client(server);
  const first = await github.get<{ id: number }>("/repos/acme/billing");
  const second = await github.get<{ id: number }>("/repos/acme/billing");
  expect(second).toEqual(first);
  const [one, two] = server.seen("GET", /^\/repos\/acme\/billing$/);
  expect(one?.headers["If-None-Match"]).toBeUndefined();
  expect(two?.headers["If-None-Match"]).toMatch(/^W\//);
});

test("a 429 is refused for its Retry-After, and the server is not asked again before it", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  let now = 1_000_000;
  const waits: number[] = [];
  const github = client(server, () => now, waits);
  server.queue("GET", /^\/repos\/acme\/billing$/, 429, { message: "You have exceeded a secondary rate limit" }, { "Retry-After": "30" });
  const error = await github.get("/repos/acme/billing").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForgeError);
  expect((error as ForgeError).code).toBe("rate-limited");
  expect((error as ForgeError).retryAfterMs).toBe(30_000);
  // The block holds the asks that come again: one request was made, and no more until it lifts.
  expect(server.requests).toHaveLength(1);
  expect(waits).toEqual([5_000, 5_000]);
  now += 30_000;
  expect(await github.get<{ id: number }>("/repos/acme/billing")).toMatchObject({ id: 42 });
});

test("a spent limit holds the client back until the server's reset", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  let now = 1_000_000;
  const github = client(server, () => now, []);
  server.headers = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 10_000) / 1000) };
  await github.get("/repos/acme/billing");
  expect(github.waitMs()).toBe(10_000);
  await expect(github.get("/repos/acme/billing")).rejects.toThrow(ForgeError);
  server.headers = {};
  now += 10_000;
  await github.get("/repos/acme/billing");
  expect(server.requests).toHaveLength(2);
});

test("a 403 the server marks with a Retry-After is a limit, and one it does not mark is forbidden", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  const limited = client(server);
  server.queue("GET", /^\/repos\/acme\/billing$/, 403, { message: "Resource not accessible by integration" }, { "Retry-After": "1" });
  const error = await limited.get("/repos/acme/billing").catch((caught: unknown) => caught);
  expect((error as ForgeError).code).toBe("rate-limited");

  const forbidden = client(server);
  server.queue("GET", /^\/repos\/acme\/billing$/, 403, { message: "Resource not accessible by integration" });
  const refused = await forbidden.get("/repos/acme/billing").catch((caught: unknown) => caught);
  expect((refused as ForgeError).code).toBe("forbidden");
  expect((refused as ForgeError).status).toBe(403);
});

test("a read the server could not answer is asked again after a wait, and one it refused is not", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  const waits: number[] = [];
  const github = client(server, () => 1_000_000, waits);
  server.queue("GET", /^\/repos\/acme\/billing$/, 503, { message: "Service Unavailable" });
  expect(await github.get<{ id: number }>("/repos/acme/billing")).toMatchObject({ id: 42 });
  expect(waits).toEqual([0]);
  expect(server.requests).toHaveLength(2);

  server.queue("GET", /^\/repos\/acme\/billing$/, 404, { message: "Not Found" });
  const waitsAfter: number[] = [];
  await expect(client(server, () => 1_000_000, waitsAfter).get("/repos/acme/billing/nope")).rejects.toThrow(ForgeError);
  expect(waitsAfter).toEqual([]);
});

test("an error says the path and the server's words, never the token", async () => {
  const server = new FakeGitHub("https://api.github.com");
  server.repo(42, "acme/billing");
  const github = new GitHub({ host: "github.com", token: () => "ghp-wrong", fetch: server.fetch, now: () => 0 });
  const error = (await github.get("/repos/acme/billing").catch((caught: unknown) => caught)) as ForgeError;
  expect(error.code).toBe("unauthorized");
  expect(error.message).toContain("/repos/acme/billing");
  expect(error.message).not.toContain("ghp-");
});

test("an absolute URL of another server is not asked", async () => {
  const server = new FakeGitHub("https://github.example.com/api/v3");
  const github = client(server);
  await expect(github.get("https://elsewhere.example.com/repos/acme/billing")).rejects.toThrow(/not this server/);
});
