# @niwa-labs/forge

A plugin for GitLab servers, in the words of pull requests: merge requests,
pipelines, jobs, checks and comments, observed as records and changed through
actions. A GitHub server is configured the same way, with `kind: "github"`, and
its releases are read through a port a release workflow speaks to.

```ts
import { forge, githubReleaseReader, secret } from "@niwa-labs/forge";

host.use(forge({ servers: [{ host: "gitlab.example.com", token: secret("GITLAB_TOKEN") }] }));
```

The token is a secret reference. The host resolves it from
`<home>/secrets/GITLAB_TOKEN` (mode 0600) or `NIWA_SECRET_GITLAB_TOKEN`, and the
value never reaches the journal. `fetch` may be passed to speak to a fake server.

## GitHub servers

```ts
import { forge, githubReleaseReader, secret } from "@niwa-labs/forge";

const github = { host: "github.example.com", kind: "github" as const, token: secret("GITHUB_TOKEN") };
host.use(forge({ servers: [github] }));
const releases = githubReleaseReader(github, place);
```

`github.com` is asked at `https://api.github.com`, any other host is a GitHub
Enterprise Server asked at `<url>/api/v3`. The token is a bearer token, read for
each request. The client only reads: it keeps the ETag of every URL it read,
follows the pages of a list by the `Link` the server gives, and goes by the
server's own counts of the limit (`x-ratelimit-remaining` and `x-ratelimit-reset`,
a `429` or a `403` marked with a `Retry-After` for its wait). A read the server
could not answer is asked again a few times after a short wait; one the server
refused is not asked again.

`githubReleaseReader(server, place)` is the read-only port a release workflow
speaks to, wherever the host's `place` (`home`, `now`, `fetch`, `env`) is at hand:

- `ci({ slug, revision, branch }, { workflows, checks })` reports whether the
  revision is on the branch, the checks the branch effectively requires (the
  rules that apply to it, or the classic protection when no rule names any), the
  current attempt of each required workflow at that exact revision with its jobs,
  and each required check with the app that made it. A workflow that has not run
  there, a check nothing has reported, one still queued or running, and two that
  disagree, are answers of their own: `complete` is false, never silently green.
- `release({ slug, revision, branch }, tag)` peels the tag — an annotated one
  through its tag object — and reports the flags of the release that holds it and
  the SHA-256 of the bytes of each asset, read from the server.

A repository of a GitHub server is looked up by the module the same way a
GitLab project is (`forge.repo.watch` looks it up first), and a pull request of
GitHub is mapped onto the module's words of a pull request by
`githubPullRequestOf` with `githubRunStateOf` and `githubChecksStateOf` for the
states of its runs.

- Targets: `<host>/<path>` for reads, `<host>/<path>/pr/<n>` for pull request
  writes and merges, `<host>/<path>/ref/<ref>` for pipelines and jobs. A run
  fills a template such as `forge.pr.merge@{repo.host}/{repo.path}/pr/*`.
- `forge.pr.merge.started` and `forge.pr.merge.cancel.started` claim a pull request before the external write. Recovery reads GitLab to settle an interrupted operation. An inconclusive response keeps the claim open.
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
- `/flow`: `untilPipeline`, `land`, `untilPrEnded` and `untilHeadMoved` for
  workflow scripts, built on those queries. `land` with `auto`
  reads the pull request between its waits, so a script that uses it lists
  `forge.pr.read` on the repository next to `forge.pr.merge`.
- `pushReaction`: a built-in workflow that, on a push to a branch, names the
  git worktrees made from it, found by the remote their base pushes to;
  `checkouts` adds local clones the git module cannot verify.

`./cockpit` is the plugin's page: the watched repositories, the merges the server holds for later with a button that calls
each off, and the observed pull requests with the checks of their heads and their latest pipelines.
