# gread PWA — Design Document

A Progressive Web App (PWA) that brings gread's RSVP speed-reader to mobile
and desktop, with Audiobookshelf (ABS) as the primary content source. Reuses
`src/engine/` unchanged; adds a new front-end alongside the existing
Chrome/Edge extension.

Status: **design / pre-build**.  
Target: installable PWA on iPhone (iOS Safari) primarily; also desktop.

---

## 1. Goal & scope

### What it is

A standalone web app — served from the user's own HTTPS host, ideally on the
same origin as their self-hosted Audiobookshelf server — that lets a user:

1. Connect to their Audiobookshelf library (server URL + API key, stored once).
2. Browse ABS libraries and items; fetch an epub from the server.
3. Pick a chapter from the epub's table of contents.
4. RSVP-read that chapter at their chosen WPM, using the same engine that
   powers the extension.
5. Sync reading progress back to ABS so position is shared across devices and
   with ABS's own reader.
6. Install it to the home screen so it behaves like a native app (no browser
   chrome, offline-capable after first load).

Local `.epub` file open is a secondary/fallback path for use without ABS.

### What it is NOT

- It does **not** overlay arbitrary web pages — that is the extension's job.
  The PWA cannot inject into other origins; it only reads content the user
  explicitly opens inside it.
- It is not an epub *viewer* in the visual sense (no paginated layout, no
  images). It is a text extractor + RSVP reader.
- It does not support DRM-protected epubs. epub.js cannot decrypt Adobe/Kobo
  DRM. This is called out explicitly in §8.
- It does **not** augment the ABS web UI in-place — that is the extension's
  job on desktop. The PWA is a standalone reader that draws its content *from*
  ABS; it does not modify the ABS interface.

---

## 2. Architecture

### Mental model: two front-ends, one engine

```
gread/
  src/engine/          ← shared, pure TypeScript, zero DOM
  src/content/         ← extension front-end (Shadow DOM overlay)
  src/pwa/             ← PWA front-end (new)
```

`src/engine/` is imported directly by both front-ends. No package boundary is
needed — keeping everything in one repo is the lowest-friction option (see
§2.1).

### Contrasting the two front-ends

| | Extension | PWA |
|---|---|---|
| **Primary use case** | Speed-read in-place inside the ABS web reader (or any web page) on desktop | Standalone RSVP reader backed by the ABS library, on any device |
| **Content source** | Whatever text is selected on the current web page | ABS library (primary); local file (fallback) |
| **Device** | Desktop (Chromium) | iPhone, desktop |
| **ABS integration** | Reads text already rendered by ABS's own reader | Fetches epub bytes from ABS API directly |
| **Progress sync** | N/A (stateless) | Reads/writes ABS progress endpoint |
| **Shared** | `src/engine/` | `src/engine/` |

Progress sync is the key tie between them: when the user reads a chapter in the
PWA and closes it, ABS records the position; opening ABS's own reader (or the
extension on desktop) on another device picks up from the same spot.

### Component diagram

