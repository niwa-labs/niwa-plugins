// When two texts say the same: they are the same sequence of words, whatever their case, spacing and
// punctuation. Nothing looser may stand for the same claim: a different order, number or negation says
// another thing, and a note's standing (the owner's word, how many sources back it) follows its claim.

/** The words of a text in order: letters and digits of any script, lowercased, none left out. */
function sequence(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether two texts say the same: the same words in the same order. */
export function same(one: string, other: string): boolean {
  const a = sequence(one);
  const b = sequence(other);
  return a.length > 0 && a.length === b.length && a.every((word, at) => word === b[at]);
}
