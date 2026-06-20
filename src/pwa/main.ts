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
import {
  decodeLocation,
  encodeLocation,
  fetchEbook,
  getBooks,
  isInProgress,
  loadAbsConfig,
  saveAbsConfig,
  saveProgress,
  type AbsBook,
} from './abs.js';
import { parseEpub, type Chapter } from './epub.js';
import { getCachedBook, putCachedBook } from './cache.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Screens
const inputScreen = $('input-screen');
const libraryScreen = $('library-screen');
const chapterScreen = $('chapter-screen');
const readerScreen = $('reader-screen');

// Input screen
const input = $<HTMLTextAreaElement>('input');
const readBtn = $<HTMLButtonElement>('read');
const absKey = $<HTMLInputElement>('abs-key');
const absConnect = $<HTMLButtonElement>('abs-connect');
const absStatus = $('abs-status');

// Library screen
const libraryBack = $<HTMLButtonElement>('library-back');
const libraryTitle = $('library-title');
const libraryStatus = $('library-status');
const bookSearch = $<HTMLInputElement>('book-search');
const bookList = $<HTMLUListElement>('book-list');

// Chapter screen
const chapterBack = $<HTMLButtonElement>('chapter-back');
const bookTitle = $('book-title');
const bookStats = $('book-stats');
const chapterList = $<HTMLUListElement>('chapter-list');

// Reader screen
const backBtn = $<HTMLButtonElement>('back');
const themeSel = $<HTMLSelectElement>('theme');
const nowReading = $('now-reading');
const nowTitle = $('now-title');
const nowSub = $('now-sub');
const stage = $('stage');
const wordEl = $('word');
const transition = $('transition');
const transitionDone = $('transition-done');
const upNext = $('up-next');
const nextTitle = $('next-title');
const continueBtn = $<HTMLButtonElement>('continue');
const scrub = $<HTMLInputElement>('scrub');
const positionEl = $('position');
const etaEl = $('eta');
const playpause = $<HTMLButtonElement>('playpause');
const restart = $<HTMLButtonElement>('restart');
const stepBack = $<HTMLButtonElement>('step-back');
const stepFwd = $<HTMLButtonElement>('step-fwd');
const skipEnd = $<HTMLButtonElement>('skip-end');
const wpmVal = $('wpm-val');
const wpmDown = $<HTMLButtonElement>('wpm-down');
const wpmUp = $<HTMLButtonElement>('wpm-up');
const wpmValue = $<HTMLButtonElement>('wpm-value');
const wpmSheet = $('wpm-sheet');
const wpmBackdrop = $('wpm-backdrop');
const wpmSlider = $<HTMLInputElement>('wpm-slider');
const wpmSheetVal = $('wpm-sheet-val');
const WPM_STEP = 25;
const WPM_MIN = 100;
const WPM_MAX = 1000;

const settings: PwaSettings = loadSettings();
// Chunk size is fixed at 1 (one word per flash); the option was removed.
const engine = new RsvpEngine({ wpm: settings.wpm, chunkSize: 1 });

// ---- engine subscriptions -------------------------------------------------

engine.on('tick', (s, t) => {
  renderWord(t);
  scrub.value = String(s.index);
  positionEl.textContent = `${s.index + 1} / ${s.total}`;
  etaEl.textContent = `${formatTime(remainingSeconds(s))} left`;
  if (s.playing) persist(); // throttled checkpoint while reading
});

let wasPlaying = false;
engine.on('state', (s) => {
  syncControls(s);
  // Fade the transport/WPM controls out while playing (only useful when paused).
  document.body.classList.toggle('playing', s.playing);
  if (wasPlaying && !s.playing) persist({ force: true }); // pause / chapter end
  wasPlaying = s.playing;
});

engine.on('end', () => {
  playpause.textContent = '▶';
  if (!session) return;
  if (session.index < session.chapters.length - 1) showChapterTransition();
  else {
    persist({ force: true, finished: true });
    showEndOfBook();
  }
});

// Flush on teardown — critical on mobile where the app gets backgrounded/closed
// without a clean pause. keepalive lets the request outlive the page.
window.addEventListener('pagehide', () => persist({ force: true, keepalive: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist({ force: true, keepalive: true });
});

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
  renderWpm(s.wpm);
}