```
┌─────────────────────────────────────────────────────────┐
│  PWA (browser tab / installed home-screen app)           │
│                                                          │
│  ┌──────────────────────┐   ┌────────────────────────┐  │
│  │  Library screen       │   │  Reader screen          │  │
│  │  (ABS item browser +  │──▶│  (ORP word display +   │  │
│  │   chapter picker)     │   │   controls panel)       │  │
│  └──────────────────────┘   └──────────┬─────────────┘  │
│                                         │                 │
│  ┌──────────────────────┐               │                 │
│  │  AbsClient            │               │                 │
│  │  ABS REST API wrapper │               │                 │
│  │  (libraries, items,   │               │                 │
│  │   epub fetch,         │               │                 │
│  │   progress r/w)       │               │                 │
│  └──────────────────────┘               │                 │
│                                         │                 │
│  ┌──────────────────────┐               │                 │
│  │  EpubLoader           │               │                 │
│  │  (epub.js wrapper)    │               │                 │
│  │  ArrayBuffer →        │───────────────▼                │
│  │  chapter text         │   ┌──────────────────────┐     │
│  └──────────────────────┘   │  RSVP engine          │     │
│                              │  src/engine/rsvp.ts   │     │
│                              │  (pure TS, no DOM)    │     │
│                              └──────────────────────┘     │
│                                                            │
│  ┌──────────────────────────────────────────────────┐     │
│  │  Service Worker (Workbox / hand-rolled)           │     │
│  │  Caches app shell + assets for offline use        │     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### 2.1 Monorepo layout decision

**Recommendation: stay in one repo, add `src/pwa/`.**

Alternatives considered:

| Option | Pros | Cons |
|---|---|---|
| One repo, `src/pwa/` alongside `src/content/` | Zero setup; engine imports work as-is; one `tsconfig`, one `vitest` run. | `dist/` needs two build outputs; slight manifest.json collision risk (already solved: extension uses `build:ext`, PWA uses Vite's default build). |
| Separate `packages/engine` (npm workspaces) | Clean package boundary; engine could be published. | Extra tooling; overkill while both front-ends are in active co-development. |
| Separate repo | Total isolation. | Duplicates or externalises engine; breaks "one change fixes both front-ends." |

The single-repo approach requires only minor Vite config changes (§6).

---

## 3. Audiobookshelf integration

### 3.1 Hosting and CORS

ABS is self-hosted behind the user's own reverse proxy with a real HTTPS cert.
The primary CORS solution is: **serve the PWA on the same origin as ABS**
(e.g. `https://abs.domain.com/gread/`). Same-origin requests have no CORS
restrictions — the simplest and most reliable path.

Secondary option: add CORS headers (`Access-Control-Allow-Origin`,
`Access-Control-Allow-Headers`) at the reverse proxy (nginx/Caddy) for the
`/api/` path. This covers the case where the PWA is hosted separately.

