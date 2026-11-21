// Search by words, on the host: no model and no service. A text is cut into words, and a query word
// matches a word of a text that is the same or, for a word of four letters or more, starts with it
// ("deploy" finds "deploys" and "deployment"). Texts are ranked by BM25.

/** The words of a text: letters and digits of any script, lowercased; a word of one letter says nothing. */
export function words(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1);
}

/** A text a search ranks, with what it answers when it is found. */
export interface Searchable<T> {
  readonly text: string;
  readonly value: T;
}

/** Whether a query word matches a word of a text. */
function matches(query: string, word: string): boolean {
  return word === query || (query.length >= 4 && word.startsWith(query));
}

const K1 = 1.2;
const B = 0.75;

/** The texts that match any word of the query, best first, with their scores; at most `limit`. */
export function rank<T>(query: string, texts: readonly Searchable<T>[], limit: number): Array<{ value: T; score: number }> {
  const wanted = [...new Set(words(query))];
  if (wanted.length === 0 || texts.length === 0) return [];
  const docs = texts.map((one) => words(one.text));
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  // How many texts hold each query word: a word most texts hold weighs little.
  const holding = wanted.map((query) => docs.filter((doc) => doc.some((word) => matches(query, word))).length);
  const scored: Array<{ value: T; score: number; order: number }> = [];
  docs.forEach((doc, order) => {
    let score = 0;
    wanted.forEach((query, at) => {
      const count = doc.filter((word) => matches(query, word)).length;
      if (count === 0) return;
      const held = holding[at] ?? 0;
      const idf = Math.log(1 + (docs.length - held + 0.5) / (held + 0.5));
      score += (idf * count * (K1 + 1)) / (count + K1 * (1 - B + (B * doc.length) / average));
    });
    const text = texts[order];
    if (score > 0 && text !== undefined) scored.push({ value: text.value, score, order });
  });
  // The better score first; of two the same, the later text, which is the newer.
  scored.sort((a, b) => b.score - a.score || b.order - a.order);
  return scored.slice(0, limit).map(({ value, score }) => ({ value, score: Math.round(score * 1000) / 1000 }));
}
