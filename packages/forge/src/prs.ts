/**
 * The pull requests the module observed, folded from its records.
 *
 * A pull request is known from `forge.pr.opened`; its title, base and draft flag follow `forge.pr.updated`, its head
 * `forge.pr.head`, its checks `forge.checks`, and its end `forge.pr.merged` or `forge.pr.closed`. The pipelines are
 * those of `forge.pipeline` that name the pull request. Nothing here asks the server, so a pull request is as old as
 * the last poll of its repository.
 */

import { seq } from "@niwa-labs/core";
import type { JournalReader } from "@niwa-labs/core";

import type { ObservedPr, PrPipeline, PrState } from "./actions.ts";
import { ChecksObserved, PipelineObserved, PrClosed, PrHead, PrMerged, PrOpened, PrUpdated } from "./record-types.ts";
import type { PrRef } from "./record-types.ts";
import type { RepoName } from "./targets.ts";

/** The most pipelines a pull request lists: the latest ones. */
export const PIPELINES_SHOWN = 10;

const TYPES = [PrOpened, PrUpdated, PrHead, ChecksObserved, PipelineObserved, PrMerged, PrClosed] as const;

interface Folded {
  pr: PrRef;
  state: PrState;
  title: string;
  branch: string;
  base: string;
  draft: boolean;
  author: string | undefined;
  head: string | undefined;
  checks: ObservedPr["checks"];
  pipelines: Map<number, PrPipeline>;
  /** The position of the last record that touched it. */
  changed: number;
}

const keyOf = (pr: PrRef): string => `${pr.repo.host}\0${String(pr.repo.projectId)}\0${String(pr.number)}`;

/** Every pull request of the journal, the open ones first and the latest changed first. */
export function observedPrs(journal: JournalReader | undefined, filter: { repo?: RepoName | undefined; state?: PrState | undefined } = {}): ObservedPr[] {
  if (journal === undefined) return [];
  const found = new Map<string, Folded>();
  const touch = (pr: PrRef, at: number): Folded | undefined => {
    const one = found.get(keyOf(pr));
    if (one !== undefined) one.changed = at;
    return one;
  };
  for (const stored of journal.since(seq(0), TYPES.map((type) => type.name))) {
    const at = Number(stored.seq);
    switch (stored.type) {
      case PrOpened.name: {
        const parsed = PrOpened.schema.safeParse(stored.data);
        if (!parsed.success) break;
        const { pr, title, branch, base, author } = parsed.data;
        const before = found.get(keyOf(pr));
        found.set(keyOf(pr), {
          pr,
          state: before?.state ?? "open",
          title,
          branch,
          base,
          draft: before?.draft ?? false,
          author,
          head: before?.head,
          checks: before?.checks ?? "none",
          pipelines: before?.pipelines ?? new Map(),
          changed: at,
        });
        break;
      }
      case PrUpdated.name: {
        const parsed = PrUpdated.schema.safeParse(stored.data);
        const one = parsed.success ? touch(parsed.data.pr, at) : undefined;
        if (parsed.success && one !== undefined) Object.assign(one, { title: parsed.data.title, base: parsed.data.base, draft: parsed.data.draft });
        break;
      }
      case PrHead.name: {
        const parsed = PrHead.schema.safeParse(stored.data);
        const one = parsed.success ? touch(parsed.data.pr, at) : undefined;
        if (parsed.success && one !== undefined) one.head = parsed.data.head;
        break;
      }
      case ChecksObserved.name: {
        const parsed = ChecksObserved.schema.safeParse(stored.data);
        const one = parsed.success ? touch(parsed.data.pr, at) : undefined;
        if (parsed.success && one !== undefined) one.checks = parsed.data.state;
        break;
      }
      case PipelineObserved.name: {
        const parsed = PipelineObserved.schema.safeParse(stored.data);
        if (!parsed.success || parsed.data.pr === undefined) break;
        const one = touch({ repo: parsed.data.repo, number: parsed.data.pr }, at);
        if (one === undefined) break;
        const { pipeline, kind, state, sourceSha, targetSha, mergeSha } = parsed.data;
        one.pipelines.set(pipeline, { pipeline, kind, state, sourceSha, ...(targetSha === undefined ? {} : { targetSha }), ...(mergeSha === undefined ? {} : { mergeSha }) });
        break;
      }
      case PrMerged.name: {
        const parsed = PrMerged.schema.safeParse(stored.data);
        const one = parsed.success ? touch(parsed.data.pr, at) : undefined;
        if (parsed.success && one !== undefined) Object.assign(one, { state: "merged", head: parsed.data.head ?? one.head });
        break;
      }
      case PrClosed.name: {
        const parsed = PrClosed.schema.safeParse(stored.data);
        const one = parsed.success ? touch(parsed.data.pr, at) : undefined;
        if (parsed.success && one !== undefined) one.state = "closed";
        break;
      }
    }
  }
  return [...found.values()]
    .filter((one) => (filter.state === undefined || one.state === filter.state) && (filter.repo === undefined || (one.pr.repo.host === filter.repo.host && one.pr.repo.path === filter.repo.path)))
    .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.changed - a.changed)
    .map(({ changed: _changed, pipelines, author, head, ...rest }) => ({
      ...rest,
      ...(author === undefined ? {} : { author }),
      ...(head === undefined ? {} : { head }),
      pipelines: [...pipelines.values()].sort((a, b) => b.pipeline - a.pipeline).slice(0, PIPELINES_SHOWN),
    }));
}
