# Niwa plugins

Optional plugins for the [Niwa host](https://github.com/niwa-labs/niwa).
Install the ones your host needs. Each is a separate package with its own
actions and journal records. The package guides describe who can call the
actions and which records a workflow can read or wait for.

| Package | What it adds |
| --- | --- |
| [`@niwa-labs/forge`](packages/forge/README.md) | Watches GitLab repositories and records merge requests, pipelines, jobs and checks. With the configured server token it can act on requests and comments. GitHub servers are configured the same way and their releases are read through a read-only port for release workflows. |
| [`@niwa-labs/watch`](packages/watch/README.md) | Reads the journal to show what sessions and runs are doing. It records when they get stuck or recover so workflows can respond. |
| [`@niwa-labs/evidence`](packages/evidence/README.md) | Records what an actor attested and checks whether the attestation covers the required change or pair of commits. |
| [`@niwa-labs/plan`](packages/plan/README.md) | Keeps complete revisions of a plan, including its items and open decisions. |
| [`@niwa-labs/memory`](packages/memory/README.md) | Keeps notes with provenance, memory pages and consolidation for agents. |
| [`@niwa-labs/commitments`](packages/commitments/README.md) | Tracks promises, deadlines and outcomes and uses the host's timers for reminders. |
| [`@niwa-labs/delegate`](packages/delegate/README.md) | Delegates specified owner decisions, with escalation to the owner and the ability to recall the delegation. |

[Rin](https://github.com/niwa-labs/niwa-rin) composes memory, commitments and
delegate. [pstack](https://github.com/niwa-labs/niwa-pstack) composes forge,
evidence, watch and plan. If either composition already supplies a plugin,
configure it through that composition so it is installed once.

## Add watch to a source host

Use the [Niwa source setup](https://github.com/niwa-labs/niwa#run-from-source)
and the sibling checkouts below. In the workspace's `host.ts`, import
`watch` from `./plugins/packages/watch/src/index.ts`. Keep the same options
and collect the result of `defaultComposition` into `base`. Install watch
before the workflow module so the latter can see its record types.

```ts
import { watch } from "./plugins/packages/watch/src/index.ts";

// Use the base composition from your Niwa host.ts.
const beforeWorkflow = base.filter((part) => part.name !== "workflow");
const workflows = base.filter((part) => part.name === "workflow");
export default [...beforeWorkflow, watch(), ...workflows];
```

Restart the host with the same home. Run `niwa watch.list` or open the watch
page in Cockpit. Watch reads from the existing journal and needs no external
credentials. To have workflows start on its incidents, list the relevant
record types, such as `watch.stuck`, in the host's `workflow.triggers`.

## Develop from source

Install Bun and run these commands from a common parent directory. Keep the
checkout names below so the workspace can resolve packages from `../niwa`.

```sh
git clone https://github.com/niwa-labs/niwa.git niwa
git clone https://github.com/niwa-labs/niwa-plugins.git plugins
(cd niwa && bun install)
cd plugins
bun install
bun run typecheck
bun test
bun run check:boundaries
```

## License

[MIT](LICENSE)
