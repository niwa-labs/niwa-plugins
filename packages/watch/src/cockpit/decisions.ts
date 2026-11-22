import { z } from "zod";

const caller = z.object({ kind: z.string(), id: z.string().optional(), handler: z.string().optional() });
const refused = z.object({ recordType: z.string(), entity: z.string(), reason: z.string() });
const merge = z.object({
  operation: z.string(),
  pr: z.object({ repo: z.object({ host: z.string(), path: z.string() }), number: z.number() }),
  reason: z.string().optional(), outcome: z.string().optional(),
});

const labels: Record<string, string> = {
  "forge.pr.merge.started": "Запрошено слияние",
  "forge.pr.merge.cancel.started": "Запрошена отмена",
  "forge.pr.merge.cancel.refused": "В отмене отказано",
  "forge.pr.merge.armed": "Слияние отложено",
  "forge.pr.merge.settled": "Подтверждён итог слияния",
  "forge.pr.merge.disarmed": "Отложенное слияние отменено",
  "forge.pr.merge.refused": "В слиянии отказано",
};

export const decisionTypes = ["niwa.record.refused", ...Object.keys(labels)];

export function decisionText(row: { type: string; data: unknown; actor?: unknown }): string | undefined {
  if (row.type === "niwa.record.refused") {
    const data = refused.safeParse(row.data).data;
    const actor = caller.safeParse(row.actor).data;
    const who = actor && (actor.handler ?? actor.id ?? actor.kind);
    if (data) return `${who ? `${who} · ` : ""}${data.recordType} · ${data.entity} · ${data.reason}`;
  }
  const label = labels[row.type];
  const data = merge.safeParse(row.data).data;
  if (!label || !data) return undefined;
  const detail = data.reason ?? data.outcome;
  return `${label} · ${data.pr.repo.host}/${data.pr.repo.path}!${data.pr.number}${detail ? ` · ${detail}` : ""}`;
}
