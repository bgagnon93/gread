/**
 * Optimal Recognition Point: the character a reader's eye should fix on.
 *
 * Roughly one-third into the word, clamped by length bands (the classic
 * Spritz-style mapping). The UI pins this character to a fixed column and
 * tints it, so the eye never has to re-center between words.
 *
 * Letters only are counted toward length intuition, but we index into the raw
 * string so leading quotes/brackets nudge the pivot right — which is what we
 * want visually.
 */
export function orpIndex(text: string): number {
  const len = text.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}
