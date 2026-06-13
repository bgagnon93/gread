import { splitWords } from './tokenize.js';
import { wordMultiplier } from './timing.js';
import { orpIndex } from './orp.js';
import {
  DEFAULT_OPTIONS,
  type EngineEvent,
  type EngineListener,
  type EngineOptions,
  type ReaderState,
  type Token,
} from './types.js';

/** Minimal timer surface so tests can drive the clock deterministically. */
export interface Scheduler {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The RSVP reading engine. Pure logic — no DOM, no browser APIs.
 *
 * Load text, then drive it with play/pause/seek/step. Subscribers receive
 * `tick` (a new token is current), `state` (play/pause/wpm/etc. changed), and
 * `end` (reached the last token). The UI is a passive subscriber.
 */
export class RsvpEngine {
  private opts: EngineOptions;
  private rawText = '';
  private tokens: Token[] = [];
  private index = 0;
  private playing = false;
  private timer: unknown = null;
  private listeners: Map<EngineEvent, Set<EngineListener>> = new Map();

  constructor(
    options: Partial<EngineOptions> = {},
    private scheduler: Scheduler = realScheduler,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // ---- public API ---------------------------------------------------------

  load(text: string): void {
    this.stopTimer();
    this.rawText = text;
    this.rebuild();
    this.index = 0;
    this.playing = false;
    this.emit('state');
    this.emit('tick');
  }

  play(): void {
    if (this.playing || this.tokens.length === 0) return;
    // If parked on the final token, restart from the top.
    if (this.index >= this.tokens.length - 1) this.index = 0;
    this.playing = true;
    this.emit('state');
    this.run();
  }

  pause(): void {
    if (!this.playing) return;
    this.stopTimer();
    this.playing = false;
    this.emit('state');
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  /** Jump to an absolute token index (clamped). Keeps playing if it was. */
  seek(index: number): void {
    this.index = this.clampIndex(index);
    if (this.playing) {
      this.stopTimer();
      this.run();
    } else {
      this.emit('tick');
    }
  }

  /** Move by `delta` tokens (e.g. -1 / +1). */
  step(delta: number): void {
    this.seek(this.index + delta);
  }

  setWpm(wpm: number): void {
    this.opts.wpm = Math.max(60, Math.min(1500, Math.round(wpm)));
    this.emit('state');
    // Applies from the next token; the in-flight delay keeps its old value.
  }

  setChunkSize(n: number): void {
    const next = Math.max(1, Math.min(5, Math.round(n)));
    if (next === this.opts.chunkSize) return;
    // Preserve reading position (in words) across the rechunk.
    const wordPos = this.index * this.opts.chunkSize;
    this.opts.chunkSize = next;
    this.rebuild();
    this.index = this.clampIndex(Math.floor(wordPos / next));
    this.emit('state');
    this.emit('tick');
  }

  getState(): ReaderState {
    return {
      index: this.index,
      total: this.tokens.length,
      playing: this.playing,
      wpm: this.opts.wpm,
      chunkSize: this.opts.chunkSize,
    };
  }

  getCurrentToken(): Token | null {
    return this.tokens[this.index] ?? null;
  }

  on(event: EngineEvent, cb: EngineListener): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }

  // ---- internals ----------------------------------------------------------

  private rebuild(): void {
    const words = splitWords(this.rawText);
    const tokens: Token[] = [];
    const size = this.opts.chunkSize;
    for (let i = 0; i < words.length; i += size) {
      const group = words.slice(i, i + size);
      const text = group.map((w) => w.text).join(' ');
      // A chunk lingers as long as its slowest member warrants.
      const mult = Math.max(
        ...group.map((w) => wordMultiplier(w, this.opts.punctuationPause)),
      );
      tokens.push({
        text,
        orpIndex: this.opts.orpEnabled ? orpIndex(text) : 0,
        delayMultiplier: mult,
      });
    }
    this.tokens = tokens;
  }

  /** Show the current token, then schedule advancement. */
  private run(): void {
    this.emit('tick');
    const token = this.tokens[this.index];
    if (!token) return;
    const delay = (60000 / this.opts.wpm) * token.delayMultiplier;
    this.timer = this.scheduler.set(() => {
      if (this.index >= this.tokens.length - 1) {
        this.playing = false;
        this.emit('state');
        this.emit('end');
        return;
      }
      this.index += 1;
      this.run();
    }, delay);
  }

  private stopTimer(): void {
    if (this.timer != null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
  }

  private clampIndex(i: number): number {
    if (this.tokens.length === 0) return 0;
    return Math.max(0, Math.min(this.tokens.length - 1, i));
  }

  private emit(event: EngineEvent): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const state = this.getState();
    const token = this.getCurrentToken();
    for (const cb of set) cb(state, token);
  }
}
