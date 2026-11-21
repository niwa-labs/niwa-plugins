/**
 * The token of a server, resolved where a call runs.
 *
 * The configuration names a secret, `secret("GITLAB_TOKEN")`; its value is the owner's and is read
 * the way the host reads every secret: from the file `<home>/secrets/<name>`, readable by its owner
 * alone, or from the variable `NIWA_SECRET_<name>` of the host's environment. One secret serves every
 * module that names it. The value goes into a request header and nowhere else: every message here
 * names the secret, never its value.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ForgeError } from "./gitlab.ts";

/** The value of the secret called `name`. */
export function resolveSecret(home: string, name: string, env: Readonly<Record<string, string | undefined>>): string {
  const path = join(home, "secrets", name);
  let mode: number | undefined;
  try {
    const stat = statSync(path);
    if (stat.isFile()) mode = stat.mode;
  } catch {
    // Not a file: the environment may have it.
  }
  if (mode !== undefined) {
    if ((mode & 0o077) !== 0) {
      throw new ForgeError("unsafe-secret", `the file of the secret "${name}" must be readable by its owner alone (mode 0600)`);
    }
    return nonEmpty(name, readFileSync(path, "utf8").replace(/\r?\n$/, ""));
  }
  const fromEnv = env[`NIWA_SECRET_${name}`];
  if (fromEnv !== undefined) return nonEmpty(name, fromEnv);
  throw new ForgeError("unknown-secret", `no secret "${name}": ${path} does not exist and NIWA_SECRET_${name} is not set`);
}

function nonEmpty(name: string, value: string): string {
  if (value.length === 0) throw new ForgeError("unknown-secret", `the secret "${name}" is empty`);
  return value;
}
