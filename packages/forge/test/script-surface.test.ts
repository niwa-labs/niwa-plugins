// The query builders and flow helpers in a real workflow script, on a host that runs the workflow
// module over a fake GitLab server: the script waits for and reads forge records by the builders and
// gets the data typed, and the check of the script follows a builder to the record it names.
//
// A script here imports the module by the path of its entry file, not by the name of the package.

import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eventually, requests, timers, workflow } from "@niwa-labs/testing";

import { forgeRepoSync, forgeRepoWatch } from "../src/index.ts";
import { sha } from "./fake-gitlab.ts";
import { BILLING, forgeHost, openMr } from "./support.ts";
import type { ForgeHost } from "./support.ts";

const hosts: ForgeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
}, 60_000);

const RECORDS = join(import.meta.dir, "..", "src", "records.ts");
const FLOW = join(import.meta.dir, "..", "src", "flow.ts");

async function served(): Promise<ForgeHost> {
  const host = await forgeHost({ after: [requests(), timers([]), workflow()] });
  hosts.push(host);
  await host.niwa.call(forgeRepoWatch, { repo: BILLING });
  return host;
}

async function scriptIn(host: ForgeHost, name: string, lines: readonly string[]): Promise<string> {
  await mkdir(host.home, { recursive: true });
  const file = join(host.home, name);
  await writeFile(file, lines.join("\n"));
  return file;
}

const call = (host: ForgeHost, name: string, input: unknown): Promise<any> => host.niwa.call(name as never, input as never) as Promise<any>;
const sync = (host: ForgeHost) => host.niwa.call(forgeRepoSync, { repo: BILLING });

async function resultOf(host: ForgeHost, run: string): Promise<unknown> {
  await eventually(
    async () => (await host.niwa.records.read({ types: ["workflow.run.finished"], filter: { run } })).length === 1,
    20_000,
    "the run should finish",
  );
  const [finished] = await host.niwa.records.read({ types: ["workflow.run.finished"], filter: { run } });
  return (finished?.data as { outcome: unknown }).outcome;
}

/** Wait until the run is suspended on a record. */
const suspended = (host: ForgeHost) =>
  eventually(async () => (await host.niwa.records.read({ types: ["niwa.invocation.state"], filter: { state: "waiting" } })).length > 0, 20_000, "the run should wait");

const REPO = JSON.stringify({ host: BILLING.host, path: BILLING.path });

test("a script reads a pipeline's records and waits for a pull request's merge by builders, with the data typed", async () => {
  const host = await served();
  const mr = openMr(host);
  const pipeline = host.server.pipeline(host.billing, { sha: sha("topic-1"), ref: "refs/merge-requests/7/head", source: "merge_request_event" });
  await sync(host);
  const file = await scriptIn(host, "merged.ts", [
    `import { pipelineOf, prMerged } from ${JSON.stringify(RECORDS)};`,
    `const repo = ${REPO};`,
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => {',
    `  const seen = await read.records(pipelineOf({ repo, sha: ${JSON.stringify(sha("topic-1"))} }));`,
    "  const states: string[] = seen.records.map((row) => row.data.state);",
    '  const merged = await wait(prMerged({ repo, number: 7 }), { from: seen.next, timeout: "5m" });',
    '  if ("timedOut" in merged) return { states, merged: false, mergeSha: null };',
    "  const mergeSha: string | undefined = merged.data.mergeSha;",
    "  return { states, merged: true, mergeSha: mergeSha ?? null };",
    "});",
  ]);
  expect((await call(host, "workflow.check", { file })).errors).toEqual([]);
  const { run } = await call(host, "workflow.start", { file });
  await suspended(host);
  Object.assign(mr, { state: "merged", merge_commit_sha: sha("merge-7") });
  pipeline.status = "success";
  host.server.event(host.billing, { action_name: "accepted", target_type: "MergeRequest", target_iid: 7, author: { username: "marge" } });
  await sync(host);
  expect(await resultOf(host, run)).toEqual({ status: "done", result: { states: ["running"], merged: true, mergeSha: sha("merge-7") } });
}, 60_000);

test("flow helpers imported by a script wait for the head of a pull request and for a pipeline through the same queries", async () => {
  const host = await served();
  const mr = openMr(host);
  await sync(host);
  const file = await scriptIn(host, "flow.ts", [
    `import { untilHeadMoved, untilPipeline } from ${JSON.stringify(FLOW)};`,
    `const repo = ${REPO};`,
    `export default workflow({ uses: ["niwa.records.read", "forge.pipeline.read@gitlab.example.com/acme/billing"], output: z.json() }, async () => {`,
    '  const moved = await untilHeadMoved("head", { pr: { repo, number: 7 }, timeout: "5m" });',
    "  if (!moved.moved) return { moved: false, head: null, previous: null, ci: null };",
    `  const ci = await untilPipeline("ci", { repo, sha: moved.head, deadline: "5m" });`,
    "  return { moved: true, head: moved.head, previous: moved.previous ?? null, ci: ci.outcome };",
    "});",
  ]);
  expect((await call(host, "workflow.check", { file })).errors).toEqual([]);
  const { run } = await call(host, "workflow.start", { file });
  await suspended(host);
  mr.sha = sha("topic-2");
  host.server.pipeline(host.billing, { sha: sha("topic-2"), ref: "refs/merge-requests/7/head", source: "merge_request_event", status: "success" });
  await sync(host);
  expect(await resultOf(host, run)).toEqual({ status: "done", result: { moved: true, head: sha("topic-2"), previous: sha("topic-1"), ci: "green" } });
}, 60_000);

test("the check of a script holds the data of a builder's wait to the record's schema", async () => {
  const host = await served();
  const script = (access: string) =>
    scriptIn(host, `check-${access.length}.ts`, [
      `import { prHead } from ${JSON.stringify(RECORDS)};`,
      `const repo = ${REPO};`,
      "export default workflow({ output: z.json() }, async () => {",
      '  const moved = await wait(prHead({ repo, number: 7 }), { timeout: "1m" });',
      `  return "timedOut" in moved ? null : ${access};`,
      "});",
    ]);
  expect((await call(host, "workflow.check", { file: await script("moved.data.head") })).errors).toEqual([]);
  const wrong = (await call(host, "workflow.check", { file: await script("moved.data.tip") })).errors as Array<{ code: string }>;
  expect(wrong.map((one) => one.code)).toEqual(["TS2339"]);
}, 60_000);
