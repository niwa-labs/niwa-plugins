// The question a memory asks the owner before a note about him leaves it. It names the note and its revision, and the
// purpose the note was wanted for; it never holds the note's text, which anyone who can read the open requests would
// read with it. The owner's page shows the text through a read of the note that is checked when it is shown.

/** The name of the question a memory asks the owner before a note about him leaves. */
export const SHARE_QUESTION = "memory.share";

/** The note a share question is about: whose memory, which note, which revision of its text. */
export interface ShareReference {
  readonly memory: string;
  readonly note: string;
  readonly revision: number;
}

/** The detail of the question: the note it is about and the purpose it was wanted for. */
export function shareDetail(reference: ShareReference, purpose: string): string {
  return `Note ${reference.note} of the memory of ${reference.memory}, revision ${String(reference.revision)}.\nWanted to: ${purpose}`;
}

const DETAIL = /^Note (note-[0-9a-f]+) of the memory of (\S+), revision (\d+)\.\nWanted to: ([\s\S]*)$/;

/** The note and the purpose a share question's detail names, when it names them. */
export function shareReferenceOf(detail: string | undefined): { reference: ShareReference; purpose: string } | undefined {
  const found = detail === undefined ? null : DETAIL.exec(detail);
  if (found === null) return undefined;
  return { reference: { note: found[1]!, memory: found[2]!, revision: Number(found[3]) }, purpose: found[4]! };
}
