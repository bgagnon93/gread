/**
 * Throwaway harness wiring the pure RSVP engine to a plain DOM, so the reading
 * *feel* (timing, ORP) can be tuned before any extension work. Not shipped.
 */
import { RsvpEngine } from '../engine/rsvp.js';
import type { ReaderState, Token } from '../engine/types.js';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const wordEl = $('word');
const scrub = $<HTMLInputElement>('scrub');
const positionEl = $('position');
const remainingEl = $('remaining');
const playpause = $<HTMLButtonElement>('playpause');
const wpm = $<HTMLInputElement>('wpm');
const wpmVal = $('wpmVal');
const chunk = $<HTMLInputElement>('chunk');
const chunkVal = $('chunkVal');
const input = $<HTMLTextAreaElement>('input');

const engine = new RsvpEngine({ wpm: 300, chunkSize: 1 });

/** Render the current word with the ORP letter tinted. */
function renderToken(token: Token | null): void {
  if (!token) {
    wordEl.innerHTML =
      '<span class="left"></span><span class="pivot">&nbsp;</span><span class="right"></span>';
    return;
  }
  const { text, orpIndex } = token;
  const before = text.slice(0, orpIndex);
  const pivot = text.slice(orpIndex, orpIndex + 1) || ' ';
  const after = text.slice(orpIndex + 1);
  wordEl.innerHTML =
    `<span class="left">${escape(before)}</span>` +
    `<span class="pivot">${escape(pivot)}</span>` +
    `<span class="right">${escape(after)}</span>`;
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** Estimate seconds of reading left from remaining tokens at current WPM. */
function formatRemaining(state: ReaderState): string {
  const left = state.total - state.index;
  if (left <= 0) return '0:00';
  const secs = Math.round((left * 60) / (state.wpm / state.chunkSize));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function syncState(state: ReaderState): void {
  scrub.max = String(Math.max(0, state.total - 1));
  scrub.value = String(state.index);
  positionEl.textContent = `${state.total === 0 ? 0 : state.index + 1} / ${state.total}`;
  remainingEl.textContent = formatRemaining(state);
  playpause.textContent = state.playing ? 'Pause' : 'Play';
}

engine.on('tick', (state, token) => {
  renderToken(token);
  scrub.value = String(state.index);
  positionEl.textContent = `${state.index + 1} / ${state.total}`;
  remainingEl.textContent = formatRemaining(state);
});
engine.on('state', (state) => syncState(state));
engine.on('end', () => {
  playpause.textContent = 'Play';
});

// ---- controls -------------------------------------------------------------

playpause.addEventListener('click', () => engine.toggle());
$('restart').addEventListener('click', () => engine.seek(0));
$('back').addEventListener('click', () => engine.step(-1));
$('fwd').addEventListener('click', () => engine.step(1));

scrub.addEventListener('input', () => engine.seek(Number(scrub.value)));

wpm.addEventListener('input', () => {
  wpmVal.textContent = wpm.value;
  engine.setWpm(Number(wpm.value));
});
chunk.addEventListener('input', () => {
  chunkVal.textContent = chunk.value;
  engine.setChunkSize(Number(chunk.value));
});

input.addEventListener('input', () => engine.load(input.value));

document.addEventListener('keydown', (e) => {
  if (document.activeElement === input) return; // don't hijack typing
  if (e.key === ' ') {
    e.preventDefault();
    engine.toggle();
  } else if (e.key === 'ArrowLeft') {
    engine.step(-1);
  } else if (e.key === 'ArrowRight') {
    engine.step(1);
  }
});

// Kick things off with the sample text.
engine.load(input.value);
