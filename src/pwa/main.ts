/**
 * gread PWA — Milestone 1: a mobile-first shell that drives the shared RSVP
 * engine from pasted text. The engine in ../engine is reused unchanged; this
 * file is just the second front-end (the browser extension is the first).
 *
 * Next milestone wires in Audiobookshelf (library browsing + epub fetch).
 */
import { RsvpEngine } from '../engine/rsvp.js';
import type { ReaderState, Token } from '../engine/types.js';
import { loadSettings, saveSettings, THEMES, type PwaSettings, type Theme } from './settings.js';
import { fetchEbook, loadAbsConfig, parseItemId, saveAbsConfig } from './abs.js';
import { parseEpub } from './epub.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Screens
const inputScreen = $('input-screen');
const chapterScreen = $('chapter-screen');
const readerScreen = $('reader-screen');

// Input screen
const input = $<HTMLTextAreaElement>('input');
const readBtn = $<HTMLButtonElement>('read');
const absUrl = $<HTMLInputElement>('abs-url');
const absKey = $<HTMLInputElement>('abs-key');
const absItem = $<HTMLInputElement>('abs-item');
const absOpen = $<HTMLButtonElement>('abs-open');
const absStatus = $('abs-status');

// Chapter screen
const chapterBack = $<HTMLButtonElement>('chapter-back');
const bookTitle = $('book-title');
const chapterList = $<HTMLUListElement>('chapter-list');

// Reader screen
const backBtn = $<HTMLButtonElement>('back');
const themeSel = $<HTMLSelectElement>('theme');
const stage = $('stage');
const wordEl = $('word');
const scrub = $<HTMLInputElement>('scrub');
const positionEl = $('position');
const etaEl = $('eta');
const playpause = $<HTMLButtonElement>('playpause');
const restart = $<HTMLButtonElement>('restart');
const stepBack = $<HTMLButtonElement>('step-back');
const stepFwd = $<HTMLButtonElement>('step-fwd');
const wpm = $<HTMLInputElement>('wpm');
const wpmVal = $('wpm-val');
const chunk = $<HTMLInputElement>('chunk');
const chunkVal = $('chunk-val');

const settings: PwaSettings = loadSettings();
const engine = new RsvpEngine({ wpm: settings.wpm, chunkSize: settings.chunkSize });

// ---- engine subscriptions -------------------------------------------------

engine.on('tick', (s, t) => {
  renderWord(t);
  scrub.value = String(s.index);
  positionEl.textContent = `${s.index + 1} / ${s.total}`;
  etaEl.textContent = `${formatTime(remainingSeconds(s))} left`;
});
engine.on('state', (s) => syncControls(s));
engine.on('end', () => (playpause.textContent = '▶'));

function renderWord(token: Token | null): void {
  if (!token) {
    wordEl.replaceChildren(span('left', ''), span('pivot', ' '), span('right', ''));
    return;
  }
  const { text, orpIndex } = token;
  wordEl.replaceChildren(
    span('left', text.slice(0, orpIndex)),
    span('pivot', text.slice(orpIndex, orpIndex + 1) || ' '),
    span('right', text.slice(orpIndex + 1)),
  );
}

function syncControls(s: ReaderState): void {
  playpause.textContent = s.playing ? '⏸' : '▶';
  scrub.max = String(Math.max(0, s.total - 1));
  scrub.value = String(s.index);
  positionEl.textContent = `${s.total === 0 ? 0 : s.index + 1} / ${s.total}`;
  etaEl.textContent = `${formatTime(remainingSeconds(s))} left`;
  wpm.value = String(s.wpm);
  wpmVal.textContent = String(s.wpm);
  chunk.value = String(s.chunkSize);
  chunkVal.textContent = String(s.chunkSize);
}

// ---- screen switching -----------------------------------------------------

const screens = { input: inputScreen, chapters: chapterScreen, reader: readerScreen };
type ScreenName = keyof typeof screens;

// Where the reader's "‹ Text" button returns to (depends how we got here).
let readerReturn: ScreenName = 'input';

function setScreen(name: ScreenName): void {
  for (const el of Object.values(screens)) el.classList.remove('active');
  screens[name].classList.add('active');
}

function showReader(text: string, returnTo: ScreenName): void {
  readerReturn = returnTo;
  backBtn.textContent = returnTo === 'chapters' ? '‹ Chapters' : '‹ Text';
  engine.load(text);
  setScreen('reader');
}

// ---- input screen ---------------------------------------------------------

