/** What the evidence page makes of attestations and of the requirement a person asks about. */

import type { Address, Attestation, Claim, Requirement, Uncovered } from "./actions.ts";

/** A commit id as a person reads it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** What a claim says, in a sentence. */
export function claimText(claim: Claim): string {
  if (claim.kind === "verdict") return `${claim.name} · ${claim.outcome === "pass" ? "проверка пройдена" : "проверка не пройдена"} · ${shortSha(claim.sha)}`;
  if (claim.at === "head") return `Пайплайн №${String(claim.pipeline)} успешно проверил коммит ${shortSha(claim.sha)}`;
  const how = claim.pipelineKind === "train" ? "очередь слияния" : "результат слияния";
  return `Пайплайн №${String(claim.pipeline)} прошёл · ${how} ${shortSha(claim.sourceSha)} → ${shortSha(claim.targetSha)}`;
}

/** An address as the page names it. */
export function who(address: Address): string {
  const kinds: Readonly<Record<string, string>> = { owner: "владелец", client: "клиент", session: "сессия", host: "хост", handler: "обработчик", agent: "агент" };
  const kind = kinds[address.kind] ?? address.kind;
  if (address.harness !== undefined && address.id !== undefined) return `${kind} ${address.harness}/${address.id}`;
  return address.id === undefined ? kind : `${kind} ${address.id}`;
}

/** What it means that a requirement is not covered. */
export const UNCOVERED_TEXT: Readonly<Record<Uncovered, string>> = {
  none: "Подходящих свидетельств нет.",
  "target-moved": "Свидетельство относится к другому целевому коммиту.",
  "not-merge-result": "Есть проверка исходного коммита. Для требования нужен результат слияния.",
  failed: "Последняя проверка не пройдена.",
  "excluded-author": "Требование исключает авторов всех успешных проверок.",
};

/** The requirement an attestation stands for: what it would cover if nothing else were said about its subject. */
export function requirementOf(attestation: Pick<Attestation, "subject" | "claim">): Requirement {
  const { subject, claim } = attestation;
  if (claim.kind === "verdict") return { kind: "verdict", subject, name: claim.name, sha: claim.sha };
  if (claim.at === "head") return { kind: "ci", at: "head", subject, sha: claim.sha };
  return { kind: "ci", at: "merge-result", subject, sourceSha: claim.sourceSha, targetSha: claim.targetSha };
}

/** A requirement as one text, so equal requirements are found equal. */
export function requirementKey(requirement: Requirement): string {
  return JSON.stringify(Object.entries(requirement).sort(([a], [b]) => a.localeCompare(b)));
}

/** The attestations by subject, the subject of the latest attestation first and each subject's latest first. */
export function bySubject(items: readonly Attestation[]): Array<{ subject: string; attestations: Attestation[] }> {
  const groups = new Map<string, Attestation[]>();
  for (const item of items) {
    const group = groups.get(item.subject);
    if (group === undefined) groups.set(item.subject, [item]);
    else group.push(item);
  }
  const latest = (group: readonly Attestation[]): number => Math.max(...group.map((one) => one.at));
  return [...groups.entries()]
    .map(([subject, attestations]) => ({ subject, attestations: [...attestations].sort((a, b) => b.at - a.at) }))
    .sort((a, b) => latest(b.attestations) - latest(a.attestations));
}

/** What a person types to ask whether a requirement is covered. */
export type RequirementForm = {
  kind: "merge-result" | "head" | "verdict";
  subject: string;
  sha: string;
  targetSha: string;
  name: string;
};

export const EMPTY_FORM: RequirementForm = { kind: "merge-result", subject: "", sha: "", targetSha: "", name: "" };

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The requirement the form describes, or what is wrong with it. */
export function requirementFromForm(form: RequirementForm): { requirement: Requirement } | { problem: string } {
  const subject = form.subject.trim();
  if (subject === "") return { problem: "Укажите объект, например gitlab.example.com/acme/billing/pr/7." };
  if (subject.length > 512) return { problem: "Длина объекта проверки не должна превышать 512 символов." };
  const sha = form.sha.trim().toLowerCase();
  const sourceName = form.kind === "merge-result" ? "исходного коммита" : "коммита";
  if (!SHA.test(sha)) return { problem: `Укажите полный хеш ${sourceName}.` };
  if (form.kind === "head") return { requirement: { kind: "ci", at: "head", subject, sha } };
  if (form.kind === "verdict") {
    const name = form.name.trim();
    return name === "" ? { problem: "Укажите название проверки, например gates." } : { requirement: { kind: "verdict", subject, name, sha } };
  }
  const targetSha = form.targetSha.trim().toLowerCase();
  if (!SHA.test(targetSha)) return { problem: "Укажите полный хеш целевого коммита." };
  return { requirement: { kind: "ci", at: "merge-result", subject, sourceSha: sha, targetSha } };
}
