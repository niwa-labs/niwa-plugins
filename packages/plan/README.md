# @niwa-labs/plan

A plugin for revisable plans: items, revisions and the decisions still ahead.

A plan is of something a caller names (`of`: a task, a run, a branch). Each revision is one
`plan.revised { of, rev, goal?, items }` record carrying the whole plan, so any revision reads back
without folding the ones before it. An item is `{ id, text, state, note? }`; its state is `open` (a
decision still ahead), `planned`, `done` or `dropped`.

| Action | Effect | What it does |
| --- | --- | --- |
| `plan.set { of, goal?, items, expect? }` | record / niwa | Writes the next revision. Items and goal equal to the latest revision write nothing and return it, so a cut-off call can be made again. `expect` refuses the set when the plan is no longer at that revision (`0` for a plan not yet written). |
| `plan.get { of, rev? }` | read / niwa | The latest revision, or the one asked for. |
| `plan.list { open? }` | read / niwa | Each plan at its latest revision with its count of open items; `open: true` keeps those with a decision ahead. |

`plan.set` and `plan.get` name the plan as their `@target`, so a grant can be limited to one plan
(`plan.set@task-3fa9c2`). The name is one segment: `/`, spaces and other characters a target cannot hold are encoded.

What an agent ticks off while it works is not here: that checklist is read through the history of
its session.

Another plugin or a script reads the records through `@niwa-labs/plan/records`.
