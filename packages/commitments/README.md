# @niwa-labs/commitments

A plugin for commitments: what was promised, by when, delivery, and whether it was kept.

- `commitment.make` records a promise: its text, the agent whose inbox it is delivered to, and an
  optional deadline. An agent's own promise (`party: "self"`) stands at once.
- A promise on the owner's behalf or one that sets him a deadline (`party: "owner"`) stands only on
  his word: he makes it himself, an agent cites a record he wrote that holds the promise as worded
  (`basis: owner-words`; a message, sent or received, or a turn of his), or it is proposed to him as
  a `commitment.confirm` question and stands once he says yes himself. A promise that carries a
  deadline, or rewords what he said, is always proposed: a deadline cannot be read out of words, and
  an answer a resolver found for him confirms nothing.
- At the deadline an open commitment is told to its agent through `agent.notify`, and is delivered
  once the inbox took it; when it is still not done after the grace period (an hour by default), it
  is missed whether it was delivered or not, and the agent is told. A deadline and its grace must
  fit in a date.
- `commitment.done` and `commitment.cancel` end it: the one who made it or the owner may; only the
  owner cancels a promise made for him. `commitment.list` and `commitment.get` show every one, and
  each agent's briefing gets a section of its open commitments. In the cockpit every commitment is
  a card with a cancel button for the viewer who may use it (`./cockpit`).

A script waits for or reads one commitment with the data typed, through the builders of
`@niwa-labs/commitments/records`: `await wait(commitmentKept(id), { timeout: "2h" })`, and likewise
`commitmentMissed`, `commitmentDelivered`, `commitmentCancelled`, `commitmentDeclined`, `commitmentMade`
and `commitmentProposed`.

The deadline is a sleep of `@niwa-labs/timer`, asked through `timer.sleep.request`; the inbox is
`@niwa-labs/agent`'s, so a host with commitments installs both.
