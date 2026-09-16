# Theme system plan — tokenized themes, dark/bright modes, color roles

Status: **landed** (2026-08-05) — phase 0 `7d2c4be4`, phase 1
`ed377704` + `3583ba38`, phase 2 `cc8a8835`, phase 3 `3f98fd00`. The
enforcement layer (sync test, contrast test, lint guard) remains
**tabled — build later**. The name "deep-field" is retired from code and
internal docs; marketing copy (README, assets/brand) keeps it pending an
editorial decision. The system is just the Junto design system;
its modes are `dark` and `bright`.

Scope: renderer design system, runtime palette consumers, SVG export,
main-process chrome colors, settings schema.

## Goal

1. **One token source of truth** for the design language, projected into
   every consumer (Tailwind `@theme` CSS, TS runtime mirror, SVG export,
   main-process window/recovery colors). Palette drift becomes impossible.
2. **Two modes**: `dark` (today's appearance, pixel-identical after refactor)
   and `bright` (a designed daylight edition, not a mechanical inversion).
   Same semantic layer, second value assignment.
3. **Tokenized color roles** — main / second / accent — so hue families are
   named capabilities primitives compose, never raw hex.

Non-goals: redesigning any surface, changing the dark palette's values, user
themes beyond the two house modes, density/reduce-motion implementation (schema
exists; out of scope here).

## Current state (audit, 2026-08-05)

- Tokens: `@theme` block `src/renderer/styles.css:12` + TS mirror
  `src/renderer/lib/theme.ts`. UI primitives (`components/ui/`) are clean.
- ~800 hardcoded color literals in CSS vs ~834 `var()` refs (~50% bypass).
  Worst: `RtsBottomBar.css` (119), `settings-panel.css` (74), `UsageHud.css`
  (42), `rts-controls.css` (25), `styles.css` itself (336 outside `@theme`).
  Plus 96 hex/rgba matches across 31 tsx files.
- Literals cluster into stable, nameable patterns: ink-at-alpha (~137),
  amber-at-alpha (~87), cyan-at-alpha (~80), white overlays (~59), black
  dims/shadows (~51), crimson (~43), steel (~29), ~40 one-off hexes.
- Palette exists in three diverging copies: styles.css, theme.ts,
  `src/shared/svg.ts` (green already drifted: `#7BB661` vs token `#5FB98E`),
  plus one-offs (`FleetRenderer.tsx` uses `#f0a12e`, not token amber;
  `src/main/index.ts` window bg + recovery HTML).
- Settings plumbing exists end-to-end: `AppearanceSettings { theme:
  "deep-field" | "system", density, reduceMotion }` in `src/shared/settings.ts`,
  persisted in SQLite, IPC-broadcast, reactive renderer store. Nothing consumes
  it for styling. `SettingsPanel.tsx` renders no appearance section.
- `color-scheme: dark` hardcoded (`styles.css:51`); no bright path anywhere.

## Key insight from the audit

The dark mode's literals are already *semantic*, just unnamed. White overlays
are "toward ink" (ink is near-white). Ink-alphas are "ink at low alpha."
Black dims are "toward ground." Named correctly, the same tokens resolve
correctly in both modes — bright mode stops being an inversion problem and
becomes a second value assignment for a shared semantic layer.

## Architecture

### 1. Single source: `src/shared/theme/`

Authored in TypeScript, OKLCH values. Shared (not renderer) so `svg.ts` and
`src/main` can import it directly — no cross-boundary hacks.

- `primitives.ts` — neutral ramps + hue scales, per mode. Never consumed by
  components.
- `semantic.ts` — the semantic mapping per mode (`dark`, `bright`). The only
  tier components may use.
- `index.ts` — public API: `THEME_MODES`, `semanticTokens(mode)`,
  `hueToken(name, mode, variant)`, types.

Projections:

| consumer | how it gets tokens |
|---|---|
| Tailwind CSS | `scripts/theme-build.ts` generates `src/renderer/styles/theme.generated.css` (`@theme` block + `html[data-theme="bright"]` overrides + `color-scheme`). Imported by `styles.css`; the hand-written `@theme` block is deleted. |
| TS runtime (canvas paint, xterm, inline styles) | `src/renderer/lib/theme.ts` becomes a thin re-export of the shared source, keeping its current export names (`HUE`, `GROUND`, `INK`, `withAlpha`, `accentColor`, …) so ~50 consumers are untouched. Adds `themeFor(mode)` for mode-aware consumers. |
| SVG export | `src/shared/svg.ts` imports the shared source directly; `renderCanvasSvg` gains a `mode` param (default `dark`). |
| Main process | `src/main/index.ts` imports ground/ink from `src/shared/theme` for `BrowserWindow.backgroundColor` and recovery HTML. |

Drift guards — **tabled per operator, build later.** The generator exists from
day one (`bun run theme:build`); the guards that make drift impossible land in
a follow-up:

- `tests/theme-build.test.ts` — regenerates artifacts in memory and asserts
  the committed files match byte-for-byte (stale generation fails CI).
- `tests/theme-contrast.test.ts` — computes WCAG ratios for every gated pair
  in both modes (table below). Hard failure under threshold.
- `scripts/lint-design-tokens.ts` wired into `bun run verify` — rejects raw
  hex/`rgba(` color literals in `src/renderer/**` outside
  `styles/theme.generated.css` and an explicit allowlist (external brand marks
  in `provider-marks.generated.ts`, e2e fakes). One-off hexes die here.

### 2. Semantic token taxonomy

Tier 1 primitives (examples): `neutral-{0..1000}` per mode, `hue-amber-*`,
`hue-cyan-*`, … Tier 2 semantic, the full component-facing set:

| token | dark value (today) | notes |
|---|---|---|
| `ground` `raise` `raise-2` `inset` `well` | `#0c0b0a` `#16130f` `#141210` `#131110` `#090807` | field + elevation ladder |
| `ink` `ink-2` `dim` `faint` | `#ede6da` `#c8c0b0` `#8a8378` `#68604a` | text ladder |
| `stroke` `stroke-hi` | ink 14% / ink 28% | becomes `color-mix(in oklab, var(--color-ink) N%, transparent)` — flips for free |
| `overlay-1/2/3/4` | ink 3% / 5% / 7% / 10% | absorbs `rgba(255,255,255,x)` and `bg-white/[0.04]` |
| `backdrop` | ground 72% | absorbs `rgba(0,0,0,0.72)` scrims |
| `umbra` `shadow-1/2` | umbra 55% / 42% (bright: 28% / 18%) | panel shadows, warm-tinted on bright |
| `focus-ring` | second 10% 3px ring | absorbs `shadow-[0_0_0_3px_rgba(57,198,214,0.1)]` |
| `main` `main-hi` `main-fg` | amber family | primary identity, actions |
| `second` `second-fg` | cyan family | info, focus, selection |
| `accent` `accent-fg` | crimson | blockers only (law survives) |
| `{violet,steel,indigo,gold,orange,green}` | existing hues | JSON Canvas presets, entity/source hues — named categories, not decoration |
| `selection` `selection-inactive` | main 28% / 16% | text + xterm selection |

Every hue role ships three variants per mode: **base** (display: dots, canvas
accents, edge paint — saturation allowed), **fg** (text/icons, contrast-gated),
**hi** (lit/hover). This is what keeps amber legible on paper: display amber
stays golden; `main-fg` on bright is the burnished rust from the Ether refs.

Contrast gate (both modes, enforced by test): `ink/ground` ≥ 7, `ink-2/raise`
≥ 4.5, `dim/ground` ≥ 4.5, `faint/ground` ≥ 4.5 (placeholder law), `*-fg` on
their resting surfaces ≥ 4.5, `accent-fg/ground` ≥ 4.5.

### 3. Modes

- Mechanism: `html[data-theme="dark"|"bright"]` scopes the semantic vars;
  `color-scheme` follows the attribute. Dark is the default (no attribute =
  dark) so a settings miss fails closed to today's appearance.
- `system` resolves via `matchMedia("(prefers-color-scheme: dark)")` with a
  live listener; resolution happens once in a renderer module
  (`lib/theme-mode.ts`) that sets the attribute and publishes the resolved
  mode on the settings store for runtime consumers (xterm, Three.js, canvas
  paint).
- Settings schema: `SettingsTheme` becomes `"dark" | "bright" | "system"`.
  Landed as a value-level decode mapping (`deep-field → dark` in
  `src/main/junto/settings/state-schema.ts`); `SETTINGS_VERSION` stays 1 —
  no stored-document version bump, the next persist rewrites the value.
  `SettingsPanel.tsx` gains the Appearance section (segmented mode control,
  composed from existing ui primitives).

### 4. Bright mode design direction (Ether references)

Not an inversion — a daylight edition of the same instrument. From the
reference sheets: aged warm paper ground, graphite-ink hairlines, stipple
texture, muted functional inks (rust, slate blue, teal, deep red), geometry as
decoration.

- **Ground**: warm paper, never pure white (mirror of "never pure black").
  Starting point `oklch(0.955 0.012 85)`. Chroma stays toward amber, the
  brand's own hue.
- **Elevation flips mechanism, not just direction**: on paper, raised panels
  lift *toward light* (`raise` ≈ `oklch(0.975 0.008 85)`), insets sink
  slightly darker (`well` ≈ `oklch(0.91 0.014 85)`), and — per the
  not-an-inversion rule — **shadows come back**. Dark mode carries depth with
  surface-lightness steps and almost no shadow; bright carries it with soft,
  warm-tinted shadows plus hairline ink strokes. `shadow-1/2` tokens are
  near-invisible in dark, present in bright.
- **Ink ladder**: warm near-black `oklch(0.28 0.015 70)` down through dim/faint,
  every step contrast-gated.
- **Strokes/overlays**: no design work — they are `color-mix` of ink/ground and
  flip correctly by construction.
- **Hues**: display variants stay close to the dark mode's family (amber,
  cyan, crimson, steel…); `fg` variants darken to the Ether inks — burnished
  rust for amber-fg, slate blue for cyan-fg, deep red for crimson-fg, teal for
  green-fg. Exact values are tuned in the build against the contrast gate and
  the design-audit screenshots, not derived by formula.
