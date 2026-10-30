---
name: Junto
description: A dark-first canvas where one operator runs a crew of AI agent seats, and the screen shows only what needs them.
colors:
  ground: "oklch(0.15039 0.00272 67.55)"
  raise: "oklch(0.18883 0.00925 75.06)"
  raise-2: "oklch(0.18379 0.00518 67.50)"
  inset: "oklch(0.17963 0.00389 48.50)"
  well: "oklch(0.13530 0.00322 69.58)"
  ink: "oklch(0.92716 0.01775 81.33)"
  ink-2: "oklch(0.80991 0.02376 84.59)"
  dim: "oklch(0.70000 0.01830 79.30)"
  faint: "oklch(0.62000 0.03000 90.43)"
  stroke: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 14%, transparent)"
  stroke-hi: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 28%, transparent)"
  overlay-1: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 3%, transparent)"
  overlay-2: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 5%, transparent)"
  overlay-3: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 7%, transparent)"
  overlay-4: "color-mix(in oklab, oklch(0.92716 0.01775 81.33) 10%, transparent)"
  backdrop: "color-mix(in oklab, oklch(0.15039 0.00272 67.55) 72%, transparent)"
  focus-ring: "color-mix(in oklab, oklch(0.76048 0.11721 206.31) 10%, transparent)"
  selection: "color-mix(in oklab, oklch(0.76490 0.13988 72.95) 28%, transparent)"
  amber: "oklch(0.76490 0.13988 72.95)"
  amber-hi: "oklch(0.89239 0.06852 85.73)"
  cyan: "oklch(0.76048 0.11721 206.31)"
  crimson: "oklch(0.62557 0.19334 23.03)"
  steel: "oklch(0.70421 0.02949 236.38)"
  violet: "oklch(0.64851 0.16258 287.53)"
  indigo: "oklch(0.63143 0.17645 275.45)"
  green: "oklch(0.71797 0.10827 161.16)"
  orange: "oklch(0.69551 0.16920 44.10)"
  gold: "oklch(0.75664 0.11885 83.55)"
typography:
  hero:
    fontFamily: "Arial Narrow, Avenir Next Condensed, Helvetica Neue, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  display:
    fontFamily: "Arial Narrow, Avenir Next Condensed, Helvetica Neue, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.14em"
  title:
    fontFamily: "SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
  body-lg:
    fontFamily: "SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
  body:
    fontFamily: "SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  prose:
    fontFamily: "-apple-system, SF Pro Text, system-ui, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  prose-xl:
    fontFamily: "-apple-system, SF Pro Text, system-ui, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  pill: "999px"
components:
  button-chrome:
    backgroundColor: "color-mix(in oklab, var(--color-ink) 4%, transparent)"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  button-chrome-hover:
    backgroundColor: "color-mix(in oklab, var(--color-ink) 10%, transparent)"
  button-primary:
    backgroundColor: "color-mix(in oklab, var(--color-amber) 18%, transparent)"
    textColor: "{colors.amber-hi}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  button-primary-hover:
    backgroundColor: "color-mix(in oklab, var(--color-amber) 26%, transparent)"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.dim}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  button-danger:
    backgroundColor: "color-mix(in oklab, var(--color-crimson) 10%, transparent)"
    textColor: "{colors.crimson}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  button-md:
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  input-field:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  input-field-dense:
    typography: "{typography.body}"
    height: "28px"
    padding: "4px 8px"
  palette-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
  palette-row-selected:
    backgroundColor: "{colors.overlay-2}"
  list-row:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "0 10px"
  list-row-selected:
    backgroundColor: "{colors.overlay-2}"
  node-chip:
    backgroundColor: "{colors.overlay-3}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.pill}"
    height: "28px"
    padding: "0 11px 0 9px"
  status-tag:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "22px"
  key-cap:
    backgroundColor: "color-mix(in oklab, var(--color-cyan) 6%, transparent)"
    textColor: "{colors.cyan}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 5px"
  callout-note:
    backgroundColor: "color-mix(in oklab, var(--color-amber) 8%, transparent)"
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  modal-frame:
    backgroundColor: "{colors.raise}"
    rounded: "{rounded.xl}"
    width: "700px"
---

# Design System: Junto

## Overview

**Creative North Star: "The Lamplit Control Room"**

