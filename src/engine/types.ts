/** A single unit shown on screen at one tick (one word, or a chunk of words). */
export interface Token {
  /** Text to display, e.g. "quick" or "the quick" when chunkSize > 1. */
  text: string;
  /** Index of the pivot (ORP) character within `text`. */
  orpIndex: number;
  /**
   * Static per-token timing weight. Actual delay = (60000 / wpm) * delayMultiplier.
   * 1 = normal; >1 = linger longer (punctuation, long words, block ends).
   */
  delayMultiplier: number;
}

/** Snapshot of the engine, emitted to UI subscribers. */
export interface ReaderState {
  /** Index of the current token in the built token list. */
  index: number;
  /** Total number of tokens. */
  total: number;
  playing: boolean;
  wpm: number;
  /** Words shown at once (1 = classic RSVP). */
  chunkSize: number;
}

/** Tuning knobs for tokenization + timing. */
export interface EngineOptions {
  wpm: number;
  chunkSize: number;
  /** Add extra pause after sentence/clause punctuation. */
  punctuationPause: boolean;
  /** Compute an ORP pivot index (else always 0). */
  orpEnabled: boolean;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  wpm: 300,
  chunkSize: 1,
  punctuationPause: true,
  orpEnabled: true,
};

export type EngineEvent = 'tick' | 'state' | 'end';
export type EngineListener = (state: ReaderState, token: Token | null) => void;
