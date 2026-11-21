# @niwa-labs/evidence

A plugin that records attestations and what they cover, such as a green
pipeline for a specific pair of commits.

- `evidence.attest { subject, claim }` writes an attestation. Its author is the
  principal of the caller's token, never a field of the payload.
- `evidence.covers { requirement }` says whether a requirement is covered and,
  when it is not, why: `none`, `target-moved`, `not-merge-result`, `failed` or
  `excluded-author`. A merge result covers only the pair of commits it ran on.
- `/records`: the record type, the claims, the requirements, the action
  references and the query builder `attested(subject)`, which a script waits for
  or reads with the data typed.
- `./cockpit`: the cockpit page lists the attestations of each subject, says for each whether it still stands, and
  takes a requirement to ask the host whether it is covered.

An attestation counts only if the host's record of who wrote it agrees with its
author: a client that writes `evidence.attested` straight to the journal cannot
attest as somebody else. The default author is the principal of the caller's
token, so a session relaunched under a new token is another author; a composition
that excludes authors by session or agent passes `bind` to give that address.
