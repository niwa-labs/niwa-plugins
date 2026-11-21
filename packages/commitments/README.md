# @niwa-labs/commitments

A plugin for commitments: what was promised, by when, delivery, and whether it was kept.

- `commitment.make` records a promise: its text, the agent whose inbox it is delivered to, and an
  optional deadline. An agent's own promise (`party: "self"`) stands at once.
- A promise on the owner's behalf or one that sets him a deadline (`party: "owner"`) stands only on
  his word: he makes it himself, an agent cites a record he wrote (`basis: owner-words`), or it is
  proposed to him as a `commitment.confirm` question and stands once he says yes.
- At the deadline an open commitment is delivered to its agent through `agent.notify`; when it is
  still not done after the grace period (an hour by default), it is missed and the agent is told.
- `commitment.done` and `commitment.cancel` end it: the one who made it or the owner may; only the
  owner cancels a promise made for him. `commitment.list` and `commitment.get` show every one, and
  each agent's briefing gets a section of its open commitments.

The deadline is a sleep of `@niwa-labs/timer`, asked through `timer.sleep.request`; the inbox is
`@niwa-labs/agent`'s, so a host with commitments installs both.
