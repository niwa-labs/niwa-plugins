# Niwa plugins

Optional plugins for Niwa, a host for agents and workflows. Each plugin is a
separate package built on Niwa's public contracts. The package guides describe
the host setup, actions, and record types for each plugin.

| Package | What it adds |
| --- | --- |
| [`@niwa-labs/forge`](packages/forge/README.md) | GitLab merge requests, pipelines, jobs, and comments. |
| [`@niwa-labs/watch`](packages/watch/README.md) | Session and workflow status, including when work gets stuck or recovers. |
| [`@niwa-labs/evidence`](packages/evidence/README.md) | Attestations and checks that they cover a requirement, such as a passing pipeline for a pair of commits. |
| [`@niwa-labs/plan`](packages/plan/README.md) | Revisable plans with tracked items and open decisions. |
| [`@niwa-labs/memory`](packages/memory/README.md) | Agent notes with sources, memory pages, and consolidation. |
| [`@niwa-labs/commitments`](packages/commitments/README.md) | Promises, deadlines, reminders, and outcomes. |
| [`@niwa-labs/delegate`](packages/delegate/README.md) | Bounded delegation of owner decisions, with recall and escalation. |

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
