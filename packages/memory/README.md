# @niwa-labs/memory

A plugin for agent memory: notes with sources and confirmation, pages, a top layer, consolidation and intake of session digests.

```ts
import { agents } from "@niwa-labs/agent";
import { memory } from "@niwa-labs/memory";

const sessionsModule = sessions({ harnesses });
const agentsModule = agents({ agents: [rin] });
const bind = agentsModule.bind(sessionsModule.bind());
host.use(messages({ bind }), requests({ bind }), sessionsModule, agentsModule, memory({ bind }));
```

Install it after the agents module, which reads its briefing section, and on
a host with the requests module, which asks the owner.

There is one memory module on a host and a memory in it for every agent,
named by the agent. The binding says which address a caller speaks as: a
session of an agent reaches that agent's memory and no other, the owner
reaches every memory, and the host and other plugins' handlers name the
memory they mean. Another agent's memory is asked through
`memory.context`.

## Notes

A note is one conclusion (`text`) with what backs it (`detail`), whom it is
about (`owner` or `work`), the project it holds for (an absolute directory,
kept in its canonical form: `/a/b/../c/` is `/a/c`) and its
source: the owner's own word, the writer's conclusion, a session up to a
locator, or a record. Only the owner gives a note the owner as its source;
his confirmation or correction makes a note his word, and a correction by
anyone else makes it unconfirmed again. A corrected note stands on its new
text alone: the corrector is its only source, and it earns its place in the
top layer again unless it was placed by hand. A note written again in the
same words, in the same order, gains a source instead of a copy.

A note stops being shown first (`memory.drop`), is taken back
(`memory.retract`), or is erased (`memory.erase`). The journal is written
once, so erasing hides the text from every read, including reads at an
earlier position, while the record that first held it stays.

## Reading

- `memory.get`, `memory.list`, `memory.page.get` and `memory.search` read
  the memory now or at a journal position (`at`). `memory.page.list` lists the
  pages by name, with the revision of each and without the text.
- `memory.search` ranks notes, pages and the latest digests by words with
  BM25. A word matches whole or as the start of a longer word. No model or
  external service is used.
- `memory.top` is the top layer for a project: lifted notes about the
  owner, for the project and in general, newest first, within 4000
  characters. The agent's briefing carries it as "What it remembers", for
  the agent's project or the directory of the session attached to it last.

## Context requests

`memory.context` names the memory, the query, the purpose and, for a
handler, the addressee; a bound caller always asks for itself. The memory's
own agent and the owner get notes whole. Any other addressee gets only the
conclusion, whom it is about and where it holds:

- a note about the owner leaves only after the owner says yes for that
  addressee, that revision of the note and the purpose he was told. He is
  asked once for each (`request.ask`); an answer found by a resolver lets
  nothing leave, and `memory.share` gives his word without a question, for
  the purpose he names or, naming none, for every purpose. A request read at a
  position (`at`) asks nobody, and says `not-asked` for a note he was never
  asked of, `asked` only when his question stood at that position.
  The question names the note and its revision and the purpose, never the
  note's text, which anyone reading the open requests would read. The
  cockpit page reads the note when it shows the question, and shows the text
  only while the note holds as it was asked; a question about a note that is
  corrected, taken back or erased is cancelled;
- a project note goes to agents whose project contains it, and is not so
  much as named to any other;
- other work notes go to anyone who asks.

Only what the addressee may be told is ranked, and `limit` counts only that;
the notes about the owner that match are ranked apart and listed as
withheld.

Every conclusion names its source: the memory's address, the note, and the
journal position it stood at. The memory is read once, at one position
(`at` in the answer), so a request repeated with that `at` reads the memory
as it was then.

## Intake and consolidation

Each digest of an attached session (`SessionDigestTaken`) is recorded as a
pointer to the turn that carried it, with the session and, as the project,
the directory the session was attached in when the digest was told (none if
it had been attached to another agent or let go of since). The digest is searchable, but no note is made from it
automatically. Notes are written by the agent itself, which receives the
digest as a turn.

Consolidation merges notes that came to say the same thing. It lifts notes
the owner confirmed, or notes with three sources, while each part of the top
layer has room (twelve notes), dropping weaker automatic lifts to make room.
It retires unconfirmed single-source notes unchanged for thirty days, and
the oldest unplaced notes past 500. Notes placed by hand and confirmed notes
are never retired. A digest arriving triggers consolidation once twenty
records have changed the memory since the last one; `memory.consolidate`
runs it on demand. All of these limits are set with `memory({ limits })`.

`./cockpit` is the plugin's page: for each agent, the top layer by part, every note with its source and standing, the
pages, and the share questions that wait for the owner.
