import { RsvpEngine } from '../engine/rsvp.js';
import type { ReaderState, Token } from '../engine/types.js';
import type { Message } from '../shared/messages.js';

/**
 * Content script: on START, read the page selection and mount a style-isolated
 * (Shadow DOM) overlay that runs the RSVP engine.
 *
 * Milestone 3 — the full control set lives in the overlay: an interactive
 * scrubber, WPM and chunk-size sliders, theme switching, a live ETA, and an
 * expanded keyboard map. Settings are not yet persisted (that's Milestone 4),
 * so each launch starts from the defaults below.
 */

const DEFAULT_WPM = 300;
const WPM_STEP = 25;
const THEMES = ['dark', 'light', 'sepia'] as const;
type Theme = (typeof THEMES)[number];

/** Tag for the postMessage relay used to lift a child-frame selection to top. */
const RELAY = '__gread_selection__';

const isTop = window.top === window;
let reader: Reader | null = null;
let awaitingSelection = false;

/**
 * The content script runs in every frame (see manifest `all_frames`). Readers
 * like Audiobookshelf's epub.js render the book in an inner iframe, so the
 * selection lives there, not in the top document. On START each frame checks
 * its own selection; a child frame with text relays it up to the top frame,
 * which is where the full-screen overlay is mounted.
 */
chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg.type !== 'START') return;
  const text = (window.getSelection()?.toString() ?? '').trim();

  if (isTop) {
    if (text) {
      openReader(text);
    } else {
      // A child frame may have the selection; give its relay a moment to
      // arrive before declaring nothing selected.
      awaitingSelection = true;
      setTimeout(() => {
        if (!awaitingSelection) return;
        awaitingSelection = false;
        toast('Select some text first');
      }, 250);
    }
  } else if (text) {
    window.top?.postMessage({ [RELAY]: true, text }, '*');
  }
});

// Top frame: receive a selection relayed from a child frame.
if (isTop) {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data;
    if (data && data[RELAY] === true && typeof data.text === 'string') {
      openReader(data.text);
    }
  });
}

function openReader(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  awaitingSelection = false;
  reader?.destroy();
  reader = new Reader(trimmed);
}

const OVERLAY_CSS = `
  :host { all: initial; }
  .backdrop {
    /* Theme variables; overridden per [data-theme] below. */
    --bg: rgba(8, 9, 12, 0.94);
    --fg: #e6e6e6;
    --muted: #9aa0aa;
    --pivot: #ff5252;
    --accent: #2f6feb;
    --panel: #20242c;
    --panel-edge: #333944;
    --guide: #3a3f48;

    position: fixed; inset: 0; z-index: 2147483647;
    background: var(--bg); color: var(--fg);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1.75rem; font-family: system-ui, sans-serif;
  }
  .backdrop[data-theme="light"] {
    --bg: rgba(250, 250, 250, 0.96); --fg: #1a1a1a; --muted: #6a6a6a;
    --pivot: #d32f2f; --accent: #2f6feb; --panel: #ececec; --panel-edge: #d4d4d4; --guide: #c4c4c4;
  }
  .backdrop[data-theme="sepia"] {
    --bg: rgba(244, 236, 220, 0.97); --fg: #433422; --muted: #8a7a5e;
    --pivot: #b3402a; --accent: #a9762f; --panel: #e8dcc4; --panel-edge: #d3c2a0; --guide: #cbb892;
  }

  .word {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: clamp(2.5rem, 7vw, 4.5rem); line-height: 1;
    display: grid; grid-template-columns: 1fr auto 1fr;
    width: min(620px, 80vw); position: relative;
  }
  .word .left { text-align: right; white-space: pre; }
  .word .pivot { text-align: center; white-space: pre; color: var(--pivot); }
  .word .right { text-align: left; white-space: pre; }
  .word::before, .word::after {
    content: ""; position: absolute; left: 50%; width: 2px; height: 0.6rem;
    background: var(--guide); transform: translateX(-50%);
  }
  .word::before { top: -1.1rem; }
  .word::after { bottom: -1.1rem; }

  .panel {
    display: flex; flex-direction: column; gap: 0.9rem;
    width: min(620px, 80vw);
  }
  .scrub { width: 100%; accent-color: var(--accent); cursor: pointer; }
  .meta {
    display: flex; justify-content: space-between; font-size: 0.78rem;
    color: var(--muted); font-variant-numeric: tabular-nums;
  }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; justify-content: center; }
  .transport { display: flex; gap: 0.4rem; }
  button {
    background: var(--panel); color: var(--fg);
    border: 1px solid var(--panel-edge); border-radius: 8px;
    padding: 0.45rem 0.7rem; font-size: 1rem; cursor: pointer; line-height: 1;
  }
  button:hover { filter: brightness(1.12); }
  button.play { min-width: 3rem; }
  .field { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; color: var(--muted); }
  .field input[type="range"] { accent-color: var(--accent); }
  .field .val { color: var(--fg); font-variant-numeric: tabular-nums; min-width: 2.5rem; }
  select {
    background: var(--panel); color: var(--fg); border: 1px solid var(--panel-edge);
    border-radius: 8px; padding: 0.35rem 0.5rem; font-size: 0.82rem; cursor: pointer;
  }
  .hint { position: fixed; bottom: 1.1rem; font-size: 0.72rem; color: var(--muted); opacity: 0.85; }
  kbd {
    background: var(--panel); border: 1px solid var(--panel-edge);
    border-radius: 4px; padding: 0 0.3rem; font-size: 0.68rem;
  }
`;

