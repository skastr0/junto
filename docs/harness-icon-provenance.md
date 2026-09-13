# Official brand icons — pi, prime-agent, kimi, muse, devin

Provenance receipts for the curated harness marks added to
`src/renderer/lib/harness-icons.ts` (CURATED entries + ALIASES) as part of the
five managed-terminal harnesses build (pi, prime-agent, kimi, muse, devin,
closed HarnessId literal and templates landed in 639a46d9).

How the repository is shaped:

- `GLYPHS` = generated `PROVIDER_MARKS` + `CURATED` overrides/additions.
  Curated wins on key collision.
- `PROVIDER_MARKS` is monochrome vector path data extracted from each
  provider's own published artwork — site favicon/icon SVGs, official brand
  assets, and provider-controlled repositories. Every entry carries a
  `// Source:` comment with its fetch origin.
- `devin` resolves from the generated table: the official Cognition mark
  fetched from https://cognition.com/icon.svg (SHA-256
  `207432b78c80378b659deff5114d06e7def680ec6f5b2265a0ac714a9f82beda`).
- `pi`, `prime-agent`, `kimi`, `muse` have no generated mark — they remain
  curated. `kimi` replaced an earlier unprovenanced wordmark path; `pi`,
  `prime-agent` are official vectors; `muse` is a documented crafted
  monogram.
- CURATED also carries provider-published raster marks (embedded data URLs)
  for providers that ship no usable standalone monochrome vector —
  alibaba, chutes, codebuff, deepgram, deepseek, doubao, jetbrains, kiro,
  minimax, ollama, perplexity, poe, sakana, synthetic, t3chat, venice,
  vertexai, warp — each constant's comment in
  `src/renderer/lib/official-agent-assets.ts` records the provider-controlled
  URL it was fetched from.
- Providers with no published mark at all (clawrouter, commandcode, crof,
  crossmodel, litellm, llmproxy, mimo, sub2api) carry bare CURATED entries so
  the tile keeps the right display name and renders the existing monogram
  fallback — no fabricated marks.
- Monochrome marks record `hex: "#000000"` so `harnessHue` remaps them to
  house INK (the same convention as the whole generated table).

---

## pi — official pi.dev mark (SVG path, curated)

| | |
|---|---|
| Embedded | two paths on the native 800x800 grid, `fillRule: "evenodd"` (spiral has an inner hole; the dot is a plain rect) |
| Source | https://pi.dev/logo-auto.svg (mark-only monochrome SVG; the site also serves `/favicon.svg`, a rounded-square tile variant of the same mark) |
| SHA-256 | `03d509c104b9570063fa268fd3235ed7e0e41dafd93124ca94cae3726f58f117` |
| Fetched | 2026-08-06, HTTP 200, `image/svg+xml` |
| Extraction | `logo-auto.svg` has two `<path class="logo-mark">` elements; path data copied verbatim |
| Grid note | 800x800 kept native (coordinates are simple; a 24x24 rescale would be a lossy transcription) |

Display name "Pi". Aliases: `pi coding agent` → pi, `pi-coding-agent` → pi
(canonical `pi` passes through).

## prime-agent — official Prime Intellect butterfly (SVG path, curated)

