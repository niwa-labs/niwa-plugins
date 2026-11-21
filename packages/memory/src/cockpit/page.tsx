/** The memory of an agent: what is shown first, every note it holds, its pages, and the questions waiting for the owner. */

import { EntityLink, PageLink, pathFor, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { Badge, Markdown } from "@niwa-labs/ui-kit";

import { MAX_NOTES, agentListAction, noteGetAction, noteListAction, openAction, pageGetAction, pageListAction, type Note, type PageSummary } from "./actions.ts";
import { memoryChoice, newestFirst, shareQuestions, shownText, sourceText, standingText, topParts, type ShareQuestion } from "./notes.ts";

const NOTES = { refreshOn: { types: ["memory.note.*", "memory.consolidated"] } };
const PAGES = { refreshOn: { types: ["memory.page.written"] } };
const SHARES = { refreshOn: { types: ["request.*", "memory.share.*"] } };

function memoryPath(memory: string, page?: string): string {
  return pathFor("/memory", {}, { memory, page });
}

function Failed({ what, message }: { what: string; message: string }) {
  return <p role="alert" className="text-sm text-destructive">The {what} could not be read: {message}</p>;
}

function NoteRow({ note }: { note: Note }) {
  return (
    <li data-slot="note-row" data-about={note.about} data-top={note.top} className="flex min-w-0 flex-col gap-1 py-2">
      <span className="text-sm">{note.text}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={note.about === "owner" ? "secondary" : "outline"}>{note.about === "owner" ? "About the owner" : "About the work"}</Badge>
        {note.project === undefined ? null : <span className="font-mono">{note.project}</span>}
        <span>{standingText(note)}</span>
        <span>from {sourceText(note.source)}</span>
        {note.top ? <Badge variant="default">{note.pinned ? "Top, by hand" : "Top"}</Badge> : null}
        {note.revision > 1 ? <span>revision {note.revision}</span> : null}
      </div>
    </li>
  );
}

function TopLayer({ notes }: { notes: readonly Note[] }) {
  const parts = topParts(notes);
  if (parts.length === 0) return <p className="text-sm text-muted-foreground">Nothing is lifted into the top layer yet.</p>;
  return (
    <div data-slot="top-layer" className="flex min-w-0 flex-col gap-3">
      {parts.map((part) => (
        <section key={part.heading} data-slot="top-part" className="flex min-w-0 flex-col gap-1">
          <h4 className="truncate text-xs font-semibold text-muted-foreground">{part.heading}</h4>
          <ul className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {part.notes.map((note) => (
              <NoteRow key={note.note} note={note} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PageBody({ memory, page }: { memory: string; page: string }) {
  const got = useCall(pageGetAction, { memory, page }, PAGES);
  if (got.isPending) return <p className="text-sm text-muted-foreground">Loading the page…</p>;
  if (got.isError) return <Failed what="page" message={got.error.message} />;
  return (
    <article data-slot="memory-page" className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <h4 className="text-sm font-semibold">{got.data.title}</h4>
      <Markdown text={got.data.text} />
    </article>
  );
}

function Pages({ memory, open }: { memory: string; open: string | undefined }) {
  const pages = useCall(pageListAction, { memory }, PAGES);
  if (pages.isPending) return <p className="text-sm text-muted-foreground">Loading the pages…</p>;
  if (pages.isError) return <Failed what="pages" message={pages.error.message} />;
  if (pages.data.pages.length === 0) return <p className="text-sm text-muted-foreground">No pages yet.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul data-slot="pages" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
        {pages.data.pages.map((page: PageSummary) => (
          <li key={page.page} data-slot="page-row" className="flex min-w-0 items-center gap-3 py-2">
            <PageLink to={memoryPath(memory, page.page)} className="min-w-0 truncate text-sm font-medium hover:underline">
              {page.title}
            </PageLink>
            <span className="font-mono text-xs text-muted-foreground">{page.page}</span>
            {page.project === undefined ? null : <span className="text-xs text-muted-foreground">{page.project}</span>}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">revision {page.revision}</span>
          </li>
        ))}
      </ul>
      {open === undefined ? null : <PageBody memory={memory} page={open} />}
    </div>
  );
}

/** The note a question is about, read when it is shown: its text only while it holds as the question named it. */
function QuestionNote({ reference }: { reference: NonNullable<ShareQuestion["reference"]> }) {
  const got = useCall(noteGetAction, { memory: reference.memory, note: reference.note }, NOTES);
  if (got.isPending) return <span className="text-xs text-muted-foreground">Reading the note…</span>;
  if (got.isError) return <span className="text-xs text-muted-foreground">The note can no longer be read.</span>;
  const text = shownText(reference, got.data);
  return text === undefined ? (
    <span className="text-xs text-muted-foreground">The note changed since this was asked.</span>
  ) : (
    <span className="whitespace-pre-wrap text-sm">{text}</span>
  );
}

function ShareQuestions({ memory }: { memory: string }) {
  const open = useCall(openAction, {}, SHARES);
  if (open.isPending) return <p className="text-sm text-muted-foreground">Loading the questions…</p>;
  if (open.isError) return <Failed what="questions" message={open.error.message} />;
  const questions = shareQuestions(open.data.requests, memory);
  if (questions.length === 0) return <p className="text-sm text-muted-foreground">No question waits for you about what this memory may tell.</p>;
  return (
    <ul data-slot="share-questions" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
      {questions.map((question) => (
        <li key={question.id} data-slot="share-question" className="flex min-w-0 flex-col gap-1 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{question.title}</span>
            <EntityLink entity={{ kind: "request", id: question.id }} short />
          </div>
          {question.reference === undefined ? null : <QuestionNote reference={question.reference} />}
          {question.purpose === undefined ? null : <span className="whitespace-pre-wrap text-xs text-muted-foreground">Wanted to: {question.purpose}</span>}
        </li>
      ))}
    </ul>
  );
}

function MemoryView({ memory, page }: { memory: string; page: string | undefined }) {
  const notes = useCall(noteListAction, { memory, limit: MAX_NOTES }, NOTES);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Shown first</h3>
        {notes.isPending ? <p className="text-sm text-muted-foreground">Loading the notes…</p> : notes.isError ? <Failed what="notes" message={notes.error.message} /> : <TopLayer notes={notes.data.notes} />}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Waiting for you</h3>
        <ShareQuestions memory={memory} />
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Notes</h3>
        {notes.isPending ? (
          <p className="text-sm text-muted-foreground">Loading the notes…</p>
        ) : notes.isError ? (
          <Failed what="notes" message={notes.error.message} />
        ) : notes.data.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">This memory holds no notes yet.</p>
        ) : (
          <ul data-slot="notes" className="divide-y rounded-lg border bg-card px-3 text-card-foreground">
            {newestFirst(notes.data.notes).map((note) => (
              <NoteRow key={note.note} note={note} />
            ))}
          </ul>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Pages</h3>
        <Pages memory={memory} open={page} />
      </section>
    </div>
  );
}

export function MemoryPage({ search }: PageProps<"/memory">) {
  const agents = useCall(agentListAction, {});
  const names = agents.data?.items.map((one) => one.name) ?? [];
  const memory = memoryChoice(search["memory"], names);
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Memory</h2>
      {agents.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the memories…</p>
      ) : agents.isError ? (
        <Failed what="memories" message={agents.error.message} />
      ) : memory === undefined ? (
        <p className="text-sm text-muted-foreground">There is no agent, so no memory.</p>
      ) : (
        <>
          <nav data-slot="memories" className="flex flex-wrap items-center gap-1 text-sm">
            {names.map((name) => (
              <PageLink key={name} to={memoryPath(name)} className={name === memory ? "rounded bg-muted px-2 py-0.5 font-semibold" : "rounded px-2 py-0.5 hover:bg-muted"}>
                {name}
              </PageLink>
            ))}
          </nav>
          <MemoryView key={memory} memory={memory} page={search["page"]} />
        </>
      )}
    </div>
  );
}