input.addEventListener('input', () => {
  readBtn.disabled = input.value.trim().length === 0;
});
readBtn.addEventListener('click', () => showReader(input.value, 'input'));
backBtn.addEventListener('click', () => {
  engine.pause();
  setScreen(readerReturn);
});

// ---- Audiobookshelf flow --------------------------------------------------

const absCfg = loadAbsConfig();
absUrl.value = absCfg.baseUrl;
absKey.value = absCfg.apiKey;

absOpen.addEventListener('click', () => void openFromAbs());

async function openFromAbs(): Promise<void> {
  const cfg = { baseUrl: absUrl.value.trim(), apiKey: absKey.value.trim() };
  saveAbsConfig(cfg);

  const itemId = parseItemId(absItem.value);
  if (!itemId) {
    setStatus('Enter a valid item URL or ID.', true);
    return;
  }

  setStatus('Fetching ebook…', false);
  absOpen.disabled = true;
  try {
    const bytes = await fetchEbook(cfg, itemId);
    setStatus('Parsing…', false);
    const book = await parseEpub(bytes);
    if (book.chapters.length === 0) {
      setStatus('No readable text found in this ebook.', true);
      return;
    }
    showChapters(book.title, book.chapters);
    setStatus('', false);
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    absOpen.disabled = false;
  }
}

function setStatus(msg: string, isError: boolean): void {
  absStatus.textContent = msg;
  absStatus.classList.toggle('error', isError);
}

// ---- chapter picker -------------------------------------------------------

function showChapters(title: string, chapters: { label: string; text: string; wordCount: number }[]): void {
  bookTitle.textContent = title;
  chapterList.replaceChildren(
    ...chapters.map((ch) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const label = document.createElement('span');
      label.textContent = ch.label;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${ch.wordCount.toLocaleString()} words`;
      btn.append(label, count);
      btn.addEventListener('click', () => showReader(ch.text, 'chapters'));
      li.appendChild(btn);
      return li;
    }),
  );
  setScreen('chapters');
}

chapterBack.addEventListener('click', () => setScreen('input'));

// ---- reader controls ------------------------------------------------------

stage.addEventListener('click', () => engine.toggle());
playpause.addEventListener('click', (e) => {
  e.stopPropagation();
  engine.toggle();
});
restart.addEventListener('click', (e) => stopAnd(e, () => engine.seek(0)));
stepBack.addEventListener('click', (e) => stopAnd(e, () => engine.step(-1)));
stepFwd.addEventListener('click', (e) => stopAnd(e, () => engine.step(1)));
scrub.addEventListener('input', () => engine.seek(Number(scrub.value)));

wpm.addEventListener('input', () => {
  engine.setWpm(Number(wpm.value));
  settings.wpm = Number(wpm.value);
  saveSettings(settings);
});
chunk.addEventListener('input', () => {
  engine.setChunkSize(Number(chunk.value));
  settings.chunkSize = Number(chunk.value);
  saveSettings(settings);
});

// Keyboard niceties for desktop use of the PWA.
document.addEventListener('keydown', (e) => {
  if (!readerScreen.classList.contains('active')) return;
  if (e.key === ' ') { e.preventDefault(); engine.toggle(); }
  else if (e.key === 'ArrowLeft') engine.step(-1);
  else if (e.key === 'ArrowRight') engine.step(1);
});

// ---- theme ----------------------------------------------------------------

for (const t of THEMES) {
  const opt = document.createElement('option');
  opt.value = t;
  opt.textContent = t[0].toUpperCase() + t.slice(1);
  themeSel.appendChild(opt);
}
themeSel.value = settings.theme;
themeSel.addEventListener('change', () => applyTheme(themeSel.value as Theme));

function applyTheme(theme: Theme): void {
  document.body.dataset.theme = theme;
  settings.theme = theme;
  saveSettings(settings);
}

// ---- helpers --------------------------------------------------------------

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function stopAnd(e: Event, fn: () => void): void {
  e.stopPropagation();
  fn();
}

function remainingSeconds(s: ReaderState): number {
  const tokensLeft = Math.max(0, s.total - 1 - s.index);
  if (tokensLeft === 0) return 0;
  const wordsLeft = tokensLeft * s.chunkSize;
  return wordsLeft / (s.wpm / 60);
}

function formatTime(secs: number): string {
  const total = Math.round(secs);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ---- init -----------------------------------------------------------------

applyTheme(settings.theme);
readBtn.disabled = input.value.trim().length === 0;
syncControls(engine.getState());