Junto is a dark room lit by one warm lamp. The operator sits at a canvas of agent seats, task boards and regions, and the room stays quiet until something needs them. AGENTS.md says it plainly: "The UI exists to show what needs the operator: the seat's state ring and halo, the inbox, notifications and sound cues." Everything else stays out, because every extra surface competes for attention. The lamp is amber, the home hue, and it is almost the only light in the room: about 95 percent of colored marks are amber, with sparse cyan for focus and keys, and crimson kept for blockers alone.

The voice is an instrument panel, not a dashboard. Type is monospace by default (the root font is `--font-mono`), small and dense: most of the app reads at 10, 11 and 12px, on 28px rows. A condensed display face stamps titles, the wordmark and the label node in uppercase with wide tracking. Strokes are hairlines of ink at low alpha, never greys. Depth in dark comes from small steps in surface lightness, not from shadows. The bright theme is a designed daylight edition on warm paper, never a mechanical inversion.

This system rejects: cards with action buttons on them, decorative motion, gradients and blur shadows on canvas nodes, color as the only carrier of state, generic robot glyphs where a seat's portrait belongs, and operator copy that explains mechanics (ports, grants, masks, wire families). Canvas nodes are not cards at all: a node is one chip with its contents hanging from a thin spine, and the ground shows through (`docs/node-card-language.md`).

Tokens have one source, `src/shared/theme/` (OKLCH primitives in `primitives.ts`, meaning per mode in `semantic.ts`), projected by `scripts/theme-build.ts` into `src/renderer/styles/theme.generated.css` with `bun run theme:build`. Runtime consumers (canvas paint, inline styles) read the same source through `src/renderer/lib/theme.ts` (`HUE`, `HUE_TEXT`, `INK`, `DIM`).

**Key Characteristics:**
- Warm near-black ground, never pure black; warm paper in bright, never pure white.
- One home hue (amber), one focus hue (cyan), one alarm hue (crimson).
- Monospace instrument type at a six-step scale from 10 to 24px.
- Hairline ink strokes and ink-alpha overlays for every hover, tint and divider.
- Flat surfaces; shadows only on floating frames above the canvas.
- Status is a shape plus a word, never color alone.
- Motion runs on the compositor and is never slowed to save frames.

## Colors

A restrained, warm palette: tinted near-black neutrals toward hue 70 to 85, one committed amber, and a reserve of canvas hues that mark kinds and regions but never decorate.

### Primary
- **Lamp Amber** (`amber`, role `main`): the home hue. The one primary button per surface, the selected node ring, needs-you status, automations glyph, note callouts, region title hover. In bright it reads as burnished rust through `amber-fg`.
- **Lit Amber** (`amber-hi`, role `main-hi`): the lit companion. Primary button text, emphasis on amber fills. In bright it darkens, because emphasis on paper is darker, not lighter.

### Secondary
- **Signal Cyan** (`cyan`, role `second`): focus and keys. The house focus ring, the field focus border at 60 percent, the focus halo (`focus-ring`, cyan at 10 percent), key caps, the Working status tag, the armed button.

### Tertiary
- **Blocker Crimson** (`crimson`, role `accent`): blocked, failed, refused, destructive. The danger button, the Blocked tag, error words. Nothing else.

### Canvas hues
- **Steel** (`steel`): quiet chrome text, panel eyebrows, icon buttons at rest.
- **Violet** (`violet`): artifacts. **Indigo** (`indigo`): browser pages. **Green** (`green`): task boards. **Orange** (`orange`): git. **Gold** (`gold`): a mustard beside the amber.
- Region and label colors add `yellow`, `lime`, `blue`, `pink` and `teal` (`src/shared/canvas-colors.ts`); each label color ships a fill at 18 percent, a stroke at 60 percent and its own word color, `label-<name>-fg`, cleared at 4.5 to 1 on every surface by `scripts/theme-build.ts`.

### Neutral
- **Night Ground** (`ground`): the canvas and app field.
- **Raised Panel** (`raise`, `raise-2`): dialogs, operator modals, the shown browser tab.
- **Inset** (`inset`): every text field and dropdown popup. **Well** (`well`): the deepest inset.
- **Lamplit Ink** (`ink`): primary text. **Ink 2** (`ink-2`): row text, note bodies, dialog body. **Dim** (`dim`): counts, meta lines, secondary text. **Faint** (`faint`): placeholders, footers, kind words. Dim and faint both clear 4.5 to 1 on ground and raise.
- **Hairline** (`stroke`, ink at 14 percent) and **Bright Hairline** (`stroke-hi`, ink at 28 percent): every border and divider, and the node spine.
- **Overlays** (`overlay-1` to `overlay-4`, ink at 3, 5, 7 and 10 percent): hover, selected row, node chip fill, tab rule. In bright they roughly double so they still register.
- **Backdrop** (`backdrop`): the one modal dim, ground at 72 percent (umbra at 18 percent in bright, because a scrim on paper must dim).

