# gread — Design Document

A Chrome/Edge (Manifest V3) browser extension that overlays an RSVP
("spreeder") speed-reader on any text the user highlights on a web page.

Status: **design / pre-build**. Target: Chromium browsers (Chrome, Edge) first.

---

## 1. Concept

RSVP = Rapid Serial Visual Presentation. Rather than the eye scanning across
lines, words are presented one at a time at a fixed screen location. This
removes saccades (eye-movement jumps) and reduces subvocalization, raising
effective reading speed.

User story:

> I highlight a paragraph on any web page, hit a hotkey (or right-click →
> "Speed-read selection"), and a full-screen overlay plays the text back to me
> word-by-word at my chosen WPM. I can pause, scrub, change speed, and dismiss
> with Esc.

---

## 2. Architecture overview

Two conceptual layers, kept deliberately separate so the hard part (the
reading engine) can be built and tested with zero browser dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│ Extension shell (Chromium MV3)                                 │
│                                                                │
│   service worker ──(message)──► content script                 │
│   (handles hotkey +            (reads selection, mounts UI,    │
│    context menu)                hosts the engine)              │
│                                       │                         │
│                                       ▼                         │
│                              ┌─────────────────┐               │
│                              │  Reader UI       │  Shadow DOM   │
│                              │  (overlay)       │  (style-      │
│                              └────────┬────────┘   isolated)   │
│                                       │                         │
│                              ┌────────▼────────┐               │
│                              │  RSVP engine     │  pure TS,     │
│                              │  (no DOM/browser)│  unit-tested  │
│                              └─────────────────┘               │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | Runs in | Responsibility |
|---|---|---|
| **RSVP engine** | pure module | Tokenize text, compute per-word timing + ORP, drive play/pause/seek via callbacks. No DOM. |
| **Reader UI** | content script (Shadow DOM) | Render the overlay, word display, controls; subscribe to engine events. |
| **Content script** | injected page | Capture `window.getSelection()`, mount/unmount the Reader UI overlay. |
| **Service worker** | background, event-driven | Register the hotkey (`chrome.commands`) and context-menu item; message the active tab's content script to start. |
| **Popup** | toolbar dropdown | Default settings: WPM, chunk size, theme. Writes to storage. |
| **Storage** | `chrome.storage.sync` | Persist user preferences across sessions/devices. |

---

## 3. The RSVP engine (the core product)

Built first, standalone, with unit tests. Plain TypeScript, no browser APIs.

### Tokenization
- Split selection into words on whitespace.
- Preserve trailing punctuation with its word (used for pause weighting).
- Optionally split very long words (hyphenate display for words > ~13 chars).

### Timing model
Base delay per word: `baseDelay = 60000 / wpm` (ms).
Multipliers applied on top of base:
- **Punctuation pause**: ., ! ? → longer; , ; : → moderately longer.
- **Long-word pause**: words above a length threshold get extra time.
- **Paragraph/newline pause**: brief reset between blocks.

### ORP (Optimal Recognition Point)
For each word, compute the pivot character index (roughly 30–35% into the
word) and render it in a contrasting color, horizontally pinned to a fixed
column. The eye locks to that column so no re-centering is needed between
words. This is the single biggest comfort/speed lever.

### Public interface (sketch)
```ts
interface ReaderState {
  index: number;        // current token
  total: number;
  playing: boolean;
  wpm: number;
  chunkSize: number;    // words shown at once (1 = classic RSVP)
}

class RsvpEngine {
  load(text: string): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(index: number): void;     // scrubbing
  step(delta: number): void;     // word back/forward
  setWpm(wpm: number): void;
  setChunkSize(n: number): void;
  on(event: 'tick' | 'state' | 'end', cb: (s: ReaderState, token: Token) => void): void;
}
```
The UI is a pure subscriber to `tick`/`state`/`end`. This boundary is what
keeps the engine browser-agnostic and testable.

---

## 4. Full-featured reader UI

Mounted inside a **Shadow DOM** root so the host page's CSS cannot bleed in
(and ours cannot leak out). Full-screen dimmed overlay.

Features (the "full-featured" scope chosen):
- Large ORP word display, pivot letter highlighted, pinned column.
- **Play / pause** (Space).
- **Rewind / step** word back & forward (← →), jump to start.
- **Scrubber / progress bar** showing position and % complete.
- **WPM control** (↑ ↓ or slider), live-applied.
- **Chunk size** (1–3 words at once).
- **Theme** (light / dark / sepia).
- **Esc** to close and restore the page.
- Word counter + estimated time remaining.

Keyboard map lives in the UI layer and calls engine methods.

---

## 5. Triggering (chosen: hotkey + context menu)

Selection alone cannot open extension UI, so launch is explicit:

1. **Keyboard shortcut** via `chrome.commands` (suggested default e.g.
   `Alt+R`; user-rebindable at `chrome://extensions/shortcuts`).
2. **Context menu** item "Speed-read selection", shown only when text is
   selected (`contexts: ["selection"]`).

Both paths do the same thing: service worker → `chrome.tabs.sendMessage(tabId,
{ type: 'START', text })`. For the context menu the selected text arrives in
the click info; for the hotkey the content script reads `getSelection()`
itself.

Fallback: if nothing is selected, show a small "select some text first" toast.

---

## 6. Data model — persisted settings

`chrome.storage.sync`:
```ts
interface Settings {
  wpm: number;          // default 300
  chunkSize: number;    // default 1
  theme: 'light' | 'dark' | 'sepia';
  orpEnabled: boolean;
  punctuationPause: boolean;
}
```

---

## 7. Proposed repo layout

```
gread/
  manifest.json
  src/
    engine/
      rsvp.ts            # the pure engine
      tokenize.ts
      orp.ts
      timing.ts
      rsvp.test.ts       # unit tests (run in Node)
    content/
      content.ts         # selection capture + mount overlay
      reader-ui.ts       # Shadow DOM overlay + controls
      reader.css
    background/
      service-worker.ts  # commands + context menu
    popup/
      popup.html
      popup.ts
    shared/
      settings.ts        # storage read/write, defaults
      messages.ts        # message type definitions
  public/icons/
  build config (Vite or esbuild)
```

Tooling: **TypeScript + Vite** (or esbuild) to bundle each entry point;
**Vitest** for engine unit tests. MV3 service workers + ES modules need a
bundler, so this is set up once up front.

---

## 8. Build milestones

1. **Standalone engine + harness** — `src/engine/*` plus a throwaway
   `index.html` with a textarea, so the reading *feel* (timing, ORP) is dialed
   in with no extension involved. Unit tests for tokenize/timing/ORP.
2. **Minimal extension wrap** — manifest, service worker context-menu trigger,
   content script that reads the selection and mounts a bare overlay running
   the engine.
3. **Full UI** — Shadow DOM overlay, all controls, keyboard map, scrubber.
4. **Settings + persistence** — popup, `chrome.storage.sync`, hotkey via
   `chrome.commands`.
5. **Polish** — themes, edge cases (huge selections, empty selection, PDFs,
   iframes), icons, store listing.

---

## 9. Open questions / risks

- **Iframes & restricted pages**: content scripts don't run on
  `chrome://`, the Web Store, or some embedded iframes. Acceptable for v1.
- **Very large selections**: cap or stream; decide a max word count.
- **Selection across complex DOM**: `getSelection().toString()` is usually
  fine but can include odd whitespace; tokenizer must normalize.
- **Distribution**: unpacked for dev; Chrome Web Store ($5 one-time dev
  registration) for release. Out of scope until it works.
```
