/** What was attested about each subject, whether it still stands, and a way to ask whether a requirement is covered. */

import { useState } from "react";

import { useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { Button, CopyValue, DataValue, StateRing } from "@niwa-labs/ui-kit";

import { coversAction, listAction, type Attestation } from "./actions.ts";
import { EMPTY_FORM, UNCOVERED_TEXT, bySubject, claimText, requirementFromForm, requirementOf, who, type RequirementForm } from "./coverage.ts";

const REFRESH = { refreshOn: { types: ["evidence.attested"] } };

/** Whether what an attestation says still stands: the host answers for the requirement it stands for. */
function Standing({ attestation }: { attestation: Attestation }) {
  const covered = useCall(coversAction, { requirement: requirementOf(attestation) }, REFRESH);
  if (covered.isPending) return <span>Проверяем актуальность…</span>;
  if (covered.isError) return <span>Не удалось проверить актуальность</span>;
  if (!covered.data.covered) return <span>{UNCOVERED_TEXT[covered.data.why ?? "none"]}</span>;
  return <span>{covered.data.by.includes(attestation.id) ? "Подтверждает требование" : "Требование подтверждено другой записью"}</span>;
}

function AttestationRow({ attestation }: { attestation: Attestation }) {
  const failed = attestation.claim.kind === "verdict" && attestation.claim.outcome === "fail";
  return (
    <li data-slot="attestation-row" data-kind={attestation.claim.kind} className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", columnGap: "0.75rem", paddingBlock: "0.6rem" }}>
      <StateRing state={failed ? "failed" : "done"} label={failed ? "Проверка не пройдена" : "Свидетельство записано"} />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="break-words text-sm font-medium">{claimText(attestation.claim)}</p>
        <p className="desk-tools text-xs text-muted-foreground">
          <span>Автор {who(attestation.author)}</span>
          <time dateTime={new Date(attestation.at).toISOString()}>{new Date(attestation.at).toLocaleString("ru")}</time>
          <CopyValue value={attestation.id} />
        </p>
        <p className="text-xs text-muted-foreground"><Standing attestation={attestation} /></p>
      </div>
    </li>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input className="h-8 rounded-md border bg-background px-2 font-mono text-sm text-foreground" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CoverageCheck() {
  const [form, setForm] = useState<RequirementForm>(EMPTY_FORM);
  const covers = useAction(coversAction);
  const parsed = requirementFromForm(form);
  const set = (change: Partial<RequirementForm>): void => setForm({ ...form, ...change });
  return (
    <section data-slot="coverage-check" className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <h3 className="text-sm font-semibold">Проверить свидетельства для требования</h3>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Тип требования
        <select className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={form.kind} onChange={(event) => set({ kind: event.target.value as RequirementForm["kind"] })}>
          <option value="merge-result">Успешная проверка результата слияния</option>
          <option value="head">Успешный пайплайн коммита</option>
          <option value="verdict">Положительный итог проверки</option>
        </select>
      </label>
      <Field label="Объект проверки" value={form.subject} onChange={(subject) => set({ subject })} />
      <Field label={form.kind === "merge-result" ? "Исходный коммит" : "Коммит"} value={form.sha} onChange={(sha) => set({ sha })} />
      {form.kind === "merge-result" ? <Field label="Целевой коммит" value={form.targetSha} onChange={(targetSha) => set({ targetSha })} /> : null}
      {form.kind === "verdict" ? <Field label="Название проверки" value={form.name} onChange={(name) => set({ name })} /> : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={"problem" in parsed || covers.isPending} onClick={() => "requirement" in parsed && covers.mutate({ requirement: parsed.requirement })}>
          Проверить
        </Button>
        {"problem" in parsed ? <span className="text-xs text-muted-foreground">{parsed.problem}</span> : null}
      </div>
      {covers.isError ? <p role="alert" className="text-xs text-destructive">{covers.error.message}</p> : null}
      {covers.data === undefined ? null : covers.data.covered ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm">Подтверждено записями {covers.data.by.map((id) => <CopyValue key={id} value={id} />)}</p>
      ) : (
        <p role="status" className="text-sm text-destructive">Требование пока не подтверждено. {UNCOVERED_TEXT[covers.data.why ?? "none"]}</p>
      )}
    </section>
  );
}

export function EvidencePage() {
  const attestations = useCall(listAction, {}, REFRESH);
  return (
    <div className="desk-page">
      {attestations.isPending ? (
        <p className="text-sm text-muted-foreground">Загружаем свидетельства…</p>
      ) : attestations.isError ? (
        <p role="alert" className="text-sm text-destructive">Не удалось загрузить свидетельства. {attestations.error.message}</p>
      ) : attestations.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Свидетельств пока нет. Здесь появятся подтверждения проверок и результаты сборок.</p>
      ) : (
        bySubject(attestations.data.items).map((group) => (
          <section key={group.subject} data-slot="subject" className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold"><DataValue value={group.subject} /></h3>
            <ul className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
              {group.attestations.map((attestation) => (
                <AttestationRow key={attestation.id} attestation={attestation} />
              ))}
            </ul>
          </section>
        ))
      )}
      <CoverageCheck />
    </div>
  );
}