### Named Rules
**The Lamplight Rule.** About 95 percent of the colored marks on any screen are amber. Cyan is for focus and keys. Everything else is ink. If a screen has three hues competing, two of them are wrong.

**The Crimson Means Blocked Rule.** Crimson marks a blocker, a failure, a refusal or a destructive action. It is never a brand accent, a highlight or a decoration.

**The Mark and Word Rule.** A hue drawn as a mark (dot, glyph, ring, border) uses its base token; a hue drawn as text uses its `-fg` token (`amber-fg`, `cyan-fg`, `crimson-fg`, `label-<name>-fg`). The marks fall near 3 to 1 on paper; the words clear 4.5 to 1.

**The One Source Rule.** Never hardcode a palette hex, rgba or OKLCH value in a component. Edit `src/shared/theme/`, run `bun run theme:build`, and consume the token (`lint:design-tokens` holds it). There is never a second palette.

## Typography

**Display Font:** Arial Narrow (with Avenir Next Condensed, Helvetica Neue, sans-serif), `--font-display`
**Body Font:** SF Mono (with SFMono-Regular, Menlo, Consolas, monospace), `--font-mono`, the root font
**Prose Font:** the system sans (-apple-system, SF Pro Text, system-ui), `--font-body`, for long human-written text only

**Character:** a monospace instrument voice for every name, count and control, stamped with a condensed uppercase display face where something needs a title. The proportional sans appears only where people write paragraphs: thread messages, quick capture, automation prompts.

### Hierarchy
- **Hero** (display font, 700, 24px, 1.2): the label node on the canvas, first-run headings.
- **Display** (display font, 600, 18px, uppercase, 0.14em tracking): stamped section titles, the empty canvas title.
- **Title** (mono, 600, 14px, 1.35): dialog titles, note headings.
- **Body Large** (mono, 500 to 600, 12px, 1.45): node chip names, palette row titles, form fields, md buttons, the palette input.
- **Body** (mono, 400, 11px, 1.45): the working size. List rows, spine rows, dialog body, counts. The most used step in the app.
- **Label** (mono, 600, 10px, uppercase, 0.08em tracking): sm and xs buttons, status tags, meta lines, footers, key caps, eyebrows (eyebrows widen to 0.14em).
- **Prose XL** (sans, 400, 16px, 1.6, `--text-prose-xl`): the reading step, for long human-written text a person reads for a while. Seat thread messages only, set at a 34em measure (66 to 72 characters at 12, 14 and 16px, because em follows the size). Never a control, a count or a name.

Tracking steps are `flat` 0, `soft` 0.04em, `label` 0.08em and `eyebrow` 0.14em; leading steps are `compact` 1.2, `dense` 1.35, `body` 1.45 and `open` 1.6. Weights in use are 400, 500, 600 and 700; 600 carries most names. The wordmark is uppercase JUNTO in the display font, weight 600, 0.14em, in `ink` (`docs/brand/README.md`).

### Named Rules
**The Type Steps Rule.** New work uses six sizes: `label` 10px, `body` 11px, `body-lg` 12px, `title` 14px, `display` 18px, `hero` 24px, plus one reading-only step, `prose-xl` 16px, which only a reading surface (thread messages) may use. `micro` 8px and `caption` 9px are legacy and under review: never reach for them in new work. There is no 13px. A raw pixel size is a defect waiting for its nearest step (`scripts/design-token-codemod.ts` holds the mapping).

**The Reading Code Step Rule.** Code inside reading prose takes the step below the prose, never a scaled em: prose 12 sets code at `body` 11, prose 14 at `body-lg` 12, prose `prose-xl` 16 at `title` 14 (0.86em of 16px is 13.76px, and there is no 13). One variable per surface, `--prose-code-size`, sits beside `--prose-size`.

