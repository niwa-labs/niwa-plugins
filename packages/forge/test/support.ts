// What the forge tests share: a host with the module installed over a fake GitLab server, the token
// in the host's secrets, clients that hold a grant, and the module's actions as it built them.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { grant, principalOf } from "@niwa-labs/core";
import type { Action, StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { connect, createNiwa, tempHome } from "@niwa-labs/testing";
import type { NiwaApi } from "@niwa-labs/testing";

import { forge, secret } from "../src/index.ts";
import type { ForgeOptions } from "../src/index.ts";
import { FakeGitLab, sha } from "./fake-gitlab.ts";
import type { FakeProject } from "./fake-gitlab.ts";

export const HOST = "gitlab.example.com";
export const BILLING = { host: HOST, path: "acme/billing" };

/** The module, with its actions kept as it registers them, so a test can ask an action's check. */
export function capturing(made: Plugin): { plugin: Plugin; actions: Map<string, Action<any, any>> } {
  const actions = new Map<string, Action<any, any>>();
  const wrapped = plugin(
    made.name,
    (api) => {
      const spy = new Proxy(api, {
        get(target, key) {
          if (key === "action") {
            return (one: Action<any, any>) => {
              actions.set(one.name, one);
              target.action(one);
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      made.setup(spy);
    },
    { version: made.version },
  );
  return { plugin: wrapped, actions };
}

export interface ForgeHostOptions {
  /** The mode of the token's file; `false` writes no file. Default: 0o600. */
  readonly tokenMode?: number | false;
  readonly env?: ForgeOptions["env"];
  /** More plugins, installed before forge. */
  readonly before?: readonly Plugin[];
  /** More plugins, installed after forge. */
  readonly after?: readonly Plugin[];
  readonly forge?: Partial<ForgeOptions>;
}

/** A host with the forge module over a fake server that has the project acme/billing (42) and acme/payroll (43). */
export async function forgeHost(opts: ForgeHostOptions = {}) {
  const server = new FakeGitLab();
  const billing = server.project(42, "acme/billing");
  const payroll = server.project(43, "acme/payroll");
  const home = await tempHome();
  const mode = opts.tokenMode ?? 0o600;
  if (mode !== false) {
    mkdirSync(join(home.path, "secrets"), { recursive: true });
    const file = join(home.path, "secrets", "GITLAB_TOKEN");
    writeFileSync(file, `${server.token}\n`);
    chmodSync(file, mode);
  }
  const { plugin: module, actions } = capturing(
    forge({ servers: [{ host: HOST, url: server.url, token: secret("GITLAB_TOKEN") }], fetch: server.fetch, env: opts.env ?? {}, poll: false, ...opts.forge }),
  );
  const niwa = createNiwa({ home: home.path });
  niwa.use(...(opts.before ?? []), module, ...(opts.after ?? []));
  await niwa.serve();
  const clients: NiwaApi[] = [];
  return {
    niwa,
    home: home.path,
    server,
    billing,
    payroll,
    actions,
    /** A client whose grant is these rules. */
    async as(rules: string[]): Promise<NiwaApi> {
      const token = niwa.issueToken(principalOf("session", `caller-${String(clients.length)}`), { grant: grant(rules) });
      const client = await connect({ home: home.path, id: `session:caller-${String(clients.length)}`, token });
      clients.push(client);
      return client;
    },
    /** Every record of the journal. */
    async records(types?: string[]): Promise<StoredRecord[]> {
      return await niwa.records.read(types === undefined ? {} : { types });
    },
    async stop() {
      for (const client of clients) await client.close().catch(() => {});
      await niwa.close();
      await home.cleanup();
    },
  };
}

export type ForgeHost = Awaited<ReturnType<typeof forgeHost>>;

/** An open merge request of acme/billing on the branch `topic`, at a head named by `word`. */
export function openMr(host: ForgeHost, iid = 7, word = "topic-1", project: FakeProject = host.billing) {
  return host.server.mr(project, { iid, source_branch: "topic", sha: sha(word) });
}