class Reader {
  private host: HTMLDivElement;
  private engine: RsvpEngine;
  private theme: Theme = 'dark';

  private backdrop!: HTMLDivElement;
  private wordEl!: HTMLDivElement;
  private scrub!: HTMLInputElement;
  private posEl!: HTMLSpanElement;
  private etaEl!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private wpmInput!: HTMLInputElement;
  private wpmVal!: HTMLSpanElement;
  private chunkInput!: HTMLInputElement;
  private chunkVal!: HTMLSpanElement;
  private themeSelect!: HTMLSelectElement;

  constructor(text: string) {
    this.host = document.createElement('div');
    this.host.id = 'gread-overlay';
    document.documentElement.appendChild(this.host);
    this.build(this.host.attachShadow({ mode: 'open' }));

    this.engine = new RsvpEngine({ wpm: DEFAULT_WPM });
    this.engine.on('tick', (s, t) => {
      this.renderWord(t);
      this.syncProgress(s);
    });
    this.engine.on('state', (s) => {
      this.syncControls(s);
      this.syncProgress(s);
    });
    this.engine.on('end', () => this.setPlayIcon(false));
    this.engine.load(text);

    window.addEventListener('keydown', this.onKey, true);
    // Open paused on the first word; the reader starts it with Space or a click.
  }