**The Instrument Type Rule.** Mono is the default voice. The display face is a stamp: uppercase, tracked, short. The prose face is for paragraphs a person wrote. Never set a control, a count or a node name in the prose face.

## Layout

The app is a full-window spatial canvas with a fixed chrome around it: a 64px bar (`--bar-height`), pinned tabs, the dock and floating HUDs on the base layer. Regions are geography on the canvas: a 24px title bar and a 12px frame (`src/renderer/styles/region-title.css`). Working modals center one subject at a measured width over a dimmed periphery (`.focus-surface`, 16px inset), because one subject reads better measure-constrained than full-bleed. Operator modals anchor near the top at 3vh, centred, 700px wide for Cmd+K.

Spacing rides Tailwind's 4px step with dense, fixed measures: 28px list rows, dense fields and node chips; 22px status tags; a 24px minimum hit area on every button; a 46px palette input row; 6px list padding with 1px gaps in popups. Gaps inside a row are 6 to 10px; node chips use 7px. The canvas zooms through tiers (near, far, overview): at far a node becomes a held disc no smaller than 26 screen pixels, its text and spine hidden by `visibility` so size never changes, and status climbs to the region frame when a box is too small to show it.

### Named Rules
**The Attention Rule.** A surface exists only if it shows something that needs the operator. Seat internals (sessions, notes, transcripts, plumbing) never get a surface, because every extra surface competes for attention.

## Elevation & Depth

Dark carries depth with surface lightness, not shadows: `well` below `ground`, `inset` for fields, `raise` and `raise-2` for panels, each a step of about 0.03 to 0.04 in OKLCH lightness. The canvas and everything on it is flat paint: borders, outlines, and one 1px box-shadow ring on a selected node, no blur, no gradient. Shadows appear only on surfaces that float above the canvas, and they return with more presence in bright, where paper needs them. Stacking is three systems, in order, from one source, `src/renderer/styles/layers.css`.

### Shadow Vocabulary
- **Modal lift** (`box-shadow: 0 24px 80px var(--color-shadow-1), 0 0 0 1px var(--color-overlay-1)`): the one card chrome for dialogs and operator modals (`.layer-frame`).
- **Popup lift** (`box-shadow: 0 10px 24px var(--color-shadow-2)`): anchored popups such as the mention list.
- **Focus halo** (`box-shadow: 0 0 0 3px var(--color-focus-ring)`): a focused field and the armed button. A halo, not depth.
- **Modal dim** (`background: var(--color-backdrop); backdrop-filter: blur(2px)`): the one dim behind every modal shell (`[data-layer-backdrop]`).

### Named Rules
**The Flat Canvas Rule.** Nothing on the canvas casts a blurred shadow. A node lifts 1px on hover with `transform`, and that is all the depth it gets.

**The Three Layers Rule.** Every overlay belongs to exactly one system: base (canvas, tabs, dock, bars), working (terminals, focus views, settings, dialogs from them) or operator (Cmd+K search, the Cmd+I needs-you feed, the agent switcher, above everything). A z-index of 100 or more is one of the `--layer-*` tokens (`lint:layers`), and an overlay renders through its layer's shell, never a hand-rolled portal or backdrop.

## Shapes

Small, even corners and hairline borders. The radius scale is `sm` 4px (list rows, key caps, xs buttons, mention chips), `md` 6px (buttons, fields, palette rows, callouts), `lg` 8px (palette hue marks), `xl` 12px (modal and dialog frames) and `pill` (node chips, status tags, toggles, progress tracks). Borders are 1px ink at alpha; status tags take 1.5px in their tone. A dashed `dim` border means a thing is not here in full: a peer seat, a stub copy on another machine, a retired file, a queued command. Text on the bare canvas wears a ground-colored halo (two 5px `text-shadow` layers of `ground`) instead of a backing plate.

### Named Rules
**The Whole Border Rule.** A border that carries state or a hue goes all the way round. State changes the whole border's color, the fill or the weight; it never paints one side. The only one-sided lines are neutral structure: layout dividers and the `stroke-hi` node spine, which never change color with state.

## Components

Familiar, quiet and exact: controls look like the controls of the best tools in the category, drawn in hairlines and ink alpha, with color only where state lives. New surfaces compose the primitives in `src/renderer/components/ui/`; nobody hand-rolls a button, header, status dot or help chrome.

