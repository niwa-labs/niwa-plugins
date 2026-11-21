// A workflow run attests as itself: its calls carry the run's principal, and the default binding
// makes that the author.

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { record } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, plugin } from "@niwa-labs/plugin";
import { createNiwa, eventually, tempDir, tempHome, workflow } from "@niwa-labs/testing";
import { z } from "zod";

import { Attested, evidence } from "../src/index.ts";

const Go = record("probe.go", z.object({ sha: z.string() }));

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

test("an attestation made by a workflow run has the run as its author", async () => {
  const home = await tempHome();
  const file = join(await tempDir("probe"), "attest.ts");
  writeFileSync(
    file,
    `export default workflow({ on: ["probe.go"], uses: ["evidence.attest"] }, async ({ data }) => {
  await call("evidence.attest", { subject: "plan/rev-1/node-1", claim: { kind: "verdict", name: "go", outcome: "pass", sha: data.sha } }, { label: "attest" });
});
`,
  );
  const probe = plugin("probe", (api) => {
    api.declare(Go);
    api.offer(BUILTIN_WORKFLOW, { name: "attest", file, description: "Attest on every go", triggers: [Go] });
  });
  const niwa = createNiwa({ home: home.path });
  niwa.use(evidence(), probe, workflow());
  await niwa.serve();
  stops.push(async () => {
    await niwa.close();
    await home.cleanup();
  });
  await eventually(async () => ((await niwa.call("workflow.installation.list" as never, {} as never)) as { items: unknown[] }).items.length === 1, 20_000, "not installed");
  await niwa.emit(Go, { sha: "a".repeat(40) });
  await eventually(async () => (await niwa.records.read({ types: [Attested.name] })).length === 1, 20_000, "nothing was attested");
  const [attested] = await niwa.records.read({ types: [Attested.name] });
  const runs = await niwa.records.read({ types: ["workflow.run.started"] });
  const run = (runs[0]?.data as { run?: string } | undefined)?.run;
  expect(run).toBeDefined();
  expect((attested?.data as { author: unknown }).author).toEqual({ kind: "client", id: `run:${String(run)}` });
}, 60_000);
