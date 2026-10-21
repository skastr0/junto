# Canvas node language: Spines

The operator picked this on 2026-10-21 (signal 01M5FN69YB247G9B44AQ38WNB3),
after withdrawing two box-based directions. It applies to every non-seat node:
task, artifacts, automations, page, terminal, git, file, link, note, label,
peer and stub. Seats (agent) do not change.

## The idea

There are no cards. A node is one chip, and whatever it holds hangs from the
chip on a thin spine, like an outline. The ground shows through. The chip is
the same chip language as a mention (ResourceChip), so a thing reads the same
in a comment, a list and on the canvas.

## Anatomy (near)

**Head chip.** One line, 28px tall, pill radius, padding `0 11px 0 9px`, gap
7px. Fill `--color-overlay-3`, border 1px `--color-stroke`.
- Glyph 15px, in the kind's hue (the hue is a mark, never a word). In bright,
  the amber and cyan glyphs (Automations, Link) use `--color-amber-fg` and
  `--color-cyan-fg`; the mark forms are under 3:1 there.
- Name, mono 13px, weight 600, `--color-ink`.
- Count, mono 11px, weight 600, `--color-dim`, tabular. Tasks: every task on
  the board, backlog included. Artifacts: live artifacts. Automations: all.
- Hover: border `--color-stroke-hi`. Selected: border `--color-main` plus a
  1px `--color-main` box-shadow ring (no blur). Focus: 2px `--color-cyan`
  outline, offset 3px, in screen pixels, following the chip's pill radius.

**Status tag.** Only when the status is notable, 8px after the chip: a 22px pill,
1.5px border in the status tone, text 10px weight 700 uppercase with `.04em`
tracking in the tone's `-fg` token, and a shape mark before the word.

| Status | Word | Shape | Tone |
|---|---|---|---|
| blocked | Blocked | triangle | crimson |
| needs the operator | Needs you | filled circle | amber |
| working | Working | open arc | cyan |
| off or retired | Off, Retired | hollow circle | faint |

Idle shows nothing. Status is a shape and a word at every tier, never colour
alone.

**Spine.** Starts 15px in from the chip's left edge, 6px below it: a 1.5px
`--color-stroke-hi` left rule. A blocked or needs-you node's spine is 2px in
its tone. Each row hangs from it by an 11px tick, padding-left 16px, gap 7px,
mono 11px `--color-ink-2`, glyph 12px `--color-dim`. The first row is the
meta line, 10.5px `--color-dim`. At most four rows, then a dim `+N more` row.
A seat mentioned in a row is a ResourceChip with its portrait.

**Leaf nodes** (page, terminal, git, file, link, peer, stub) are a chip alone,
with one dim 10.5px line after it, and no spine.

**Note and label have no chip.** A note is typeset text: a 3px
`--color-amber` left rule, 12px left padding, title 14px weight 600, body 11px
at 1.55 in `--color-ink-2`. A label is bare display type, 22px weight 700,
`--font-display`.

**Peer** is a chip with a 20px portrait disc (the portrait fallback, drawn from
its name) in place of the glyph, a dashed border (`--color-dim`, so the dash shows in dark) and no fill, then
"seat on <machine>". **Stub** is its kind's chip with the same dashed border
and no opacity change (full contrast for its text), then "<kind> on <machine>".
Every dashed border (peer, stub, retired) uses `--color-dim`, not `--color-stroke`.

Text sits on the bare ground, with wires behind it, so names and rows take a
ground-coloured halo (`text-shadow` of `--color-ground`, two 5px layers)
instead of a wash. Measure it; if it costs raster at hundreds of nodes, use
`paint-order` stroke instead.

## What each kind shows

| Kind | Chip | Spine and line | Status |
|---|---|---|---|
| Tasks | list glyph (green), name, count | meta "1 backlog, 0 open, 0 done"; rows `#n title` with a state glyph (backlog dashed circle, blocked, needs you), needs-you and blocked first | Blocked when a seat waits on input; Needs you when the operator owes a stamp (a task in review that lists the operator as a reviewer with no current operator stamp) |
| Artifacts | package glyph (violet), name, count | meta "N artifacts"; rows type glyph and title | none |
| Automations | workflow glyph (amber), name, count | meta "N on, N off"; rows on dot or off hollow, name, trigger in words (weekdays 09:00 UTC) | Failed (triangle, blocked tone) when any automation's last firing failed, read from the one list read the card already makes (the list carries each automation's last outcome; no per-automation read, so it holds at far); else Off when all are off. Failed wins over Off |
| Page | globe (indigo), the host (stable while seats navigate; the full URL is the hover title) | line "browser page, <profile>"; on a failed load or a refused operator action, the error replaces the line | Working while a seat drives it; Failed (blocked tone) on a failed load or refusal; no tag while the operator holds the page or while it loads |
| Terminal | prompt glyph, name | line: the command | Working while live |
| Git | branch glyph (orange), name | line: `HEAD <subject>` | none |
| File, link | file or link glyph, name | line: the path tail or host | Retired (dashed chip, the word, not 55 percent opacity) |
| Note, label | none | typeset text | none |

