/** What the plan page makes of a plan: how far it has come, what a revision changed, and which revision is shown. */

import type { WorkState } from "@niwa-labs/ui-kit";

import type { ItemState, PlanItem, PlanSummary } from "./actions.ts";

/** The ring an item is drawn with: a decision still ahead is a wait for somebody. */
export const ITEM_RING: Readonly<Record<ItemState, WorkState>> = {
  open: "waiting",
  planned: "pending",
  done: "done",
  dropped: "skipped",
};

export const ITEM_LABEL: Readonly<Record<ItemState, string>> = {
  open: "Ждёт решения",
  planned: "Запланирован",
  done: "Выполнен",
  dropped: "Снят",
};

/** How many items stand in each state, and how many of the work that is still to be done are done. */
export function progressOf(items: readonly PlanItem[]): { counts: Record<ItemState, number>; done: number; total: number } {
  const counts: Record<ItemState, number> = { open: 0, planned: 0, done: 0, dropped: 0 };
  for (const item of items) counts[item.state] += 1;
  // Dropped work is no longer owed: it is neither done nor still to do.
  return { counts, done: counts.done, total: items.length - counts.dropped };
}

/** The plans in the order of the page: those with a decision ahead first, then the others by name. */
export function plansInOrder(plans: readonly PlanSummary[]): PlanSummary[] {
  return [...plans].sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || a.of.localeCompare(b.of));
}

export type ItemChange =
  | { kind: "added"; item: PlanItem }
  | { kind: "removed"; item: PlanItem }
  | { kind: "changed"; item: PlanItem; before: PlanItem }
  | { kind: "same"; item: PlanItem };

/**
 * What a revision did to the items of the one before it, in the order of the revision, then the items it removed.
 * An item that kept its text, state and note but moved is the same: the order is the plan's own and shows as it is.
 */
export function changesBetween(before: readonly PlanItem[], after: readonly PlanItem[]): ItemChange[] {
  const earlier = new Map(before.map((item) => [item.id, item]));
  const kept = new Set<string>();
  const changes: ItemChange[] = after.map((item): ItemChange => {
    const was = earlier.get(item.id);
    if (was === undefined) return { kind: "added", item };
    kept.add(item.id);
    return was.text === item.text && was.state === item.state && was.note === item.note ? { kind: "same", item } : { kind: "changed", item, before: was };
  });
  for (const item of before) if (!kept.has(item.id)) changes.push({ kind: "removed", item });
  return changes;
}

/** What changed about an item, in a few words: its state or its words. */
export function changeText(change: Extract<ItemChange, { kind: "changed" }>): string {
  const parts: string[] = [];
  if (change.before.state !== change.item.state) parts.push(`${ITEM_LABEL[change.before.state]} → ${ITEM_LABEL[change.item.state]}`);
  if (change.before.text !== change.item.text) parts.push("Текст обновлён");
  if (change.before.note !== change.item.note) parts.push(change.item.note === undefined ? "Заметка удалена" : "Заметка обновлена");
  return parts.join(", ");
}

/** The revision a page address asks for: a whole number from 1 up to the latest, or none for the latest. */
export function revisionOf(asked: string | undefined, revisions: number): number | undefined {
  if (asked === undefined || !/^[1-9][0-9]*$/.test(asked)) return undefined;
  const rev = Number(asked);
  return rev <= revisions ? rev : undefined;
}
