// When two texts say the same: nearly all their words are shared, whatever their case and punctuation.

import { words } from "./search.ts";

/** The least share of the words of two texts they must have in common to say the same. */
const ALIKE = 0.8;

/** Whether two texts say the same: the words they share are at least four in five of all their words. */
export function similar(one: string, other: string): boolean {
  const a = new Set(words(one));
  const b = new Set(words(other));
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared) >= ALIKE;
}