// ---- screen switching -----------------------------------------------------

const screens = {
  input: inputScreen,
  library: libraryScreen,
  chapters: chapterScreen,
  reader: readerScreen,
};
type ScreenName = keyof typeof screens;

// Where the reader's back button returns to (depends how we got here).
let readerReturn: ScreenName = 'input';

function setScreen(name: ScreenName): void {
  for (const el of Object.values(screens)) el.classList.remove('active');
  screens[name].classList.add('active');
}

// ---- reading session ------------------------------------------------------
// A book opened from the library carries its whole chapter list so the reader
// can show "now reading" context and auto-advance between chapters. Pasted text
// has no session (session = null) — no header, no auto-advance.

interface Session {
  itemId: string;
  bookTitle: string;
  author: string;
  chapters: Chapter[];
  index: number;
}
let session: Session | null = null;

// Seconds the transition card lingers before auto-starting the next chapter.
const AUTO_ADVANCE_MS = 4000;
let advanceTimer: number | undefined;

function clearAdvance(): void {
  if (advanceTimer !== undefined) {
    clearTimeout(advanceTimer);
    advanceTimer = undefined;
  }
}

function hideTransition(): void {
  clearAdvance();
  transition.classList.remove('active');
}

function updateNowReading(): void {
  if (!session) {
    nowReading.classList.add('hidden');
    return;
  }
  nowReading.classList.remove('hidden');
  nowTitle.textContent = session.bookTitle;
  const ch = session.chapters[session.index];
  nowSub.textContent = [session.author, ch?.label].filter(Boolean).join(' · ');
}

// ---- server-side progress sync --------------------------------------------

// Don't write on every word; cap to one save per interval while reading.
const SAVE_THROTTLE_MS = 5000;
let lastSaved = 0;

/** Whole-book reading fraction (finished chapters + current word) / total. */
function bookFraction(): number {
  if (!session) return 0;
  const { chapters, index } = session;
  const before = chapters.slice(0, index).reduce((s, c) => s + c.wordCount, 0);
  const total = chapters.reduce((s, c) => s + c.wordCount, 0) || 1;
  return Math.min(1, (before + engine.getState().index) / total);
}

/**
 * Persist the current spot to ABS. Throttled unless `force`. `keepalive` is for
 * page/app teardown. Only saves real reading positions (reader on screen).
 */
function persist(opts: { force?: boolean; keepalive?: boolean; finished?: boolean } = {}): void {
  if (!session || !absCfg.apiKey) return;
  if (!readerScreen.classList.contains('active')) return;
  const now = Date.now();
  if (!opts.force && now - lastSaved < SAVE_THROTTLE_MS) return;
  lastSaved = now;

  const ebookLocation = encodeLocation(session.index, engine.getState().index);
  const ebookProgress = opts.finished ? 1 : bookFraction();
  saveProgress(
    absCfg,
    session.itemId,
    { ebookLocation, ebookProgress, ...(opts.finished ? { isFinished: true } : {}) },
    { keepalive: opts.keepalive },
  ).catch((e) => console.warn('[gread] save progress failed:', e));
}

/** Resolve where to start a freshly opened book from its saved progress. */
function resolveStart(book: AbsBook, chapters: Chapter[]): { chapterIndex: number; wordIndex: number } | null {
  const exact = decodeLocation(book.ebookLocation);
  if (exact) {
    const chapterIndex = Math.min(Math.max(0, exact.chapterIndex), chapters.length - 1);
    return { chapterIndex, wordIndex: Math.max(0, exact.wordIndex) };
  }
  const frac = book.progress ?? 0;
  if (frac > 0 && frac < 1) return fractionToPosition(frac, chapters);
  return null;
}

function fractionToPosition(frac: number, chapters: Chapter[]): { chapterIndex: number; wordIndex: number } {
  const total = chapters.reduce((s, c) => s + c.wordCount, 0);
  let target = Math.floor(frac * total);
  for (let i = 0; i < chapters.length; i++) {
    if (target < chapters[i].wordCount || i === chapters.length - 1) {
      return { chapterIndex: i, wordIndex: Math.max(0, Math.min(target, chapters[i].wordCount - 1)) };
    }
    target -= chapters[i].wordCount;
  }
  return { chapterIndex: 0, wordIndex: 0 };
}

