/** What was attested about each subject, whether it still stands, and a way to ask whether a requirement is covered. */

import { useState } from "react";

import { useAction, useCall } from "@niwa-labs/cockpit-sdk";
import { Badge, Button, StateRing } from "@niwa-labs/ui-kit";

import { coversAction, listAction, type Attestation } from "./actions.ts";
import { EMPTY_FORM, UNCOVERED_TEXT, bySubject, claimText, requirementFromForm, requirementOf, who, type RequirementForm } from "./coverage.ts";

const REFRESH = { refreshOn: { types: ["evidence.attested"] } };

/** Whether what an attestation says still stands: the host answers for the requirement it stands for. */
function Standing({ attestation }: { attestation: Attestation }) {
  const covered = useCall(coversAction, { requirement: requirementOf(attestation) }, REFRESH);
  if (covered.isPending) return <Badge variant="outline">Checking</Badge>;
  if (covered.isError) return <Badge variant="destructive">Unchecked</Badge>;
  return covered.data.covered ? <Badge variant="secondary">Covers</Badge> : <Badge variant="destructive">Not covered: {covered.data.why ?? "unknown"}</Badge>;
}

function AttestationRow({ attestation }: { attestation: Attestation }) {
  const failed = attestation.claim.kind === "verdict" && attestation.claim.outcome === "fail";
  return (
    <li data-slot="attestation-row" data-kind={attestation.claim.kind} className="flex min-w-0 items-center gap-3 py-2">
      <StateRing state={failed ? "failed" : "done"} label={failed ? "Failed" : "Attested"} />
      <span className="min-w-0 truncate text-sm">{claimText(attestation.claim)}</span>
      <Standing attestation={attestation} />
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {who(attestation.author)} · {new Date(attestation.at).toLocaleString()}
      </span>
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
      <h3 className="text-sm font-semibold">Is a requirement covered?</h3>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Requirement
        <select className="h-8 rounded-md border bg-background px-2 text-sm text-foreground" value={form.kind} onChange={(event) => set({ kind: event.target.value as RequirementForm["kind"] })}>
          <option value="merge-result">A green merge result of two commits</option>
          <option value="head">A green pipeline of a head</option>
          <option value="verdict">A passing verdict of a check</option>
        </select>
      </label>
      <Field label="Subject" value={form.subject} onChange={(subject) => set({ subject })} />
      <Field label={form.kind === "merge-result" ? "Source commit" : "Commit"} value={form.sha} onChange={(sha) => set({ sha })} />
      {form.kind === "merge-result" ? <Field label="Target commit" value={form.targetSha} onChange={(targetSha) => set({ targetSha })} /> : null}
      {form.kind === "verdict" ? <Field label="Check" value={form.name} onChange={(name) => set({ name })} /> : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={"problem" in parsed || covers.isPending} onClick={() => "requirement" in parsed && covers.mutate({ requirement: parsed.requirement })}>
          Check
        </Button>
        {"problem" in parsed ? <span className="text-xs text-muted-foreground">{parsed.problem}</span> : null}
      </div>
      {covers.isError ? <p role="alert" className="text-xs text-destructive">{covers.error.message}</p> : null}
      {covers.data === undefined ? null : covers.data.covered ? (
        <p role="status" className="text-sm">Covered by {covers.data.by.join(", ")}.</p>
      ) : (
        <p role="status" className="text-sm text-destructive">Not covered. {UNCOVERED_TEXT[covers.data.why ?? "none"]}</p>
      )}
    </section>
  );
}

export function EvidencePage() {
  const attestations = useCall(listAction, {}, REFRESH);
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Evidence</h2>
      {attestations.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the attestations…</p>
      ) : attestations.isError ? (
        <p role="alert" className="text-sm text-destructive">The attestations could not be read: {attestations.error.message}</p>
      ) : attestations.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been attested yet.</p>
      ) : (
        bySubject(attestations.data.items).map((group) => (
          <section key={group.subject} data-slot="subject" className="flex min-w-0 flex-col gap-1">
            <h3 className="truncate font-mono text-sm font-semibold">{group.subject}</h3>
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
