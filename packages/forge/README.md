# @niwa-labs/forge

A plugin for GitLab servers, in the words of pull requests: merge requests,
pipelines, jobs, checks and comments, observed as records and changed through
actions.

```ts
import { forge, secret } from "@niwa-labs/forge";

host.use(forge({ servers: [{ host: "gitlab.example.com", token: secret("GITLAB_TOKEN") }] }));
```

The token is a secret reference. The host resolves it from
`<home>/secrets/GITLAB_TOKEN` (mode 0600) or `NIWA_SECRET_GITLAB_TOKEN`, and the
value never reaches the journal. `fetch` may be passed to speak to a fake server.

- Targets: `<host>/<path>` for reads, `<host>/<path>/pr/<n>` for pull request
  writes and merges, `<host>/<path>/ref/<ref>` for pipelines and jobs. A run
  fills a template such as `forge.pr.merge@{repo.host}/{repo.path}/pr/*`.
- `forge.pr.merge` is irreversible. A merge the server takes for later is
  listed by `forge.pr.merge.pending`, with the action that calls it off; the
  module checks it against the server whether or not the repository is watched,
  and records the end as `forge.pr.merge.settled` when nobody watching saw it.
- `forge.pr.list` lists the pull requests the module observed (open ones first) with the checks of each head and
  its latest pipelines; it reads what was recorded and asks the server nothing.
- `forge.repo.watch` records a repository; the module then polls it. Events of
  the server's log are recorded under their event ids; changes of pull
  requests, pipelines, jobs and checks as numbered observations with the state
  before them. A transition of a pull request (opened, reopened, merged, closed)
  is one record whether the log or a look at the server tells it first.
- `forge.repo.status` says, per watched repository since the host started, when
  it was last polled, what the last poll failed with and whether the event log
  was read back far enough.
- `/records`: record types, action references, target helpers and the query
  builders of the records: `prHead(pr)`, `prMerged(pr)`, `prClosed(pr)`,
  `prChecks(pr)`, `pipelineOf({ repo, sha, kind? })`, `pipelinesOfPr(pr)`,
  `jobsOf({ repo, pipeline })`, `pushed(repo, ref?)` and the rest of the pull
  request's records. A script waits for or reads them with the data typed
  (`await wait(prMerged(pr), { timeout: "2h" })`,
  `await read.records(pipelineOf({ repo, sha }))`), and a handler subscribes to
  them. A pull request is `{ repo: { host, path }, number }`; a record's own
  `pr` is accepted as it is.
- `/flow`: `untilPipeline`, `land` and `untilHeadMoved` for
  workflow scripts, built on those queries. `land` with `auto`
  reads the pull request between its waits, so a script that uses it lists
  `forge.pr.read` on the repository next to `forge.pr.merge`.
- `pushReaction`: a built-in workflow that, on a push to a branch, names the
  git worktrees made from it, found by the remote their base pushes to;
  `checkouts` adds local clones the git module cannot verify.

`./cockpit` is the plugin's page: the watched repositories, the merges the server holds for later with a button that calls
each off, and the observed pull requests with the checks of their heads and their latest pipelines.
