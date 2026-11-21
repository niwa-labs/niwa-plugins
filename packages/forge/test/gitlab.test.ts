// The REST client: the token in a header and nowhere else, ETags by URL and page, the server's limit.

import { expect, test } from "bun:test";

import { ForgeError, GitLab } from "../src/gitlab.ts";
import { FakeGitLab } from "./fake-gitlab.ts";

function client(server: FakeGitLab, now = () => 1_000_000) {
  return new GitLab({ url: server.url, token: () => server.token, fetch: server.fetch, now });
}

test("every request carries the token in PRIVATE-TOKEN", async () => {
  const server = new FakeGitLab();
  server.project(42, "acme/billing");
  await client(server).get("/projects/42");
  expect(server.requests[0]?.headers["PRIVATE-TOKEN"]).toBe(server.token);
});

test("a read asks again with the ETag it was given, and a 304 answers what was read before", async () => {
  const server = new FakeGitLab();
  server.project(42, "acme/billing");
  const gitlab = client(server);
  const first = await gitlab.get<{ id: number }>("/projects/42");
  const second = await gitlab.get<{ id: number }>("/projects/42");
  expect(second).toEqual(first);
  const [one, two] = server.seen("GET", /^\/projects\/42$/);
  expect(one?.headers["If-None-Match"]).toBeUndefined();
  expect(two?.headers["If-None-Match"]).toMatch(/^W\//);
});

test("a list reads every page, and keeps the ETag of each page apart", async () => {
  const server = new FakeGitLab();
  const project = server.project(42, "acme/billing");
  for (let at = 0; at < 3; at += 1) server.pipeline(project, { sha: "a".repeat(40), ref: "main" });
  server.queue("GET", /\/pipelines$/, 200, [{ id: 1 }], { "X-Next-Page": "2", ETag: "page-1" });
  server.queue("GET", /\/pipelines$/, 200, [{ id: 2 }], { ETag: "page-2" });
  const gitlab = client(server);
  expect(await gitlab.list<{ id: number }>("/projects/42/pipelines")).toEqual([{ id: 1 }, { id: 2 }]);
  server.queue("GET", /\/pipelines$/, 304, null, {});
  server.queue("GET", /\/pipelines$/, 304, null, {});
  expect(await gitlab.list<{ id: number }>("/projects/42/pipelines")).toEqual([{ id: 1 }, { id: 2 }]);
  const asked = server.seen("GET", /\/pipelines$/);
  expect(asked.map((one) => [one.query["page"], one.headers["If-None-Match"]])).toEqual([
    ["1", undefined],
    ["2", undefined],
    ["1", "page-1"],
    ["2", "page-2"],
  ]);
});

test("a 429 is refused for its Retry-After, and the server is not asked again before it", async () => {
  const server = new FakeGitLab();
  server.project(42, "acme/billing");
  let now = 1_000_000;
  const gitlab = client(server, () => now);
  server.queue("GET", /^\/projects\/42$/, 429, { message: "Retry later" }, { "Retry-After": "30" });
  const error = await gitlab.get("/projects/42").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForgeError);
  expect((error as ForgeError).code).toBe("rate-limited");
  expect((error as ForgeError).retryAfterMs).toBe(30_000);
  await expect(gitlab.get("/projects/42")).rejects.toThrow(/limit/);
  expect(server.requests).toHaveLength(1);
  now += 30_000;
  expect(await gitlab.get<{ id: number }>("/projects/42")).toMatchObject({ id: 42 });
});

test("a spent limit holds the client back until the server's reset", async () => {
  const server = new FakeGitLab();
  server.project(42, "acme/billing");
  let now = 1_000_000;
  const gitlab = client(server, () => now);
  server.headers = { "RateLimit-Remaining": "0", "RateLimit-Reset": String((now + 10_000) / 1000) };
  await gitlab.get("/projects/42");
  expect(gitlab.waitMs()).toBe(10_000);
  await expect(gitlab.get("/projects/42")).rejects.toThrow(ForgeError);
  expect(server.requests).toHaveLength(1);
  server.headers = {};
  now += 10_000;
  await gitlab.get("/projects/42");
  expect(server.requests).toHaveLength(2);
});

test("an error says the path and the server's words, never the token", async () => {
  const server = new FakeGitLab();
  server.project(42, "acme/billing");
  const gitlab = new GitLab({ url: server.url, token: () => "glpat-wrong", fetch: server.fetch, now: () => 0 });
  const error = (await gitlab.get("/projects/42").catch((caught: unknown) => caught)) as ForgeError;
  expect(error.code).toBe("unauthorized");
  expect(error.message).toContain("/api/v4/projects/42");
  expect(error.message).not.toContain("glpat");
});