/** Open a chapter by index in the reader, optionally starting playback. */
function playChapter(index: number, autoPlay: boolean): void {
  if (!session) return;
  session.index = index;
  hideTransition();
  updateNowReading();
  readerReturn = 'chapters';
  engine.load(session.chapters[index].text);
  setScreen('reader');
  if (autoPlay) engine.play();
}

/** Show pasted text in the reader (no book/chapter context). */
function showText(text: string): void {
  session = null;
  hideTransition();
  updateNowReading();
  readerReturn = 'input';
  engine.load(text);
  setScreen('reader');
}

/** Chapter finished and another follows: announce it and auto-advance. */
function showChapterTransition(): void {
  if (!session) return;
  const next = session.chapters[session.index + 1];
  transitionDone.textContent = '✓ Chapter complete';
  nextTitle.textContent = next.label;
  upNext.style.display = '';
  continueBtn.style.display = '';
  transition.classList.add('active');
  clearAdvance();
  advanceTimer = window.setTimeout(continueNow, AUTO_ADVANCE_MS);
}

/** Start the next chapter now (timer fired or user tapped Continue). */
function continueNow(): void {
  if (!session) return;
  playChapter(session.index + 1, true);
}

/** Last chapter finished: a terminal card, no auto-advance. */
function showEndOfBook(): void {
  clearAdvance();
  transitionDone.textContent = '✓ End of book';
  upNext.style.display = 'none';
  continueBtn.style.display = 'none';
  transition.classList.add('active');
}

continueBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  continueNow();
});

// ---- input screen ---------------------------------------------------------

input.addEventListener('input', () => {
  readBtn.disabled = input.value.trim().length === 0;
});
readBtn.addEventListener('click', () => showText(input.value));
backBtn.addEventListener('click', () => {
  engine.pause();
  hideTransition();
  closeWpmSheet();
  setScreen(readerReturn);
});

// ---- Audiobookshelf flow --------------------------------------------------

const absCfg = loadAbsConfig();
absKey.value = absCfg.apiKey;

absConnect.addEventListener('click', () => void connectAbs());
libraryBack.addEventListener('click', () => setScreen('input'));

// Full library kept in memory so the search box can filter without refetching.
let libBooks: AbsBook[] = [];
let libName = '';

bookSearch.addEventListener('input', () => {
  const q = bookSearch.value.trim().toLowerCase();
  const matches = q
    ? libBooks.filter(
        (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q),
      )
    : libBooks;
  renderLibrary(libName, matches);
  setStatus(libraryStatus, q && matches.length === 0 ? 'No matches.' : '', false);
});

async function connectAbs(): Promise<void> {
  absCfg.apiKey = absKey.value.trim();
  saveAbsConfig(absCfg);
  if (!absCfg.apiKey) {
    setStatus(absStatus, 'Enter your API key first.', true);
    return;
  }
  setStatus(absStatus, 'Loading library…', false);
  absConnect.disabled = true;
  try {
    const { libraryName, books } = await getBooks(absCfg);
    libBooks = books;
    libName = libraryName;
    bookSearch.value = '';
    renderLibrary(libraryName, books);
    setStatus(absStatus, '', false);
    setScreen('library');
  } catch (e) {
    setStatus(absStatus, (e as Error).message, true);
  } finally {
    absConnect.disabled = false;
  }
}

async function openBook(book: AbsBook): Promise<void> {
  setStatus(libraryStatus, `Opening “${book.title}”…`, false);
  try {
    // Cached text (this device)? Open instantly, no download.
    let cached = await getCachedBook(book.id);
    if (!cached) {
      const bytes = await fetchEbook(absCfg, book.id, (loaded, total) => {
        setStatus(
          libraryStatus,
          total
            ? `Downloading ${Math.round((loaded / total) * 100)}%… (one-time)`
            : `Downloading ${(loaded / 1e6).toFixed(0)} MB… (one-time)`,
          false,
        );
      });
      setStatus(libraryStatus, 'Processing…', false);
      const parsed = await parseEpub(bytes);
      cached = { itemId: book.id, title: parsed.title, chapters: parsed.chapters, cachedAt: Date.now() };
      void putCachedBook(cached);
    }
    if (cached.chapters.length === 0) {
      setStatus(libraryStatus, 'No readable text found in this ebook.', true);
      return;
    }
    setStatus(libraryStatus, '', false);
    const chapters = cached.chapters;
    showChapters(book.id, cached.title || book.title, book.author, chapters);
    // Jump straight to the saved spot (paused) if there is one.
    const start = resolveStart(book, chapters);
    if (start) {
      playChapter(start.chapterIndex, false);
      engine.seek(start.wordIndex);
    }
  } catch (e) {
    setStatus(libraryStatus, (e as Error).message, true);
  }
}