  private build(root: ShadowRoot): void {
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'backdrop';
    this.backdrop.dataset.theme = this.theme;
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.engine.toggle();
    });

    this.wordEl = el('div', 'word');

    // --- progress panel ---
    const panel = el('div', 'panel');
    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.className = 'scrub';
    this.scrub.min = '0';
    this.scrub.value = '0';
    this.scrub.addEventListener('input', () => this.engine.seek(Number(this.scrub.value)));

    const meta = el('div', 'meta');
    this.posEl = document.createElement('span');
    this.etaEl = document.createElement('span');
    meta.append(this.posEl, this.etaEl);

    // --- controls ---
    const row = el('div', 'row');

    const transport = el('div', 'transport');
    this.playBtn = button('▶', () => this.engine.toggle());
    this.playBtn.classList.add('play');
    transport.append(
      button('⏮', () => this.engine.seek(0)),
      button('◀', () => this.engine.step(-1)),
      this.playBtn,
      button('▶', () => this.engine.step(1)),
    );

    const [wpmField, wpmInput, wpmVal] = slider('WPM', 100, 1000, WPM_STEP, DEFAULT_WPM);
    this.wpmInput = wpmInput;
    this.wpmVal = wpmVal;
    wpmInput.addEventListener('input', () => this.engine.setWpm(Number(wpmInput.value)));

    const [chunkField, chunkInput, chunkVal] = slider('Chunk', 1, 3, 1, 1);
    this.chunkInput = chunkInput;
    this.chunkVal = chunkVal;
    chunkInput.addEventListener('input', () => this.engine.setChunkSize(Number(chunkInput.value)));

    this.themeSelect = document.createElement('select');
    for (const t of THEMES) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t[0].toUpperCase() + t.slice(1);
      this.themeSelect.appendChild(opt);
    }
    this.themeSelect.value = this.theme;
    this.themeSelect.addEventListener('change', () => this.setTheme(this.themeSelect.value as Theme));

    row.append(transport, wpmField, chunkField, this.themeSelect);
    panel.append(this.scrub, meta, row);

    const hint = el('div', 'hint');
    hint.innerHTML =
      '<kbd>Space</kbd> play · <kbd>←</kbd>/<kbd>→</kbd> step · ' +
      '<kbd>↑</kbd>/<kbd>↓</kbd> speed · <kbd>T</kbd> theme · <kbd>Esc</kbd> close';

    this.backdrop.append(this.wordEl, panel, hint);
    root.append(style, this.backdrop);
  }

  private renderWord(token: Token | null): void {
    if (!token) return;
    const { text, orpIndex } = token;
    this.wordEl.replaceChildren(
      span('left', text.slice(0, orpIndex)),
      span('pivot', text.slice(orpIndex, orpIndex + 1) || ' '),
      span('right', text.slice(orpIndex + 1)),
    );
  }

  private syncProgress(s: ReaderState): void {
    this.scrub.max = String(Math.max(0, s.total - 1));
    this.scrub.value = String(s.index);
    this.posEl.textContent = `${s.total === 0 ? 0 : s.index + 1} / ${s.total}`;
    this.etaEl.textContent = `${formatTime(remainingSeconds(s))} left`;
  }

  private syncControls(s: ReaderState): void {
    this.setPlayIcon(s.playing);
    this.wpmInput.value = String(s.wpm);
    this.wpmVal.textContent = String(s.wpm);
    this.chunkInput.value = String(s.chunkSize);
    this.chunkVal.textContent = String(s.chunkSize);
  }

  private setPlayIcon(playing: boolean): void {
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  private setTheme(theme: Theme): void {
    this.theme = theme;
    this.backdrop.dataset.theme = theme;
    this.themeSelect.value = theme;
  }

  private cycleTheme(): void {
    const next = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length];
    this.setTheme(next);
  }

  private onKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'Escape': stop(e); this.destroy(); break;
      case ' ': stop(e); this.engine.toggle(); break;
      case 'ArrowLeft': stop(e); this.engine.step(-1); break;
      case 'ArrowRight': stop(e); this.engine.step(1); break;
      case 'ArrowUp': stop(e); this.engine.setWpm(this.engine.getState().wpm + WPM_STEP); break;
      case 'ArrowDown': stop(e); this.engine.setWpm(this.engine.getState().wpm - WPM_STEP); break;
      case 't': case 'T': stop(e); this.cycleTheme(); break;
    }
  };

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.engine.pause();
    this.host.remove();
    if (reader === this) reader = null;
  }
}

// ---- small DOM helpers ----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function span(cls: string, text: string): HTMLSpanElement {
  const node = el('span', cls);
  node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Labelled range field → [field, input, valueLabel]. */
function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
): [HTMLDivElement, HTMLInputElement, HTMLSpanElement] {
  const field = el('div', 'field');
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = el('span', 'val');
  val.textContent = String(value);
  field.append(name, input, val);
  return [field, input, val];
}

function stop(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

// ---- timing display -------------------------------------------------------

/** Seconds of reading remaining at the current WPM/chunk. */
function remainingSeconds(s: ReaderState): number {
  const tokensLeft = Math.max(0, s.total - 1 - s.index);
  if (tokensLeft === 0) return 0;
  const wordsLeft = tokensLeft * s.chunkSize;
  const wordsPerSec = s.wpm / 60;
  return wordsLeft / wordsPerSec;
}

function formatTime(secs: number): string {
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Brief, self-dismissing message for the "nothing selected" case. */
function toast(text: string): void {
  const node = document.createElement('div');
  node.textContent = text;
  node.style.cssText =
    'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#20242c;color:#e6e6e6;font:14px system-ui,sans-serif;padding:0.6rem 1rem;' +
    'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);';
  document.documentElement.appendChild(node);
  setTimeout(() => node.remove(), 1800);
}