### Buttons
- **Shape:** gently squared (`rounded-md`, 6px; xs uses 4px). Every button is hit across at least 24px of height through an invisible centred area, whatever its drawn size.
- **Chrome** (default): hairline `stroke` border, ink at 4 percent fill, `ink` text; hover lifts the fill to ink at 10 percent.
- **Primary:** amber at 35 percent border, amber at 18 percent fill, `amber-hi` text, 600 weight; hover fills to 26 percent. One per surface, never two.
- **Subtle:** no border, `dim` text; hover to `ink` on ink at 6 percent. Cancel and advanced toggles.
- **Danger:** crimson at 40 percent border, crimson at 10 percent fill, crimson text. Destructive only, sparingly.
- **Armed:** cyan at 60 percent border plus the focus halo, for a control waiting on the operator's next input (recording a shortcut).
- **Sizes:** xs (card chips, label type, uppercase), sm (chrome and dense toolbars, label type, uppercase, eyebrow tracking), md (dialog actions, body-lg type, sentence case).
- **Disabled:** 40 percent opacity. Prefer `aria-disabled` for a button that goes inert under the operator's own press, so focus stays.
- **Icon buttons:** `steel` at rest, ink at 10 percent fill on hover; 16, 24 or 28px.

### Chips and status tags
- **Node head chip:** 28px pill, `overlay-3` fill, 1px `stroke` border, a 15px glyph in the kind's hue, the name in body-lg 600 `ink`, a tabular count in body 600 `dim`. Hover: `stroke-hi` border. Selected: `main` border plus a 1px `main` ring with no blur.
- **Status tag:** a 22px pill 8px after the chip, 1.5px border in the tone, label type 700 uppercase in the tone's `-fg` word, and a shape before the word: triangle Blocked (crimson), filled circle Needs you (amber), open arc Working (cyan), hollow circle Off or Retired (faint). Idle shows nothing.
- **Label chips:** fill at 18 percent, stroke at 60 percent, word in `label-<name>-fg`.
- **Seat chips:** a seat named anywhere (mentions, combobox options, reviewers, assignees) wears its portrait, never a generic glyph.

### Cards and containers
- **Modal frame:** `raise` fill, 1px `stroke` border, `rounded-xl` 12px, the modal lift. Dialogs pad 18px 20px 16px.
- **Callout:** a full 1px border in its hue at 30 percent, a fill of the same hue at 8 percent, `rounded-md` 6px, padding 8px 12px. The canvas note is the reference (`src/renderer/components/nodes/spine-card.css`).
- **Canvas nodes are not cards.** Cards are glance and identity only, with no action buttons: open by double-click or kind keys, delete and Stop from the selection toolbar. The only on-card control is the task enqueue plus, a 20px ghost with a 24px hit area.
- **Spine:** a 1.5px `stroke-hi` rule 15px in from the chip, rows hanging from 11px ticks, at most four rows then a dim "+N more". Text on bare ground takes a ground-colored halo, not a wash.

### Inputs and fields
- **Style:** `inset` fill, 1px `stroke` border, `rounded-md` 6px, body-lg mono, `faint` placeholders. Dense fields are 28px tall at body size.
- **Focus:** border to cyan at 60 percent plus the 3px focus halo. Expanded selects take the same look.
- **Selects** are always the design-system Dropdown, never a native select.
- **Field labels:** uppercase eyebrow tracking in `dim`.

### Navigation and lists
- **List row:** 28px, `rounded-sm`, body 500 `ink` title with a tabular label-size `dim` meta. Hover `overlay-1`, selected `overlay-2`, focus the inset cyan ring, pending a dashed `stroke-hi` outline.
- **Tabs:** a segmented uppercase row; the shown tab is a tint and ink text, the rest `dim`.
- **Key caps:** cyan at 22 percent border, cyan at 6 percent fill, `cyan-fg` text, label size, `rounded-sm`; the md size is 22px wide and body size.

### Cmd+K command palette (signature)
The reference palette surface (`src/renderer/components/command-bar/CommandBar.tsx`, `.command-bar__*` in `src/renderer/styles.css`). A 700px operator modal anchored near the top, filling the window's height so the list never resizes as it filters. A 46px input row in body-lg with a hairline under it; rows padded 7px 10px with a 28px hue mark (hue at 30 percent border, 12 percent fill) beside a body-lg 500 title and a mono label-size detail in `faint`. The active row is an `overlay-2` tint, and its mark border rises to 60 percent. A footer under a hairline carries the count and key hints in label type.