- **Ambient glows**: the dark mode's radial amber washes
  (`styles.css:79-87`) get hand-set bright equivalents (barely-there warm
  wash) or are dropped where they read as dirt on paper. Judged on
  screenshots, not converted.

### 5. Runtime consumers to make mode-aware

- `lib/terminal-theme.ts` — build both xterm themes from the source;
  `TerminalSurface` swaps on mode change.
- `components/fleet/FleetRenderer.tsx` — Three.js colors from
  `themeFor(mode)`; kills the `#f0a12e` drift.
- `components/CanvasMagnifier.tsx` — canvas-2D paint via `themeFor(mode)`.
- `lib/signal-mark.ts`, `lib/activity.ts`, `lib/fleet-layout.ts` — replace own
  constants with source imports.
- `src/main/index.ts` — `BrowserWindow.backgroundColor` + recovery HTML from
  source (recovery page follows resolved mode via query/preload, or stays dark
  by design decision — it renders before settings load; keep dark, it's the
  boot identity).
- `src/shared/svg.ts` — `mode` param threaded from `scripts/render.ts`
  (`--mode bright` flag; default dark).

## Execution

Sequenced so the swarm only runs after the taxonomy it maps against exists.
Dark mode must be pixel-identical through phases 1–2 — the design-audit e2e
frames are the before/after proof.

