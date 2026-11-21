# @niwa-labs/watch

A plugin that derives the state of every session and run from the journal and records when something is stuck and when it has recovered.

A subject is a session (`session:<harness> <native id>`) or a run (`run:<id>`). Each is in one state:

| State | Meaning |
| --- | --- |
| `working` | A turn or a run is going on and signs of life keep coming. |
| `waiting-human` | A question the subject asked is open, or the run is paused for a decision. |
| `waiting-event` | A run is suspended on a record or on other work. |
| `sleeping` | A run waits for a timer. |
| `idle` | A session between turns, a run asked for and not started. |
| `looping` | Working, but repeating the same step with nothing changing. |
| `stuck` | Working and silent for too long, or cancelled and held up by a shielded scope. |
| `unknown` | The journal does not say: a session another harness runs was just seen, or a turn ended with no known outcome. |

`watch.get { subject }` and `watch.list { state? }` read the states now (effect `read`, world `niwa`).

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

## Sources

The model reads by type name and imports none of the plugins that write them, so it works with whichever are installed:
`session.started`, `.turn-started`, `.turn-ended`, `.activity`, `.progress`, `.ended`; `history.session.*`;
`workflow.run.*` and `workflow.scope.*`; the steps, cancels and state of the run's invocation (`niwa.step.*`,
`niwa.invocation.state`); `request.*`; `timer.sleep.requested` and `timer.slept`; and `git.head.moved`, which counts as
progress for the session its data names or the run whose handler wrote it.

A service reads new records on a clock (`tick`, 15 seconds) rather than through `api.on`. Silence is the absence of a
record, which no handler can be woken by, and a handler is an invocation that writes records of its own for every sign
of life.

## Options

`watch({ silentAfter, loopRepeats, sessionLoopRepeats, shieldGrace, tick })`, all in milliseconds except the repeat
counts. Defaults: 10 minutes, 6, 25, 1 minute, 15 seconds.

## Limits

- Time the host was down is not counted as silence: it is counted from the moment the watch began looking. A silence
  already flagged stays flagged across a restart.
- A long step that writes nothing while it runs looks silent. Raise `silentAfter` for hosts that run such steps.
- The model is rebuilt from the journal when the host starts.
