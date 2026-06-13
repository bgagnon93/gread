# gread

An RSVP ("spreeder") speed-reader. Highlight text on a web page and read it
back one word at a time, with an ORP pivot letter, at your chosen WPM.

See [DESIGN.md](DESIGN.md) for the full architecture and roadmap.

## Status

**Milestone 3 — full overlay controls.** Highlight text, then trigger via the
right-click menu ("Speed-read selection") or `Alt+Shift+Z`. The style-isolated
overlay has an interactive scrubber, WPM and chunk-size sliders, theme switching
(dark/light/sepia), a live ETA, and an expanded keyboard map. Settings aren't
persisted yet — that's Milestone 4.

Keyboard: `Space` play/pause · `←`/`→` step · `↑`/`↓` speed · `T` theme · `Esc` close.

Milestone 1 (standalone engine + harness) lives on at `npm run dev`.

## Develop

```sh
npm install
npm run dev        # Milestone 1 harness page (Vite prints the URL)
npm test           # engine unit tests
npm run build:ext  # bundle the extension into dist/  (watch:ext to rebuild)
```

## Load the extension (Chrome/Edge)

1. `npm run build:ext`
2. Visit `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.
4. On any normal page, select text → right-click **Speed-read selection**, or
   press `Alt+Shift+Z`. Rebind the key at `chrome://extensions/shortcuts`.

After code changes, rerun `npm run build:ext` (or keep `npm run watch:ext`
running) and hit the reload icon on the extension card.

The engine in `src/engine/` is pure TypeScript with no browser dependencies —
the UI subscribes to its `tick` / `state` / `end` events. That boundary is what
keeps it testable and lets it drop unchanged into the extension later.