Do **not** rely on ABS's built-in `ALLOW_CORS` flag. It is incomplete and
buggy (GitHub issues #4497 and #4784) and has broken in past ABS releases.

### 3.2 Authentication

ABS supports API keys (see https://www.audiobookshelf.org/guides/api-keys/).
The API key is sent with every request as:

```
Authorization: Bearer <key>
```

The PWA stores the ABS server URL and API key in `localStorage` (entered once
in a settings screen). See §8 for the security caveat on this approach.

### 3.3 Library browsing

List available libraries:

```
GET /api/libraries
```

List items in a library (paginated; use `limit` and `page` params):

```
GET /api/libraries/{libraryId}/items
```

Filter to epub items by checking each item's media metadata for an epub file
(see §8 — the exact field name for distinguishing epub vs. audio-only items
must be confirmed against a running ABS instance).

### 3.4 Fetching an epub

ABS has a built-in ereader that serves epub bytes to the browser, so the
endpoint exists. The public API docs are marked as out-of-date; the exact
ebook-download URL must be confirmed against the running server (check ABS
network traffic in DevTools while using its built-in ereader). One likely
candidate:

```
GET /api/items/{itemId}/ebook
```

The response is the raw epub binary (application/epub+zip). Fetch it as an
`ArrayBuffer`:

```ts
const res = await fetch(`${absUrl}/api/items/${itemId}/ebook`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const buffer = await res.arrayBuffer();
const book = ePub(buffer);   // epub.js accepts an ArrayBuffer directly
```

This eliminates any need for local file handles or File System Access API on
iOS. The library lives on the ABS server; only the server URL and API key are
stored locally.

### 3.5 Reading-position sync

ABS exposes progress endpoints under `/api/me/progress/{itemId}`. The PWA
uses these to resume reading across devices and to stay in sync with ABS's own
reader.

**On open:** read current progress and seek to the matching position.

**On pause / close:** write progress back.

```ts
// Read
GET /api/me/progress/{itemId}
// Response includes a progress fraction and/or epubcfi

// Write
PATCH /api/me/progress/{itemId}
// Body: { progress: 0.42, ... }   ← fraction is easy; epubcfi is future work
```

**Mapping caveat:** gread tracks position as a word/token index within a
chapter. Mapping to ABS's progress fraction is straightforward (tokens read /
total tokens). Mapping to an exact `epubcfi` string requires parsing the epub
spine structure — treat this as a later refinement. For v1, write a fractional
progress value; resume to the nearest chapter boundary.

---

## 4. Epub flow

### 4.1 Opening from ABS (primary path)

See §3.4. `epub.js` receives the `ArrayBuffer` returned by the ABS API fetch.
No file picker or local storage is involved.

### 4.2 Opening a local file (secondary / fallback path)

For use without ABS. On iOS Safari, `showOpenFilePicker` is not available;
use `<input type="file" accept=".epub">` instead.

```ts
// Desktop / Android Chrome
const [handle] = await window.showOpenFilePicker({ types: [{
  description: 'Epub files',
  accept: { 'application/epub+zip': ['.epub'] },
}]});
const file = await handle.getFile();
const buffer = await file.arrayBuffer();
const book = ePub(buffer);

// iOS Safari fallback
<input type="file" accept=".epub" onChange={onFileChange} />
// onFileChange: read file.arrayBuffer(), pass to ePub()
```

### 4.3 Extracting the table of contents

```ts
await book.ready;
const toc = book.navigation.toc;  // Array of NavItem { label, href, subitems }
```

Render `toc` as a chapter-picker list. `subitems` provides nested sections
(parts within chapters); whether to flatten or show hierarchy is a UI choice.

### 4.4 Getting raw chapter text

epub.js's primary API renders chapters into an `<iframe>` for visual reading.
For RSVP we want the raw text of a section, not the rendered layout.

**Approach: load section as a document and walk its text nodes.**

```ts
const section = book.spine.get(tocItem.href);
await section.load(book.load.bind(book));       // loads raw XHTML into memory
const doc: Document = section.document;         // parsed XML/HTML document
const text = doc.body?.innerText               // strips tags
           ?? doc.body?.textContent ?? '';
```

Alternatively, use `section.render()` which returns an HTML string — parse it
with `new DOMParser().parseFromString(html, 'text/html')` and extract
`body.innerText`. Both avoid mounting an iframe.

The resulting string is passed directly to `engine.load(text)`.

### 4.5 Known epub.js gotchas

| Issue | Mitigation |
|---|---|
| `section.document` may be `null` until `.load()` resolves — await it. | Always `await section.load(...)` before accessing `.document`. |
| epub.js expects `book.load` to be bound when passed as the loader arg. | Use `.bind(book)` as shown above. |
| Some epubs use `<br/>` instead of paragraph breaks; `innerText` collapses them. | Pre-process: replace `<br>` → `\n` on the raw HTML before parsing. |
| EPUB 3 epubs may embed MathML or SVG inside body; `innerText` silently skips non-text nodes. | Acceptable for v1; display a "chapter may contain non-text content" notice. |
| Very large chapters (>50k words) produce large token arrays. | Cap at ~20k tokens with a warning; or split at sentence boundaries and offer "continue" between segments (future). |
| DRM-protected epubs (Adobe/Kobo LCP) are encrypted zip entries — epub.js cannot open them. | Show a clear error: "This epub is DRM-protected and cannot be opened." No workaround exists in-browser. |
| epub.js v0.3.x (npm) has a known memory leak when calling `book.destroy()` — always call it when leaving the library screen. | Call `book.destroy()` on screen unmount. |

---

## 5. UI

### 5.1 Screen map

```
┌─────────────────────────┐
│  Settings screen         │  (first launch, or via gear icon)
│  ABS server URL          │
│  API key                 │
│  [Save & connect]        │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  Library screen          │  (home after setup)
│  ABS item list           │
│  [Local file fallback]   │
│  ┌──────────────────┐   │
│  │ "My Book"         │──▶│  Chapter picker (inline or bottom sheet)
│  │ ch 1, ch 2 ...    │   │
│  └──────────────────┘   │
└─────────────┬───────────┘
              │  user picks chapter
              ▼
┌─────────────────────────┐
│  Reader screen           │
│  [large ORP word display]│
│  [progress bar / scrub]  │
│  [play | ◀ ▶ | WPM | ×] │
└─────────────────────────┘
```

### 5.2 Reader screen

Reuse the visual design from `content.ts` (ORP 3-part grid, pivot color, guide
lines above/below). Adapt for mobile:

- Word display: `clamp(2.5rem, 8vw, 4rem)` — slightly smaller than the desktop
  overlay to leave room for controls below.
- Controls panel sits below the word display, always visible (no hover needed).
- ORP grid column: `min(520px, 90vw)`.

**Touch controls:**

| Gesture / element | Action |
|---|---|
| Tap the word area | Play / pause (toggle) |
| Large ▶/⏸ button (min 48 × 48 px) | Play / pause |
| ◀ / ▶ step buttons (min 44 × 44 px) | Step one token back / forward |
| Scrubber (native `<input type=range>`) | Seek |
| WPM +/− buttons (or slider) | ±25 WPM |
| ✕ / back | Return to library screen (triggers progress sync write) |

Swipe gestures are deliberately left out of v1 to avoid conflicting with native
scroll. Revisit if users request them.

### 5.3 Library screen

- ABS item list (paginated; search/filter by title).
- "Open local file" secondary button for the fallback path.
- Tapping an item fetches the epub from ABS, shows its table of contents inline
  (or in a bottom sheet on mobile). Tapping a chapter loads → reader screen.
- If ABS reports existing progress for an item, show a "Resume at X%" badge.

### 5.4 Theme

Carry over the three CSS-variable themes from the extension (dark / light /
sepia). Respect `prefers-color-scheme` as the default; user can override.
Store the choice in `localStorage`.

---

## 6. PWA mechanics

### 6.1 Web App Manifest

`public/manifest.webmanifest`:

```json
{
  "name": "gread",
  "short_name": "gread",
  "description": "RSVP speed-reader for epubs",
  "start_url": "/gread/",
  "display": "standalone",
  "background_color": "#08090c",
  "theme_color": "#08090c",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png",
      "purpose": "any maskable" },
    { "src": "icons/apple-touch-icon.png", "sizes": "180x180", "type": "image/png" }
  ]
}
```

Notes:
- `start_url` reflects the likely same-origin subpath deployment
  (`/gread/`). Adjust if deployed at the root.
- No `share_target`: iOS PWAs cannot receive shares, and the ABS-first design
  makes share-target unnecessary.
- iOS requires `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">`
  in `<head>` and `<meta name="apple-mobile-web-app-capable" content="yes">`.
  The manifest `icons` entry alone is not picked up by iOS Safari.

`display: standalone` hides the browser address bar when installed. Use
`display_override: ["window-controls-overlay"]` later if desired on desktop.

### 6.2 Service worker

Strategy: **cache-first for the app shell** (HTML, JS, CSS, icons),
network-only for all ABS API calls (never cache authenticated API responses).

Recommended: use **Workbox** via `vite-plugin-pwa`. It auto-generates the
service worker and precache manifest from the Vite build output, requiring
minimal manual cache logic.

Minimal manual alternative (if avoiding the plugin):

```ts
// sw.ts
const CACHE = 'gread-v1';
const SHELL = ['/', '/index.html', '/assets/index.js', '/assets/index.css'];

self.addEventListener('install', (e: ExtendableEvent) =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));

self.addEventListener('fetch', (e: FetchEvent) => {
  // Pass ABS API calls straight through — never cache authenticated requests.
  if (e.request.url.includes('/api/')) { return; }
  e.respondWith(caches.match(e.request).then(r => r ?? fetch(e.request)));
});
```

Update strategy: on `activate`, delete old cache versions.

### 6.3 iOS install UX

iOS requires the user to manually tap "Add to Home Screen" from the Safari
share sheet — there is no install prompt API on iOS. Show a first-visit
dismissible banner with instructions: "Open in Safari → Share → Add to Home
Screen."

Other iOS notes:
- **`showOpenFilePicker`**: not supported on iOS Safari; use `<input type="file">`.
- **Service worker scope**: iOS Safari 16.4+ supports service workers; 16.3
  and below do not. Offline install (for the app shell) works on 16.4+.
- **Storage quota**: iOS may purge PWA storage after extended non-use. Cache
  only the app shell. The ABS library lives on the server; nothing
  epub-content-sized is stored locally.
- **Separate browsing context**: installed PWAs on iOS run in a context isolated
  from Safari. Cookies/sessions from ABS open in Safari are not shared. The API
  key in `localStorage` is the auth mechanism — no Safari session is needed.

---

## 7. Build & tooling

### 7.1 Vite config changes

Add a second build target for the PWA. The extension build is unchanged
(still `build:ext` via esbuild). Vite's default build now produces the PWA.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  root: '.',
  build: {
    rollupOptions: {
      input: { app: 'src/pwa/index.html' },
    },
    outDir: 'dist-pwa',
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,            // We maintain manifest.webmanifest manually
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg}'] },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
```

New npm scripts:

```json
"dev:pwa":   "vite --config vite.config.ts",
"build:pwa": "tsc --noEmit && vite build",
"build:ext": "node scripts/build-extension.mjs"
```

### 7.2 New dependencies

```
npm install epub.js
npm install -D vite-plugin-pwa workbox-window
```

epub.js ships a UMD bundle; import it as:
```ts
import ePub from 'epubjs';
```
Confirm the named export — epub.js's npm package has historically had
inconsistent ESM exports. If the import fails, use:
```ts
const ePub = (await import('epubjs')).default;
```

**Version pin:** epub.js 0.3.x has had breaking changes between patch releases.
Pin the exact version in `package.json` (`"epubjs": "0.3.93"` or whichever is
current and confirmed working) and do not accept automatic minor/patch updates
until the import path and `section.document` API are re-validated.

### 7.3 Testing

- **Engine tests**: unchanged. `vitest run` covers `src/engine/*.test.ts` with
  zero browser involvement.
- **AbsClient**: unit-test the API wrapper with a mocked `fetch` — assert that
  the Authorization header is set correctly, that the epub ArrayBuffer is
  returned, and that progress read/write hit the right endpoints.
- **EpubLoader**: test with a small real `.epub` fixture checked into
  `test/fixtures/`. Write a Vitest test in `jsdom` environment that opens the
  fixture and asserts chapter text is extracted.
- **PWA UI**: manual testing on a physical iPhone (Safari) and desktop is the
  pragmatic path for v1. Consider Playwright for basic smoke tests later.

### 7.4 Hosting

Serve the built `dist-pwa/` directory from the user's own media server over
HTTPS, ideally at `https://abs.domain.com/gread/` (same origin as ABS) to
eliminate CORS entirely. Any static file server capable of serving a directory
under a subpath works (nginx, Caddy, etc.).

If the PWA must be hosted on a different origin, add these headers at the
reverse proxy for all `/api/` requests proxied to ABS:

```
Access-Control-Allow-Origin: https://pwa.domain.com
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Methods: GET, PATCH
```

---

## 8. Milestones

Each milestone is independently usable and shippable.

### Milestone 1 — PWA shell with paste/text input

Replace the old throwaway `index.html` harness with a proper PWA entry at
`src/pwa/`. Includes:

- Single-page app with a textarea for pasting text.
- Full reader screen (ORP display, all controls) — port the CSS and logic from
  `content.ts` into a standalone component (no Shadow DOM needed; the PWA owns
  the whole page).
- Correct `<meta name="viewport">`, touch-event handling, 48 px hit targets.
- `manifest.webmanifest`, apple-touch-icon, apple-mobile-web-app-capable meta
  tag, and service worker registered (app shell cache only).
- Passes "installable" check in Chrome DevTools → Application.

**Done when:** the reader screen works on a real iPhone and on desktop, the app
installs to the home screen, and offline reload works.

### Milestone 2 — ABS connection + library browser + epub fetch

- Settings screen: ABS server URL + API key input, stored in `localStorage`.
- `AbsClient` module wrapping the ABS REST API (libraries, item list, epub
  download, progress read/write).
- Library screen showing ABS items; filter to epub-capable items (see §8
  open questions on field name).
- Fetch epub as `ArrayBuffer` via ABS API → pass to `EpubLoader`.
- `EpubLoader` (epub.js wrapper): chapter list from `book.navigation.toc`,
  text extraction via `section.document` or `section.render()`.
- Chapter picker → `engine.load(text)` → reader screen.
- Error handling: connection failure, auth error, DRM notice, parse errors,
  empty chapters.

**Done when:** user can browse their ABS library, tap a book, pick a chapter,
and RSVP it — with no local file involved.

### Milestone 3 — Reading-position sync + persistence + themes

- On reader open: call `GET /api/me/progress/{itemId}`, seek to the last
  position (chapter + approximate token index from progress fraction).
- On reader close / pause: call `PATCH /api/me/progress/{itemId}` with
  updated progress fraction. Exact `epubcfi` is a later refinement.
- `localStorage` settings (WPM, chunkSize, theme, orpEnabled,
  punctuationPause) — same shape as the extension's `Settings` interface.
- Theme picker in the reader screen; honour `prefers-color-scheme` on first
  load.
- iOS install banner (first-visit, dismissible).

**Done when:** closing the app on iPhone and reopening on desktop (or in ABS's
own reader) resumes from the same position.

### Milestone 4 — Local file fallback + offline polish

- `<input type="file" accept=".epub">` local file open path (secondary to ABS).
- Per-book reading position saved locally for local-file books (book
  fingerprint → chapter index + token index in `localStorage`).
- Offline caching strategy review: confirm service worker correctly skips
  `/api/` requests and only caches the app shell; test offline behaviour.
- General UX polish: loading states, error toasts, empty-state screens,
  pull-to-refresh on library screen.

**Done when:** the app is feature-complete for both the ABS path and the
local-file fallback, and degrades gracefully when the ABS server is
unreachable.

---

## 9. Open questions & risks

| Topic | Detail |
|---|---|
| **ABS ebook endpoint** | The exact URL for downloading epub bytes must be confirmed against a running ABS instance (check DevTools network tab while using ABS's built-in ereader). `/api/items/{itemId}/ebook` is the best current guess. |
| **Detecting epub vs. audio-only items** | ABS library items may be audiobooks with no epub. The field name / media metadata shape that distinguishes epub-capable items from audio-only needs to be confirmed against the ABS API response. |
| **API key in localStorage** | Storing a long-lived API key in `localStorage` is visible to any JS running on the same origin. On a shared-origin ABS deployment, this is acceptable (the origin is already trusted). On a cross-origin deployment, evaluate whether a short-lived token or cookie-based auth is feasible. |
| **Progress fraction → token index mapping** | Mapping ABS's fractional progress back to a token index within a specific chapter requires knowing the total token count per chapter. The approach: on open, load the chapter and compute `Math.floor(progress * totalTokens)`. This is approximate — accuracy improves as reading continues. |
| **epubcfi for precise sync** | ABS's own reader uses `epubcfi` strings for exact position. Generating these from a token index requires parsing the epub spine and character offsets. Deferred to a later refinement; fractional progress is sufficient for v1. |
| **DRM epubs** | epub.js cannot open DRM-encrypted files. This is a hard limit. Show a clear error and document the limitation. |
| **Large epubs** | A 500-chapter epub with 10k words/chapter produces a huge ToC list and potentially very long token arrays. Short-term: load one chapter at a time (already the design). Long-term: lazy-load sections. |
| **epub.js ESM exports** | The npm package has had breaking changes between 0.3.x releases. Pin the exact version; verify the import path works with Vite's bundler. |
| **epub.js iframe vs. text extraction** | The approach in §4.4 (accessing `section.document`) works but is not the primary API. It may break on future epub.js releases. Encapsulate it behind `EpubLoader` so there is one place to fix. |
| **Chunk size > 1 with ORP** | The ORP pivot is computed for the full joined chunk string. For chunks ≥ 2 words this lands inside the first word, which is visually correct but may feel wrong for long chunks. No change needed now — document as known behaviour. |