| | |
|---|---|
| Embedded | two paths on the native 178x178 grid (nonzero fill) |
| Source | https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/assets/brand/prime-butterfly.svg (shipped in the prime-agent repo's `assets/brand/`; a `prime-butterfly-black.svg` twin is byte-identical art) |
| SHA-256 | `3451200ed7200beb5ce487612c07add15f536cc4025800dcbfd4486812cee0b1` |
| Fetched | 2026-08-06, HTTP 200, `image/svg+xml` |
| Extraction | two `<path>` elements copied verbatim. Source fills white (dark-field art); the mark is monochrome, so it records house `#000000` → INK like claude |
| Also | primeintellect.ai serves `/icons/primeintellect-logo.svg` and `/icons/logo-icon.png` — the logo-icon is an 800x800 PNG of the same family, but the repo butterfly is the cleanest monochrome vector |

Display name "Prime Agent". Aliases: `prime agent` → prime-agent.

## kimi — official Kimi K logomark (SVG path, curated, replaces old wordmark)

| | |
|---|---|
| Embedded | single path on the native 1024x1024 grid (nonzero fill, `fill="currentColor"` in source) |
| Source | https://statics.moonshot.cn/kimi-web-seo/assets/kimi.icon-BhdvzFgS.js — kimi.com's production icon bundle (Iconify collection, key `a_Kimi`) |
| SHA-256 | `7a9aa96aaf9beaac9b9560c315280a1c5494fd7368e62440f932e5ea47056d42` |
| Fetched | 2026-08-06, HTTP 200, `application/javascript` |
| Extraction | `JSON.parse` icon body, `d="…"` attribute copied verbatim |
| Why replaced | the previous curated path was the lowercase "kimi" wordmark with no recorded source. Current official kimi.com art (favicon-dark.ico, logo component `kimi-logo-BS1u0Z--.js`, icon bundle) uses the K logomark; this is the official monochrome vector with a verifiable receipt |

Display name "Kimi" (template display name is "Kimi Code"). Aliases:
`kimi code` → kimi.

## muse — crafted monogram fallback (no official vector found)

No official Muse Code monochrome vector is publicly reachable. The curated
entry is a tasteful monogram M: four filled stroke quads (two verticals, two
diagonals meeting at the apex) on the default 24x24 grid, union-filled
(nonzero). Path data:

```
M8.3 20.5L8.3 5.5L3.7 5.5L3.7 20.5Z
M4.25 7L10.25 14L13.75 11L7.75 4Z
M13.75 14L19.75 7L16.25 4L10.25 11Z
M15.7 5.5L15.7 20.5L20.3 20.5L20.3 5.5Z
```

Hunt log (all 2026-08-06, every attempt read-only):

1. `muse.meta.ai` — DNS failure.
2. `www.meta.ai/muse`, `/muse-code`, `meta.ai/muse-code` — HTTP 401 (auth-gated SPA shell, no assets served).
3. `api.meta.ai/muse-code/channels/muse-stable` — channel manifest JSON; artifacts are binaries only (lookaside.facebook.com).
4. `lookaside.facebook.com/lookaside/muse/download/…` probes for icon/logo/brand file names — all 404.
5. GitHub org search (facebook, facebookresearch, meta-llama) and npm registry — no muse-code repo/package.
6. Installed Muse Code 0.1.0-R708.1 pkg expanded (xar + cpio): ships only `/usr/local/bin/muse`; no .app, .icns, or image resources. Binary string scan: no brand art, no embedded PNG/SVG icons.
7. TUI probe with a PTY responder (DSR/OSC answers, echo provider): renders an empty screen, no banner/logo.
8. ai.meta.com Muse Spark blog heroes (via reader proxy): typographic posters, no clean logomark.
9. Wayback Machine CDX for muse-code pages — no snapshots.

Display name "Muse". Aliases: `muse code` → muse.

## devin — official Cognition mark (generated table)

Devin resolves from the generated `PROVIDER_MARKS` table: the official
Cognition mark fetched from https://cognition.com/icon.svg (SHA-256
`207432b78c80378b659deff5114d06e7def680ec6f5b2265a0ac714a9f82beda`), three
paths on its native `-0.747952 -0.722232 21.495942 21.477469` grid.

Aliases: `devin cli` → devin (existing `cognition` → devin kept).

---

## Aliases added (harness-icons.ts)

| alias | canonical |
|---|---|
| `pi coding agent` / `pi-coding-agent` | pi |
| `prime agent` | prime-agent |
| `kimi code` | kimi |
| `muse code` | muse |
| `devin cli` | devin |
| `opencode-go` | opencodego |

## Verification

- `bun run typecheck` (files: harness-icons.ts, official-agent-assets.ts).
- `bun test tests/harness-icons.test.ts` — curated keys resolve, alias
  resolution, hue remap to INK for the new monochrome marks.
- Rasterization spot-check of every embedded path (pi spiral+dot evenodd,
  butterfly union, kimi K, muse M) before commit.
