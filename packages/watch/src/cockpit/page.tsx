/** What every session and run is doing, which of them the watch flagged, and how the flags came and went. */

import { EntityLink, recordList, useCall, useProjection } from "@niwa-labs/cockpit-sdk";
import { Badge, StateRing } from "@niwa-labs/ui-kit";

import { listAction, type Reading } from "./actions.ts";
import { KIND_LABEL, REFRESH_ON, RING, STATE_LABEL, agoText, countByState, incidents, ordered, subjectName, subjectText, troubled, type Incident } from "./subjects.ts";

/** The flags the live feed holds: recent ones, not the whole history. */
const FLAGS = recordList({ types: ["watch.stuck", "watch.recovered"] }, 200);

function SubjectLink({ subject }: { subject: string }) {
  const name = subjectName(subject);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-medium">{subjectText(subject)}</span>
      {name.kind === "run" ? <EntityLink entity={{ kind: "run", id: name.id }} short /> : null}
    </span>
  );
}

function SubjectRow({ reading, now }: { reading: Reading; now: number }) {
  return (
    <li data-slot="subject-row" data-state={reading.state} className="flex min-w-0 items-center gap-3 py-2">
      <StateRing state={RING[reading.state]} label={STATE_LABEL[reading.state]} />
      <SubjectLink subject={reading.subject} />
      <Badge variant={troubled(reading.state) ? "destructive" : "secondary"}>{STATE_LABEL[reading.state]}</Badge>
      {reading.kind === undefined ? null : <span className="text-xs text-muted-foreground">{KIND_LABEL[reading.kind]}</span>}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        since {agoText(reading.since, now)} · last sign {agoText(reading.last, now)}
      </span>
    </li>
  );
}

function IncidentRow({ incident, now }: { incident: Incident; now: number }) {
  const recovered = incident.recoveredAt !== undefined;
  return (
    <li data-slot="incident-row" data-recovered={recovered} className="flex min-w-0 items-center gap-3 py-2">
      <StateRing state={recovered ? "done" : "failed"} label={recovered ? "Recovered" : "Stuck"} />
      <SubjectLink subject={incident.subject} />
      <span className="text-xs text-muted-foreground">{KIND_LABEL[incident.kind]}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        flagged {agoText(incident.since, now)}
        {incident.recoveredAt === undefined ? "" : ` · recovered ${agoText(incident.recoveredAt, now)}`}
      </span>
    </li>
  );
}

export function WatchPage() {
  const subjects = useCall(listAction, {}, { refreshOn: { types: REFRESH_ON.types } });
  const flags = incidents(useProjection(FLAGS));
  const now = Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Watch</h2>
      {subjects.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the subjects…</p>
      ) : subjects.isError ? (
        <p role="alert" className="text-sm text-destructive">The subjects could not be read: {subjects.error.message}</p>
      ) : subjects.data.subjects.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is being watched yet.</p>
      ) : (
        <>
          <div data-slot="watch-counts" className="flex flex-wrap gap-2">
            {countByState(subjects.data.subjects).map(({ state, count }) => (
              <Badge key={state} variant={troubled(state) ? "destructive" : "outline"}>
                {STATE_LABEL[state]} {count}
              </Badge>
            ))}
          </div>
          <ul data-slot="subjects" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {ordered(subjects.data.subjects).map((reading) => (
              <SubjectRow key={reading.subject} reading={reading} now={now} />
            ))}
          </ul>
        </>
      )}
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Recently stuck and recovered</h3>
        {flags.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was flagged since this page was opened or in the recent records.</p>
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
