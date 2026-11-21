# @niwa-labs/delegate

A plugin that answers on behalf of the owner: recalling past decisions in a domain, deciding within set bounds, passing to a judge or forwarding.

`delegate({ agent: "rin", judges, context })` watches the requests put to one agent:

- **Recall.** When the owner already decided the same question (its name and what was asked,
  without the area) in the same area, the request is answered from that decision.
  `delegate.recall` asks the same, optionally as of a journal position; `delegate.revoke` (the
  owner's) stops a decision from being recalled. An answer that picks an option for one time only
  (`allow_once`, `reject_once`) is kept as a decision but never recalled.
- **Decide within bounds.** `delegate.decide` answers an open request with a decision of the
  caller. Its grant target is the area (`delegate.decide@style`), and the area must be the one the
  request names. The answer must be one the question takes, and a request is decided once. A
  decision the request did not take, because it ended otherwise first, is revoked.
- **Judge.** A request of an area with a judge goes to that address first, with the context the
  data owners give. Unanswered in time (an hour by default), it goes on to the owner.
- **Forward.** Everything else goes to the owner; his answer answers the request and becomes his
  decision in that area. When the question of the request refuses the answer (a form held to more
  than its schema says), he is asked again, up to three times, and then the request is cancelled.

Whatever was passed on for a request is withdrawn when the request is over without it; when the
owner cancels a forward, the request is cancelled.

Delegate does not import memory. Before a judge is asked it sends each action named in `context`
(a memory serves `memory.context`) a request for context: whose memory, what is needed, for whom
and why, read as of the request's position. It reads back the conclusions with where each holds
and their sources (the memory's address, the note and the journal position), and how many were
withheld. The types and
`contextSource(name)` are in `@niwa-labs/delegate/records`, which a memory may import to keep its
action in step with them.