### Focus
**The House Focus Ring Rule.** Keyboard focus is one mark everywhere: 2px of full-strength `cyan`. Outside with a 2px offset where there is room (`FOCUS_OUTLINE` in `src/renderer/components/ui/focus.ts`), inset as a 2px shadow where a clipping parent would cut it (`FOCUS_RING_INSET`). Canvas nodes ring the head chip at a 3px offset in screen pixels at every zoom. Selection (the 1px amber ring) and focus (the cyan outline) are always distinct. Only `src/renderer/lib/focus-ownership.ts` moves focus.

## Do's and Don'ts

**The No One-Sided Edge Rule.** Never mark state with one colored edge: no colored left, right, top or bottom border, no stripe, no one-side inset shadow on a selected row, a tab, a card or a callout. Show state with a full border, a background tint, weight, or an icon. A selected row is an `overlay-2` tint, as in Cmd+K. A callout is a full 1px border in its hue at about 30 percent plus a tint at about 8 percent. Neutral hairline dividers and quote rules are structure, not state, and stay. A colored one-side line that is not state on a row, card or callout is kept by name: the text caret, a spinner arc, a link or mention underline. `tests/one-sided-accent-border.test.ts` is the lock, and its kept list is the only place an exception lives.

**The Copy Law.** No middle dot (U+00B7) on any surface: product copy, UI strings, generated documents, artifacts. Separate with commas, em dashes or spaces. Derived wire sentences read as spoken compounds ("access stops", "watch completes").

**The Motion Law.** Never slow, step, throttle or still a moving animation anyone can see to save frames, GPU or power. Motion runs on the compositor: seat rings turn and pulse every display frame with `transform` and `opacity` only, still parts baked once into the atlas (`src/renderer/lib/activity-atlas.ts`). Motion no one can see (hidden window, reduced motion, a ring under an opaque surface or off screen) may stop. Only the operator changes motion. `tests/motion-law.test.ts` is the lock.

### Do:
- **Do** show a selected row with the `overlay-2` tint and a hovered row with `overlay-1`.
- **Do** build a callout as a full 1px border in its hue at 30 percent plus the same hue at 8 percent fill.
- **Do** pair every status color with a shape and a word: triangle Blocked, filled circle Needs you, open arc Working, hollow circle Off.
- **Do** use the six type steps (10, 11, 12, 14, 18, 24px) and the mono voice by default.
- **Do** draw hues as text with their `-fg` token and as marks with their base token.
- **Do** keep state transitions at 120 to 220ms on an exponential ease out (`cubic-bezier(0.22, 1, 0.36, 1)` is the house curve).
- **Do** give every button at least a 24px hit height and every control the 2px cyan focus ring.
- **Do** render overlays through their layer's shell (`FocusSurface`, `Dialog`, `Popover`, `Dropdown`, `OperatorModalShell`) and stack with `--layer-*` tokens.
- **Do** draw a seat with its portrait wherever it is named.
- **Do** design bright as its own daylight edition on warm paper, with its own values in `semantic.ts`.

### Don't:
- **Don't** put a colored left, right, top or bottom border, a stripe, or a one-side inset shadow on a selected row, card, tab or callout.
- **Don't** use a middle dot (U+00B7) anywhere, in copy, UI strings, docs or artifacts.
- **Don't** slow, step, throttle or still visible motion, and don't animate a ring with anything but `transform` and `opacity`.
- **Don't** use `micro` (8px) or `caption` (9px) in new work, and don't introduce a 13px or any raw pixel size.
- **Don't** put action buttons ("open", "stop", "detach", form CTAs) on a canvas node.
- **Don't** use crimson for anything but blockers, failures, refusals and destructive actions.
- **Don't** let color alone carry status.
- **Don't** use pure black or pure white for a surface, or a grey for a stroke; strokes are ink at alpha.
- **Don't** hardcode a hex, rgba or OKLCH value in a component, or add a second palette.
- **Don't** give a canvas node a blur shadow or a gradient.
- **Don't** add a backdrop, a window Escape listener or a raw z-index of 100 or more to a surface.
- **Don't** use a native select, JSX `autoFocus`, or a generic robot glyph for a seat.
- **Don't** explain mechanics in operator copy: no ports, grants, masks, compiles or wire families. Say what the operator can do, or say nothing.
- **Don't** put two primary amber buttons on one surface.