// ---- library rendering ----------------------------------------------------

function renderLibrary(libraryName: string, books: AbsBook[]): void {
  libraryTitle.textContent = libraryName;
  const inProgress = books.filter(isInProgress);
  const rest = books.filter((b) => !isInProgress(b));

  const frag = document.createDocumentFragment();
  if (inProgress.length > 0) {
    frag.append(sectionLabel('Continue Reading'), ...inProgress.map(bookItem));
    if (rest.length > 0) frag.append(sectionLabel('All Books'));
  }
  frag.append(...rest.map(bookItem));
  bookList.replaceChildren(frag);
}

function bookItem(book: AbsBook): HTMLLIElement {
  const li = document.createElement('li');
  const btn = document.createElement('button');

  const col = document.createElement('div');
  col.className = 'col';
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  ttl.textContent = book.title;
  col.appendChild(ttl);
  if (book.author) {
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = book.author;
    col.appendChild(author);
  }
  btn.appendChild(col);

  const badge = document.createElement('span');
  badge.className = 'badge';
  if (isInProgress(book)) badge.textContent = `${Math.round((book.progress ?? 0) * 100)}%`;
  else if (book.isFinished) badge.textContent = '✓';
  btn.appendChild(badge);

  btn.addEventListener('click', () => void openBook(book));
  li.appendChild(btn);
  return li;
}

function sectionLabel(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'section-label';
  li.textContent = text;
  return li;
}