The task enqueue "+" stays the one allowed on-card instrument (card law): a
20px ghost button at the right end of the task chip, with a 24px hit area.

## Far zoom

The chip becomes a held disc. Text and spine hide. Size is `max(26 screen px,
natural)` from one CSS variable written once per zoom (`--s`, the inverse
scale), never a per-node style. Non-seat discs scale with zoom to that floor
and do not join the seat ring-room solve; clusters stay seats only.

- Disc: border 1.5 screen px at ink 55 percent (at least 3:1 on the ground in
  both themes; verify), glyph 14 screen px at ink 78 percent.
- Status pip at the top right, 11 screen px with a ground outline (triangle 15
  by 13), so blocked and needs-you survive far. A blocked or needs-you disc
  also takes its tone as the border, 2 screen px. This replaces
  `border-color: transparent !important` in `canvas-lod.css`.
- Notes keep a 10 by 26 screen-px amber tick; labels floor at 13 screen px.
- A disc never paints past its node's box: the 26 screen-px floor applies only down
  to the box size, so it never touches a seat ring the ring-room solve placed
  beside it. Where a box is too small to show a disc (overview), the status
  goes up to the region: non-seat nodes (a blocked or needs-you task board, a
  failed automation, a failed page) publish into the same urgency feed that
  seats use, so the region frame leans to their state too. The frame shows the
  worst state only (blocked over needs-you over review), as it does today, and
  at overview only the outer region's held tint shows for nested regions.

## Names, focus and keys

The focusable element is the React Flow wrapper (`.react-flow__node`, tabindex
0), which now takes in the chip, the spine and the rows. The wrapper keeps
`outline: none`; `.react-flow__node:focus-visible` draws the ring instead.
- The ring is on the head chip only: `outline: calc(2px * var(--s)) solid
  var(--color-cyan)`, offset `calc(3px * var(--s))`. `--s` is defined at near
  too (1 at 100 percent), so the ring is the same in screen pixels at every zoom.
- Note and label have no chip: the ring goes around the text block, radius
  `--radius-sm`, same width and offset.
- At far the ring follows the disc (round, not the chip radius), is 2 screen px,
  and sits outside the 2 screen-px blocked or needs-you border, so focus never
  hides the status tone.
- The task enqueue plus is a real tab stop inside the node (Tab goes node,
  plus, next node): `aria-label` "Add a task to <name>", its own cyan
  focus-visible ring, and full opacity on focus-visible, not only on hover.
- Spine rows are not tab stops and take no keys in 0.10; do not add per-row
  buttons. Cmd or Ctrl+Enter on the node opens it, as now. Tab order stays the
  DOM order of nodes.
- Selection (main ring, 1px) and focus (cyan outline, offset) stay distinct.
  The cyan Working tag is a pill beside the chip, never an outline.

## Names and access

Screen reader name is `<name>, <kind>, <status>` (a string change in
`flow-nodes.ts`, no render cost). The visible chip and tag say the same words.
- Kind is the visible kind word: Tasks, Artifacts, Automations, page, terminal,
  git, file, link, note, label.
- Status is the tag word and is omitted when idle: no trailing comma, never the
  word "idle". Failed and Off (Automations) and Retired (file, link) are
  statuses too.
- Peer reads `<name>, seat on <machine>`; stub reads `<name>, <kind> copy on
  <machine>`; a note or label is named by its first line.
Focus ring as above, drawn in screen pixels and following the chip radius.
Words use the `-fg` colour tokens; marks use the mark forms.

## Cost and law

- Flat paint only: borders, outlines, one 1px box-shadow ring on select. No
  blur shadow, no gradient. This removes today's 28px shadow.
- Motion: only the working arc may turn, on the compositor
  (transform and opacity), one layer, as a seat ring does. Never slowed.
- Tiers hide by `visibility`, so size never changes. Memo by CARD_FACTS; read
  each field alone. The status word reads one field per node.
- Keep `::before` and `::after` of `.react-flow__node` free (reach preview).
- Tokens only (`lint:design-tokens`), no middle dots, no new hue.

## Build order

1. NodeShell (product-shell): chip, tag, spine, leaf, far disc, ring, the name
   string; move the inline paint (`NodeShell.tsx:423-472`) to CSS tokens.
2. Per kind, in parallel by owner: Tasks (product-modals), Artifacts
   (product-shell), Automations (product-settings), Page (product-attention),
   terminal, git, file, link, note, label, peer and stub (product-shell).
3. Review by a teammate who did not write it, plus product-typography on look.
   Verify: canvas-window reruns its baseline (near 114 rest fps and 98 pan,
   30 layers, no added layers at far); product-keyboard checks ring and tab
   order; product-accessibility checks names and contrast.

The mockup frames for the pick (dark and bright, near and far, direction D)
are attached to the operator signal above.
