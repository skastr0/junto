# F3 editor spike: `@pierre/diffs/edit` 1.6.2 against CodeMirror

Run 2026-10-27 for plan 0.11 F3. One 5,000-line TypeScript file (208,869
bytes: the repo's `src/main/*.ts` concatenated, `bun run fixture`), opened in
Electron 43.5.0 (the app's Chromium) on this Mac, driven by Playwright with
trusted key events. Raw rows: `results.ndjson`. Harness: `measure.mjs` (one
editor, one theme), `profile.mjs` (CPU profile of a warm open).

## Verdict

**Pierre wins, with its `highlights` backend and its `Virtualizer`.** It
needs `'wasm-unsafe-eval'` added to the renderer CSP (`index.html:7`). Without
that token the `highlights` backend never draws and nothing falls back. Pierre
on its default Shiki JS engine loses to CodeMirror.

## Numbers (dark, then bright)

| Editor | Open, warm (3 runs) | Typing p50 / p95 / max | Heap | DOM nodes |
|---|---|---|---|---|
| CodeMirror + language-data | 6 to 8 ms | 5.7 / 10.4 / 15 ms | 9 MB | 301 |
| Pierre, `highlights`, virtualized | 21 to 33 ms | 4.2 / 11.5 / 41.9 ms | 16 MB | 1,371 |
| Pierre, Shiki JS, virtualized | 1,239 to 1,268 ms | 4.4 / 20 / 385 ms | 49 MB | 1,345 |
| Pierre, Shiki JS, not virtualized | 1,690 to 2,308 ms | 61 / 856 / 1,041 ms | 56 MB | 57,506 |
| CodeMirror, bright | 6 to 7 ms | 6.0 / 10.2 / 15 ms | 12 MB | 344 |
| Pierre `highlights`, bright | 18 to 24 ms | 7.9 / 13.4 / 21.8 ms | 27 MB | 1,371 |

- **Open** is the time to the first frame that shows highlighted code. A warm
  open has the code already loaded, which is the case for every file after the
  first. The first open in a fresh window varied from 148 to 678 ms for
  CodeMirror and from 216 to 4,910 ms for pierre with `highlights` (the
  WebAssembly compile). Loading the highlighter when the Files modal opens
  hides that cost.
- **Typing** runs from keydown to the frame after the DOM changed, over 41 keys
  at line 2,500. Chromium's Event Timing reads p50 16 ms for pierre with
  `highlights` and 24 ms for CodeMirror. Both are inside a frame or two.
- **Where Shiki JS spends the time:** `findNextMatchSync`, which takes 1,186 of
  the 1,299 ms in a warm open (`profile.mjs`). It tokenizes the whole file on
  the main thread. Adding the worker pool (`pierre-worker`) changed nothing,
  because the editor tokenizes on its own. The `shiki-wasm` engine gave a
  645 ms warm open and a 10.6 s cold one.

## Undo, find, theme

- **Undo:** in every editor and both themes, undo brings the text back byte for
  byte and redo changes it again. CodeMirror needs 1 press for the burst and
  pierre needs 2.
- **Find:** both open a panel on Cmd+F, and Enter steps through the matches.
  Pierre's panel shows a count ("3 of 21") and toggles for case, whole word
  and regex. It moves to the first match as you type, so Enter goes to the
  next one (lines 284, then 297). CodeMirror's Enter goes to the first match
  (255, then 284).
- **Theme:** pierre takes `pierre-dark` and `pierre-light` from the theme
  `CodeView.tsx` already uses, so the editor matches the git review. The
  CodeMirror field needs a highlight style written for each theme.

## Under the app's CSP

`index.csp.html` copies the renderer policy from `index.html:7`:

- `script-src 'self'`: pierre with `highlights` never draws, with no error on
  the page (the run times out after 60 s). Pierre on Shiki JS still runs, with
  a 1,257 ms warm open.
- `script-src 'self' 'wasm-unsafe-eval'`: pierre with `highlights` opens in
  20 to 28 ms warm and 344 ms cold, typing p50 4.3 ms.

`'wasm-unsafe-eval'` lets the page compile WebAssembly. It does not allow
`eval` or `new Function`.
