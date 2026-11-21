# @niwa-labs/watch

A plugin that derives the state of every session and run from the journal and records when something is stuck and when it has recovered.

A subject is a session (`session:<harness> <native id>`) or a run (`run:<id>`). Each is in one state:

| State | Meaning |
| --- | --- |
| `working` | A turn or a run is going on and signs of life keep coming. |
| `waiting-human` | A question the subject put to the owner is open, or the run is paused for a decision: after a failed step, at a pause someone asked for once the run reaches a boundary, or at a deadline. |
| `waiting-event` | A run is suspended on a record or on other work, or a subject waits for the answer of a session or another address that is not the owner. |
| `sleeping` | A run is in a sleep. A wait for a record with a timeout is `waiting-event`: a record can end it. |
| `idle` | A session between turns, a run asked for and not started. |
| `looping` | Working, but repeating the same step with nothing changing. |
| `stuck` | Working and silent for too long, or cancelled and held up by a shielded scope. |
| `unknown` | The journal does not say: a session another harness runs was just seen, or a turn ended with no known outcome. |

`watch.get { subject }` and `watch.list { state? }` read the states now (effect `read`, world `niwa`). A grant names
the subject of `watch.get` as `session/<harness>/<id>` or `run/<id>`, each segment encoded, so
`watch.get@session/claude/*` covers one harness.

## Records

- `watch.stuck { subject, since, last, kind }` — `kind` is `silent` (no sign of life for `silentAfter`; a session that
  says its own `stuckAfter` is held to that), `looping` (`loopRepeats` identical steps of a run, or `sessionLoopRepeats`
  identical activities of a session, with no progress between them) or `shielded-cancel` (a cancel spared a
  shielded scope of the run, as its `except` says, and the scope was still open `shieldGrace` later). `since` is when the condition began, `last` the moment of
  the last sign of life.
- `watch.recovered { subject, since, kind }` — closes the `watch.stuck` with that subject, kind and `since`: the subject
  gave a sign of life, stopped repeating itself, ended, or its shielded scope closed. Another `watch.stuck` for the
  subject follows only after it.

The watch does not react. A workflow does, by subscribing to the records:

```ts
on: [{ type: "watch.stuck", filter: { kind: "silent" } }]
```

A script waits for or reads them with the data typed, through the builders of `@niwa-labs/watch/records`:
`await wait(watchStuck(subject), { timeout: "1h" })` and `watchRecovered(subject, kind?)`.

## Sources

The model reads by type name and imports none of the plugins that write them, so it works with whichever are installed:
`session.started`, `.turn-started`, `.turn-ended`, `.activity`, `.progress`, `.ended`; `history.session.*`;
`workflow.run.*` (including its log lines and pauses), `workflow.phase.*` and `workflow.scope.*`; the steps, cancels, answers
and state of the run's invocation (`niwa.step.*`, `niwa.invocation.resolved`, `niwa.invocation.state`); `request.*`;
`timer.sleep.requested` and `timer.slept`; and `git.head.moved`, which counts as progress for the session its data names or
the run whose handler wrote it.

A turn of a session niwa runs is open until `session.turn-ended` or `session.ended`: a quiet transcript (`history.session.paused`)
or a guessed end from the history does not close it. Only a session that the history alone follows goes idle on a pause, and
it is dropped when it is unwatched. Activity that names no tool is a sign of life but not a repeated operation, and the steps
the workflow bridge writes around a call (its permission check, the clock, the arming of a wake) are signs of life that
neither add to a loop nor break one.

A service reads new records on a clock (`tick`, 15 seconds) rather than through `api.on`. Silence is the absence of a
record, which no handler can be woken by, and a handler is an invocation that writes records of its own for every sign
of life.

## Cockpit

`./cockpit` is the plugin's page: every subject with its state, troubles first, and the recent `watch.stuck` and
`watch.recovered` records as incidents. The incidents come from the live feed, so they are the recent ones.

## Options

`watch({ silentAfter, loopRepeats, sessionLoopRepeats, shieldGrace, tick })`, all in milliseconds except the repeat
counts, and all positive whole numbers. Defaults: 10 minutes, 6, 25, 1 minute, 15 seconds.

## Limits

- Time the host was down is not counted as silence: it is counted from the moment the watch began looking. A silence
  already flagged stays flagged across a restart.
- A long step that writes nothing while it runs looks silent. Raise `silentAfter` for hosts that run such steps.
- The model is rebuilt from the journal when the host starts.
