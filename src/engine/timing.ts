import type { Word } from './tokenize.js';

const STRONG_PUNCT = /[.!?…]["'’”)\]]?$/;
const WEAK_PUNCT = /[,;:—-]["'’”)\]]?$/;
// A hyphen or slash *inside* a word (non-space on both sides), e.g. the breaks
// in "twenty-first-century" or "and/or". Trailing dashes don't count.
const INTERNAL_BREAK = /(?<=\S)[-/](?=\S)/g;

const LONG_WORD_THRESHOLD = 8;
const LONG_WORD_PER_CHAR = 0.16;
const LONG_WORD_CAP = 2.0; // max extra dwell from raw length alone
const COMPOUND_PER_SEGMENT = 0.25; // extra dwell per internal hyphen/slash

/**
 * Per-word timing weight (a multiplier on the base WPM delay).
 *
 * Real reading isn't metronomic. On top of a base of 1 we add dwell for:
 *  - punctuation: a long pause at sentence ends, a shorter one at clauses;
 *  - length: long words grow ~linearly with character count (capped) — steeply
 *    enough to keep per-character reading time roughly flat, so a ~13-char word
 *    holds ~1.8x and a ~20-char word ~2.9x a normal word;
 *  - compounds: each internal hyphen/slash adds dwell, so a single-flash
 *    "twenty-first-century" lingers long enough to actually read (~2.5x);
 *  - block ends: a brief reset between paragraphs.
 *
 * Returns 1 for an ordinary mid-sentence word.
 */
export function wordMultiplier(word: Word, punctuationPause: boolean): number {
  let m = 1;
  const text = word.text;

  if (punctuationPause) {
    if (STRONG_PUNCT.test(text)) m += 1.0;
    else if (WEAK_PUNCT.test(text)) m += 0.4;
  }

  // Long words need proportionally more dwell time (capped so a giant word
  // doesn't stall completely).
  if (text.length > LONG_WORD_THRESHOLD) {
    m += Math.min((text.length - LONG_WORD_THRESHOLD) * LONG_WORD_PER_CHAR, LONG_WORD_CAP);
  }

  // Compounds are several words in one flash — give each joint extra time.
  const breaks = text.match(INTERNAL_BREAK)?.length ?? 0;
  m += breaks * COMPOUND_PER_SEGMENT;

  // Brief reset between paragraphs.
  if (word.endsBlock) m += 0.5;

  return m;
}
