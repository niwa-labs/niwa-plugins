/** What every session and run is doing, which of them the watch flagged, and how the flags came and went. */

import { EntityLink, recordList, useCall, useProjection } from "@niwa-labs/cockpit-sdk";
import { CopyValue, StateRing } from "@niwa-labs/ui-kit";

import { decisionText, decisionTypes } from "./decisions.ts";
import { listAction, type Reading } from "./actions.ts";
import { KIND_LABEL, REFRESH_ON, RING, STATE_LABEL, agoText, incidents, ordered, subjectName, troubled, type Incident } from "./subjects.ts";

/** The flags the live feed holds: recent ones, not the whole history. */
const FLAGS = recordList({ types: ["watch.stuck", "watch.recovered"] }, 200);

const DECISIONS = recordList({ types: decisionTypes }, 200);

function SubjectLink({ subject }: { subject: string }) {
  const name = subjectName(subject);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
      {name.kind === "run" ? <>Запуск <EntityLink entity={{ kind: "run", id: name.id }} short /></> :
        <>Сессия {name.harness} <CopyValue value={name.id} /></>}
    </span>
  );
}

function SubjectRow({ reading, now }: { reading: Reading; now: number }) {
  return (
    <li data-slot="subject-row" data-state={reading.state} className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", columnGap: "0.75rem", paddingBlock: "0.6rem" }}>
      <StateRing state={RING[reading.state]} label={STATE_LABEL[reading.state]} />
      <div className="flex min-w-0 flex-col gap-1">
        <SubjectLink subject={reading.subject} />
        <p className="desk-tools text-xs text-muted-foreground">
          <span className={troubled(reading.state) ? "font-medium text-destructive" : "font-medium text-foreground"}>{STATE_LABEL[reading.state]}</span>
          {reading.kind === undefined ? null : <span>{KIND_LABEL[reading.kind]}</span>}
          <span>Состояние отмечено {agoText(reading.since, now)}</span>
          <span>Последняя активность {agoText(reading.last, now)}</span>
        </p>
      </div>
    </li>
  );
}

function IncidentRow({ incident, now }: { incident: Incident; now: number }) {
  const recovered = incident.recoveredAt !== undefined;
  return (
    <li data-slot="incident-row" data-recovered={recovered} className="min-w-0" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "start", columnGap: "0.75rem", paddingBlock: "0.6rem" }}>
      <StateRing state={recovered ? "done" : "failed"} label={recovered ? "Восстановилось" : "Застряло"} />
      <div className="flex min-w-0 flex-col gap-1">
        <SubjectLink subject={incident.subject} />
        <p className="desk-tools text-xs text-muted-foreground">
          <span>{KIND_LABEL[incident.kind]}</span>
          <span>Замечено {agoText(incident.since, now)}</span>
          {incident.recoveredAt === undefined ? null : <span>Восстановилось {agoText(incident.recoveredAt, now)}</span>}
        </p>
      </div>
    </li>
  );
}

export function WatchPage() {
  const subjects = useCall(listAction, {}, { refreshOn: { types: REFRESH_ON.types } });
  const flags = incidents(useProjection(FLAGS));
  const decisions = useProjection(DECISIONS).flatMap(row => {
    const text = decisionText(row);
    return text ? [{ id: row.id, at: row.at, text }] : [];
  });
  const now = Date.now();
  const rows = ordered(subjects.data?.subjects ?? []);
  const needsAttention = (one: Reading) => troubled(one.state) || one.state === "waiting-human";
  const urgent = rows.filter(needsAttention);
  const rest = rows.filter((one) => !needsAttention(one));
  const list = (items: Reading[]) => (
    <ul data-slot="subjects" className="divide-y rounded-lg border bg-card px-3">
      {items.map((reading) => <SubjectRow key={reading.subject} reading={reading} now={now} />)}
    </ul>
  );
  return (
    <div className="desk-page">
      {subjects.isPending ? (
        <p className="text-sm text-muted-foreground">Загружаем сессии и запуски…</p>
      ) : subjects.isError ? (
        <p role="alert" className="text-sm text-destructive">Не удалось загрузить наблюдения. {subjects.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Хост ещё не наблюдает ни одной сессии или запуска.</p>
      ) : (
        <>
          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-semibold">Требуют внимания</h3>
            {urgent.length ? list(urgent) : <p className="text-sm text-muted-foreground">Ничего не застряло и не ждёт ответа.</p>}
          </section>
          {rest.length ? <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-semibold">Остальные сессии и запуски</h3>
            {list(rest)}
          </section> : null}
        </>
      )}
      {decisions.length > 0 && <section>
        <h3 className="text-sm font-semibold">Недавние слияния и отказы записи</h3>
        <ul className="divide-y rounded-lg border px-3">
          {decisions.slice().reverse().map(row => <li key={row.id} className="py-2 text-sm">{row.text} · {agoText(row.at, now)}</li>)}
        </ul>
      </section>}
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold">История сбоев</h3>
        {flags.length === 0 ? (
          <p className="text-sm text-muted-foreground">В недавних записях сбоев нет.</p>
        ) : (
          <ul data-slot="incidents" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {flags.map((incident) => (
              <IncidentRow key={`${incident.subject}/${incident.kind}/${String(incident.since)}`} incident={incident} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