**Phase 0 — foundation (single thread, no swarm)** — landed `7d2c4be4`
1. `src/shared/theme/` primitives + semantic (dark = today's exact values,
   converted to OKLCH losslessly; bright = first full draft).
2. `scripts/theme-build.ts` + generated CSS + `theme.ts` re-export shim.
3. `bun run typecheck && bun run test` green; design-audit frames unchanged.

**Phase 1 — tokenization swarm (dark-mode-neutral, parallel by chunk)** — landed `ed377704` + `3583ba38`
Each swarm agent gets: the taxonomy table, the literal→token mapping rules
(ink-alpha → `stroke`/`overlay-N`, white overlay → `overlay-N`, black scrim →
`backdrop`, hue-alpha → `color-mix` of the role token), and one chunk:

1. `styles.css` part A (base, focus-surface, workbench, dock)
2. `styles.css` part B (station bar, dialogs, help-map)
3. `styles.css` part C (field-status/legend/hint, filter tray, inspector)
4. `styles.css` remainder (whatever the first pass leaves)
5. `components/rts/RtsBottomBar.css` + `rts-controls.css`
6. `components/settings-panel.css` + `components/UsageHud.css`
7. `components/work/task-board.css` + `work-ledger.css` + `content-media.css`
8. `components/chat/chat.css` + `node-palette-mode-deck.css` + `license.css` + `RegionPathsModal.css` + `CanvasMagnifier.css` + `styles/factory-grammar.css`
9. tsx inline styles + Tailwind arbitrary values (31 files, `NodeShell`, `InspectorFields`, `ObservabilityPanel`, `DigestPanel`, `Field`, `TopBar`, `Canvas`, …)
10. Runtime libs: `FleetRenderer`, `CanvasMagnifier`, `signal-mark`, `activity`, `fleet-layout` (+ `svg.ts`, `main/index.ts` imports)

Gate per chunk: typecheck green, targeted tests green, no visual change in
dark mode. (The lint guard joins the gate when the enforcement layer lands.)

**Phase 2 — mode plumbing (single thread)** — landed `cc8a8835`
Settings decode mapping (value-level, `SETTINGS_VERSION` stays 1),
`lib/theme-mode.ts`, Appearance section in SettingsPanel,
xterm/fleet/magnifier/svg mode wiring, main-process colors.

**Phase 3 — bright craft pass + verification** — in progress
Design-audit e2e in both modes; screenshot review of every surface on paper;
tune bright values (fg variants, glows, shadows) until the bright frames hold
up next to the Ether references; update `AGENTS.md` (design system section —
done, including the retired "deep-field" name) and `docs/`.

## Verification

- `bun run typecheck && bun run test` at every phase boundary.
- `e2e/scenarios/design-audit.spec.ts` — frames reviewed in dark (must equal
  today) and bright (must be designed, not inverted).
- Later (tabled enforcement): `lint:design-tokens`, theme-build sync test,
  contrast test.

## Risks / calls already made

- **OKLCH in `@theme`**: fine in current Electron Chromium + Tailwind v4.
- **`color-mix` tokens**: supported same engines; lets strokes/overlays flip
  for free. Fallback is per-mode literal alphas if a consumer chokes.
- **Settings enum change** landed without a schema migration — a value-level
  decode mapping, `SETTINGS_VERSION` stays 1. `deep-field` retires as a
  *mode name* — and the name itself retires from the design vocabulary
  entirely (operator call, 2026-08-05).
- **Recovery HTML stays dark**: it renders before settings load; dark is the
  boot identity. Revisit only if it ever reads settings synchronously.
