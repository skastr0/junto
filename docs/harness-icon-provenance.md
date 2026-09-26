# Harness marks: sources and receipts

Every managed harness in Add item, on seat tiles, in the terminal header and
in the usage HUD wears its vendor's own mark, drawn as vector path data in
house ink (`var(--color-ink)`). No vendor colour, no letter placeholders, and
no rasters for harnesses: one ink, so a mark reads the same in the dark and
bright themes and never competes with the canvas's state colours.

Audit of 2026-09-26, every source fetched that day from a vendor-controlled
URL. The guard is `tests/harness-icons.test.ts` ("gives every managed harness
its vendor's own vector mark") and the two-theme spec
`e2e/scenarios/harness-marks.spec.ts`.

## How the repository is shaped

- `GLYPHS` in `src/renderer/lib/harness-icons.ts` is the generated table
  `PROVIDER_MARKS` (`src/renderer/lib/provider-marks.generated.ts`) plus
  `CURATED`, where curated wins on a key collision.
- `PROVIDER_MARKS` holds monochrome path data extracted from each vendor's
  own artwork. Each entry carries a `// Source:` comment.
- `CURATED` keeps three older vectors (googlegemini, pi, prime-agent), the
  raster marks of usage providers that publish no vector, and bare entries
  for providers with no mark at all.
- `harnessHue` returns INK for everything. The brand-hex field and the
  hashed monogram palette are gone.

## Usage and licensing

The marks are the vendors' trademarks. Junto shows them only to name the
harness a seat runs: nominative use, unaltered in shape, recoloured to one
ink the way vendors' own monochrome variants are. Several source repos carry
open licences (oh-my-pi MIT, hermes-agent MIT, fx Apache-2.0), but those
cover code, not trademarks. This is an engineering reading, not legal
advice. A vendor asking for removal gets the monogram fallback.

## The fourteen harnesses

| Harness | Mark | Source | Receipt |
|---|---|---|---|
| Claude Code (`claude`) | Claude spark | https://claude.ai/favicon.svg | file SHA-256 `b150888b…97350`, unchanged art |
| Codex (`codex`) | OpenAI blossom | https://developers.openai.com/favicon.svg | Codex publishes no mark of its own; parent-brand mark, as before |
| Grok (`grok`) | Grok slashed ring | https://grok.com/images/favicon.svg | unchanged art |
| Hermes (`hermes`) | Hermes Agent portrait | https://raw.githubusercontent.com/NousResearch/hermes-agent/main/assets/icon-master.svg | file SHA-256 `c5bf1ba3…00412`; **was a 48px raster** |
| Pi (`pi`) | square-spiral Pi and dot | https://pi.dev/logo-auto.svg | file SHA-256 `03d509c1…8f117` (2026-08-06), unchanged |
| Prime Agent (`prime-agent`) | Prime Intellect butterfly | prime-agent repo `assets/brand/prime-butterfly.svg` | file SHA-256 `3451200e…ee0b1` (2026-08-06), unchanged |
| Kimi Code (`kimi`) | K and dot | kimi.com icon bundle, Iconify key `KforKimi_f` | bundle `kimi.icon-oUuNb_JD.js` SHA-256 `9644d2e5…00d181`; **was the wrong mark** |
| Muse (`muse`) | Meta mark | https://ai.meta.com/muse/ page icon `static.xx.fbcdn.net/rsrc.php/yO/r/8S6ZPxM3N1I.svg` | file SHA-256 `0200dc99…e366b`; **was a hand-drawn M** |
| Devin (`devin`) | Devin three-cell mark | https://devin.ai/favicon.svg | file SHA-256 `fe0753d2…cd682`; **was Cognition's company mark** |
| Cursor Agent (`cursor`) | Cursor cube | https://cursor.com/favicon.svg | unchanged art |
| Antigravity (`agy`) | Antigravity arch | https://antigravity.google/ header logo | page SHA-256 `71304b10…e6561`; **was Gemini's violet sparkle** |
| Amp (`amp`) | "amp" wordmark | https://ampcode.com/logo-dark.svg (press kit) | file SHA-256 `3c2a38b6…c9b5e55`; **grid fixed** |
| fx (`fx`) | fx glyph | https://fx.sh/ header logo, `logo-fx-glyph` | page SHA-256 `26a8a1d7…eca6c`; **was a teal "F"** |
| Oh My Pi (`omp`) | Oh My Pi glyph | https://omp.sh/favicon.svg | file SHA-256 `9419975a…e69fe05`; **was a teal "O"** |

The overseer seat (`junto-overseer`) is Junto's own and wears `OverseerMark`.

## What changed, and why

### Antigravity: its own mark, not Gemini's

`agy` and `antigravity` resolved to the Gemini sparkle in brand violet.
Antigravity is its own product with its own mark: the arch "A" in the
antigravity.google header. The site paints a blurred colour field through
that arch's alpha mask, and the mask path is the mark's silhouette. It is
copied verbatim (`<mask id="mask0_6001_463">`, one path). Gemini keeps its
sparkle, now in ink.

### Kimi Code: the K and dot, not a chain

The previous path was Iconify key `a_Kimi` from the same bundle: two
interlocking links around a dot. It is not the Kimi logo. The Kimi app icon
(`kimi.com/pwa-192.png`), the Kimi Code docs logo
(`moonshotai.github.io/kimi-code/assets/Kimi.CThWxdLR.png`) and the Kimi CLI
web logo (`MoonshotAI/kimi-cli/web/public/logo.png`) all show a K with a dot
at its top right. The same bundle ships that exact mark as `KforKimi_f`: one
path on a 1024 grid, `fill="currentColor"`. The path is copied verbatim.

### fx and Oh My Pi: real marks instead of letters

Neither harness had an entry, so both fell to the hashed monogram (a
coloured initial).

- **fx:** fx.sh draws its logo inline, and `logo-fx-glyph` is the product
  mark (`fill="currentColor"`). The Vercel triangle beside it is Vercel's
  mark and stays out.
- **Oh My Pi:** omp.sh serves `favicon.svg`, a gradient glyph on a dark
  tile. The glyph path (`M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z`) is taken
  without the tile. The repo's older `assets/icon.svg` (a pi with a plug) is
  not what the product shows today.

### Hermes: vector instead of raster

The 48px PNG could not follow the theme; it was a white tile in dark mode.
The hermes-agent repo ships the master icon as SVG: one black portrait path
inside a framed tile.

- The portrait path is taken without the frame.
- Its `matrix(1.0330354,0,0,1.0330354,-145.41428,-2499.328)` transform is
  folded into the viewBox.
- Coordinates are rounded to whole units of the 5160-unit grid, which
  shrank the path from 116 KB to 60 KB. That is a 0.003 px error at the
  largest tile.

### Muse: Meta's mark instead of a crafted M

Muse still publishes no mark of its own:

- `www.meta.ai/muse` and `/muse-code` return 401.
- `muse.meta.ai` does not resolve.
- `developers.meta.com/muse` returns 404.
- `ai.meta.com/muse/` shows only the Meta mark and the Meta wordmark.

The hand-drawn M implied a brand that does not exist. Muse now wears the
Meta mark from its own page, the parent-brand rule Codex already follows.
The source is fifteen gradient-filled pieces. They are joined into one path
so adjacent pieces rasterise together with no hairline seams.

### Devin: Devin's mark, not Cognition's

The table carried `cognition.com/icon.svg`, the company's six-cell mark. The
harness is Devin, and devin.ai's favicon (and `icon.png`) is a different
three-cell mark. The Devin mark is now used; the alias `cognition` still
resolves to it.

### Amp: the descender is back

`ampcode.com/favicon.svg` now returns an auth page. The press kit
(`ampcode.com/press-kit`) publishes `logo-dark.svg`, `logo-light.svg` and
`app-icon.svg`. The app icon is the same "amp" wordmark on a dark field, so
the wordmark is the mark. Its path is byte-identical to the one already
embedded. The old grid stopped at y 114, which cut the p's descender (the
path runs to y 143). The grid is now `0 20 280.603 123.016`.

## Grids

New entries sit on square grids fitted to the art, measured from a
rasterised render, so their optical size matches the rest of the set:

| Mark | viewBox |
|---|---|
| antigravity | `9.5 11 92 92` |
| devin | `35.8 35.5 355 355` |
| fx | `166.241 0 155.861 156` (native) |
| hermes | `137 2571 5160 5160` (the bust's cut edge sits on the bottom edge) |
| kimi | `146 113 732 732` |
| muse | `0.7 -0.2 32.4 32.4` |
| omp | `10.4 14.4 43.2 43.2` |

## Not in scope: usage-provider rasters

Eighteen usage providers (alibaba, chutes, codebuff, deepgram, deepseek,
doubao, jetbrains, kiro, minimax, ollama, perplexity, poe, sakana, synthetic,
t3chat, venice, vertexai, warp) still render the vendor's raster icon in the
usage HUD, because none publishes a vector. They are providers, not
harnesses, and none appears in Add item. Their sources are recorded beside
each constant in `src/renderer/lib/official-agent-assets.ts`.