function setStatus(el: HTMLElement, msg: string, isError: boolean): void {
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---- chapter picker -------------------------------------------------------

function showChapters(itemId: string, title: string, author: string, chapters: Chapter[]): void {
  session = { itemId, bookTitle: title, author, chapters, index: 0 };
  bookTitle.textContent = title;
  updateBookStats();
  chapterList.replaceChildren(
    ...chapters.map((ch, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const label = document.createElement('span');
      label.textContent = ch.label;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${ch.wordCount.toLocaleString()} words`;
      btn.append(label, count);
      btn.addEventListener('click', () => playChapter(i, false));
      li.appendChild(btn);
      return li;
    }),
  );
  setScreen('chapters');
}

/** Total words + estimated read time for the whole book at the current WPM. */
function updateBookStats(): void {
  if (!session) return;
  const totalWords = session.chapters.reduce((s, c) => s + c.wordCount, 0);
  const wpm = engine.getState().wpm;
  const secs = (totalWords / wpm) * 60;
  bookStats.textContent = `${totalWords.toLocaleString()} words · ~${formatDuration(secs)} at ${wpm} wpm`;
}

chapterBack.addEventListener('click', () => setScreen('library'));

// ---- reader controls ------------------------------------------------------

// Stage taps: single tap toggles play/pause; double tap on the left/right third
// adjusts WPM (left −, right +), center double tap does nothing. The toggle is
// briefly deferred so a double tap doesn't also flip play state — this means a
// double tap to change speed never interrupts reading.
const DOUBLE_TAP_MS = 250;
let lastTapAt = 0;
let singleTapTimer: number | undefined;

stage.addEventListener('click', (e) => {
  // While the transition card is up, a tap means "start the next chapter now"
  // (unless it's the terminal end-of-book card, which has no Continue button).
  if (transition.classList.contains('active')) {
    if (continueBtn.style.display !== 'none') continueNow();
    return;
  }

  const now = Date.now();
  if (now - lastTapAt < DOUBLE_TAP_MS) {
    // Second tap → double tap: cancel the pending toggle and adjust WPM by side.
    lastTapAt = 0;
    if (singleTapTimer !== undefined) {
      clearTimeout(singleTapTimer);
      singleTapTimer = undefined;
    }
    const zone = e.clientX / window.innerWidth;
    if (zone < 0.34) setWpm(engine.getState().wpm - WPM_STEP);
    else if (zone > 0.66) setWpm(engine.getState().wpm + WPM_STEP);
    // center: no effect
    return;
  }

  // First tap → defer the toggle long enough to see if a second tap follows.
  lastTapAt = now;
  if (singleTapTimer !== undefined) clearTimeout(singleTapTimer);
  singleTapTimer = window.setTimeout(() => {
    singleTapTimer = undefined;
    engine.toggle();
  }, DOUBLE_TAP_MS);
});
playpause.addEventListener('click', (e) => {
  e.stopPropagation();
  engine.toggle();
});
restart.addEventListener('click', (e) => stopAnd(e, skipToChapterStart));
skipEnd.addEventListener('click', (e) => stopAnd(e, skipToChapterEnd));
// Step buttons repeat (and accelerate) while held, so you can scrub words.
holdRepeat(stepBack, () => engine.step(-1));
holdRepeat(stepFwd, () => engine.step(1));

/**
 * Fire `fn` on press, then auto-repeat while held, accelerating the longer it's
 * held. Used for the step and WPM buttons (hold to rewind / ramp speed).
 */
function holdRepeat(btn: HTMLButtonElement, fn: () => void): void {
  let timer: number | undefined;
  let interval = 220;
  const repeat = (): void => {
    fn();
    interval = Math.max(40, interval - 25); // speed up as it's held
    timer = window.setTimeout(repeat, interval);
  };
  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stop();
    interval = 220;
    fn(); // immediate first action
    timer = window.setTimeout(repeat, 400); // grace period before auto-repeat
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    btn.addEventListener(ev, stop);
  }
}

// At the chapter's start, ⏮ jumps to the previous chapter; at the end, ⏭ jumps
// to the next. Chapter jumps preserve play state and land at the chapter start.
function skipToChapterStart(): void {
  if (engine.getState().index > 0) engine.seek(0);
  else if (session && session.index > 0) gotoChapter(session.index - 1);
}

function skipToChapterEnd(): void {
  const s = engine.getState();
  if (s.index < s.total - 1) engine.seek(s.total - 1);
  else if (session && session.index < session.chapters.length - 1) gotoChapter(session.index + 1);
}

function gotoChapter(index: number): void {
  playChapter(index, engine.getState().playing);
}
scrub.addEventListener('input', () => engine.seek(Number(scrub.value)));

holdRepeat(wpmDown, () => setWpm(engine.getState().wpm - WPM_STEP));
holdRepeat(wpmUp, () => setWpm(engine.getState().wpm + WPM_STEP));

// Tapping the WPM number raises a slider popover (closed by tapping the backdrop).
wpmValue.addEventListener('click', (e) => {
  e.stopPropagation();
  wpmSheet.classList.add('open');
  wpmBackdrop.classList.add('open');
});
wpmBackdrop.addEventListener('click', closeWpmSheet);
wpmSlider.addEventListener('input', () => setWpm(Number(wpmSlider.value)));

function closeWpmSheet(): void {
  wpmSheet.classList.remove('open');
  wpmBackdrop.classList.remove('open');
}

function setWpm(value: number): void {
  const clamped = Math.min(WPM_MAX, Math.max(WPM_MIN, value));
  engine.setWpm(clamped); // emits 'state' → syncControls → renderWpm
  settings.wpm = clamped;
  saveSettings(settings);
  updateBookStats(); // keep the chapter-screen estimate in sync with WPM
}

/** Reflect the current WPM in the number, the popover value, and the slider. */
function renderWpm(v: number): void {
  const s = String(v);
  wpmVal.textContent = s;
  wpmSheetVal.textContent = s;
  if (wpmSlider.value !== s) wpmSlider.value = s;
}

// Keyboard niceties for desktop use of the PWA.
document.addEventListener('keydown', (e) => {
  if (!readerScreen.classList.contains('active')) return;
  if (transition.classList.contains('active')) {
    if (e.key === ' ' && continueBtn.style.display !== 'none') {
      e.preventDefault();
      continueNow();
    }
    return;
  }
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

/** Coarse "5h 18m" / "47m" duration for whole-book estimates. */
function formatDuration(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---- init -----------------------------------------------------------------

applyTheme(settings.theme);
readBtn.disabled = input.value.trim().length === 0;
updateNowReading();
syncControls(engine.getState());
