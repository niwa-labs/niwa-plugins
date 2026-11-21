# @niwa-labs/plan

A plugin for revisable plans: items, revisions and the decisions still ahead.

A plan is of something a caller names (`of`: a task, a run, a branch). Each revision is one
`plan.revised { of, rev, goal?, items }` record carrying the whole plan, so any revision reads back
without folding the ones before it. An item is `{ id, text, state, note? }`; its state is `open` (a
decision still ahead), `planned`, `done` or `dropped`.

| Action | Effect | What it does |
| --- | --- | --- |
| `plan.set { of, goal?, items, expect? }` | record / niwa | Writes the next revision. Items and goal equal to the latest revision write nothing and return it. `expect` refuses the set, equal or not, when the plan is no longer at that revision (`0` for a plan not yet written). A call cut off and made again finds the revision it wrote and returns it, whatever was written after. |
| `plan.get { of, rev? }` | read / niwa | The latest revision, or the one asked for by the number it carries. |
| `plan.list { open? }` | read / niwa | Each plan at its latest revision with its count of open items; `open: true` keeps those with a decision ahead. |

`plan.set` and `plan.get` name the plan as their `@target`, so a grant can be limited to one plan
(`plan.set@task-3fa9c2`). The name is one segment: `/`, spaces and other characters a target cannot hold are encoded.

A refusal (`unknown-plan`, `unknown-revision`, `stale`) is a `PlanRefusal`, an error the caller catches: its `code` says which, and nothing was written. A host that is not serving the journal fails each action with `NotSent` instead of showing no plans.

What an agent ticks off while it works is not here: that checklist is read through the history of
its session.

Another plugin or a script reads the records through `@niwa-labs/plan/records`.

In the cockpit (`./cockpit`) the plans are listed with the ones that wait for a decision first. A plan opens
with its items, how many are done, and any revision, each shown with what it changed from the one before.
