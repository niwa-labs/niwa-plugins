# @niwa-labs/evidence

A plugin that records attestations and what they cover, such as a green
pipeline for a specific pair of commits.

- `evidence.attest { subject, claim }` writes an attestation. Its author is the
  principal of the caller's token, never a field of the payload.
- `evidence.covers { requirement }` says whether a requirement is covered and,
  when it is not, why: `none`, `target-moved`, `not-merge-result`, `failed` or
  `excluded-author`. A merge result covers only the pair of commits it ran on.
- `/records`: the record type, the claims, the requirements and the action
  references.
