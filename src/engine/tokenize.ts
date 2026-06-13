/** A word lifted from the source text, before chunking/timing is applied. */
export interface Word {
  text: string;
  /** True if this is the last word of its paragraph/line (gets a block pause). */
  endsBlock: boolean;
}

/**
 * Split arbitrary selected text into words.
 *
 * - Paragraphs are separated on runs of newlines; the last word of each
 *   paragraph is flagged `endsBlock` so timing can add a reset pause.
 * - Whitespace within a paragraph is normalized to single spaces.
 * - Empty / whitespace-only input yields an empty list.
 *
 * Trailing punctuation stays attached to its word so the timing layer can
 * detect sentence/clause boundaries.
 */
export function splitWords(text: string): Word[] {
  const out: Word[] = [];
  const paragraphs = text.split(/\n+/);
  for (const para of paragraphs) {
    const words = para.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    words.forEach((w, i) => {
      out.push({ text: w, endsBlock: i === words.length - 1 });
    });
  }
  return out;
}
