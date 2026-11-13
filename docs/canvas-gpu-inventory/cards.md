# Canvas cards, zoom tiers, motion and the design system: what is drawn today

Read-only; nothing in the tree was changed. Every receipt is relative to the repository root. Aliases: `W/` = `src/window/`, `C/` = `src/window/components/`, `N/` = `src/window/components/nodes/`, `L/` = `src/window/lib/`, `S/` = `src/window/styles/`, `SH/` = `src/shared/`, `T/` = `src/shared/theme/`. "Computed" = my arithmetic from quoted constants. "Inference" = read off selectors or cascade, not run.

Five things to know first:
- **The doc and the code disagree.** `docs/node-card-language.md:3-6` says every non-seat kind is a Spines card. In code only peer and stub draw `SpineCard`; note and label share the spine shell; eight kinds plus non-image files draw `KindSeat`, the seat's own ring language (`N/TextNode.tsx:66-77`, `SH/node-geometry.ts:24-43`, `N/SpineCard.tsx:174-189`). This report follows the code.
- **No linear RGB export exists.** `T/oklch.ts:41-55` computes linear values as locals and returns clamped sRGB hex; `themeRuntime(mode)` returns hex and `rgba()` strings (`T/index.ts:84-97`).
- **No font is loaded.** The three stacks are system fonts; there is no `@font-face`, `FontFace` or font file under `src` (grep), and `W/styles.css:1906-1910` says no webfont ships.
- **Shadow, motion duration and border width have no tokens** (`T/index.ts:31`); every such value below is a literal in CSS or TSX.
- **Rings are a sprite atlas, not live drawing**: painted once per theme with canvas 2D, served as a PNG data URL, animated by CSS on child elements (`L/activity-atlas.ts:320-338, 355-379`).

## 1. Node kinds to card types

`flowType`: region gives `group`, file gives `file`, link or page gives `link`, everything else `text` (`L/flow-nodes.ts:85-86`). Registry: `nodeTypes = { text: memo(TextNode, sameCard), file: memo(FileNode, sameCard), link: memo(LinkNode, sameCard), group: memo(GroupNode, sameCard) }` (`N/index.ts:13-18`). `sameCard` compares id, selected, `canvas, id, kind, blocked, regionDepth` and `nameSlot` (`L/flow-identity.ts:99, 108-114`).

| Kind | RF type | Component chain | Language | Size | Resizer | Connect handles |
|---|---|---|---|---|---|---|
| agent | text | TextNode > NodeShell > SeatCard > AgentSeat > AgentSeatView (`N/TextNode.tsx:466-506`) | agent seat | fixed 216 x 56 | no | yes |
| terminal | text | TextNode > NodeShell > TerminalCard > KindCard > KindSeat (`C/terminal/TerminalCard.tsx:180-197`) | kind seat | fixed 216 x 56 | no | yes |
| task | text | TasksCard > KindCard (`C/work/WorkSurfaces.tsx:103-171`) | kind seat | fixed | no | yes |
| artifacts | text | ArtifactsCard > KindCard (`C/work/WorkSurfaces.tsx:174-187`) | kind seat | fixed | no | yes |
| automations | text | AutomationsCard > KindCard (`C/automations/AutomationsCard.tsx:42-73`; imported at `N/TextNode.tsx:45`) | kind seat | fixed | no | yes |
| git | text | GitCard > KindCard (`C/git/GitCard.tsx:66-91`) | kind seat | fixed | no | none |
| files | text | FilesCard > KindCard (`C/files/FilesCard.tsx:123-171`) | kind seat | fixed | no | none |
| page | link | LinkNode > NodeShell > PageCard > KindCard, only when `BROWSER_ENABLED`; otherwise the link branch (`N/LinkNode.tsx:41, 59-99`) | kind seat | fixed | no | yes |
| link | link | LinkNode > NodeShell > `KindCard kind="link"` (`N/LinkNode.tsx:93-99`) | kind seat | fixed | no | yes |
| file, not an image | file | FileNode > NodeShell > `KindCard kind="file"` (`N/FileNode.tsx:119-125`) | kind seat | fixed | no | yes |
| file, image | file | FileNode > NodeShell > `button.file-node-image` > ContentMedia (`N/FileNode.tsx:39-115`) | default card shell | stored | yes | yes |
| note | text | TextNode > NodeShell `look="spine"` > `.note-surface` > NoteMarkdown (`N/TextNode.tsx:510-540`) | note callout | stored | yes | yes |
| label | text | TextNode > NodeShell `bare`, `look="spine"` > `.label-surface` (`N/TextNode.tsx:384-414`) | bare label | stored | yes | none |
| peer | text | PeerCard > SpineCard (`N/RemoteNodeCards.tsx:14-28`) | spine card | stored | yes | yes |
| stub | text | StubCard > SpineCard (`N/RemoteNodeCards.tsx:30-57`) | spine card | stored | yes | yes |
| region | group | GroupNode (`N/GroupNode.tsx`) | region | stored | min 320 x 180 | none |

- Fixed size: `AGENT_NODE_SIZE = { width: 216, height: 56 }` for every kind where `holdsSeatRing` is true (agent, the eight `KIND_SEAT_KINDS`, non-image file); stored size otherwise (`SH/node-geometry.ts:12, 24-50`). `NOTE_NODE_SIZE = { width: 220, height: 84 }` (`SH/node-geometry.ts:53`); where it is applied: not read.
- `resizable={!holdsSeatRing(kind)}`; `showHandles` false for label, git, files; `SPINE_KINDS = peer, stub, note, label` (`N/TextNode.tsx:72-77, 275-288`). `connectable` false for region, label, git, files; regions not selectable or draggable (`L/flow-nodes.ts:237-241`).
- Stacking: `REGION_Z_BASE = 0`, `CARD_Z = 32`; `zIndex: region ? 0 + depth : 32` (`L/flow-nodes.ts:17-18, 235`). Agent nodes carry the class `junto-flow-agent` (`C/Canvas.tsx:128-133`).
- `data-node-kind` is `kindWord(kind)`: note gives "text", region gives "group" (`L/model-kind.ts:29`).
- Paint order is `z`, then id (`L/convert.ts:46-66`).

## 2. What each card draws

### 2.0 The shared shell (NodeShell)

- Root `.junto-node group relative flex h-full w-full flex-col overflow-visible`, plus nothing (spine), `junto-node--bare rounded-sm px-1 py-0.5` (bare) or `rounded-[10px] px-3.5 py-3` (card); `junto-blocker` when blocked and not spine (`N/NodeShell.tsx:460-466`). Attributes `data-look`, `data-node-kind`, `data-bare`, `data-blocked`, `data-seat-attention`, `data-overseer`, `data-occupancy`, `data-attention` (`N/NodeShell.tsx:467-478`).
- Inline paint only when the look is not spine (`N/NodeShell.tsx:481-489`):
  - Border `1px solid`: blocked `HUE.crimson`; attention amber at 0.52; else `borderColor(color, selected)`; selected `withAlpha(crimson or accent, 0.75)` (`N/NodeShell.tsx:432-440, 481-489`). `borderColor`: no colour gives stroke or stroke-hi, a palette colour gives the accent at 0.32 or 0.5, a custom hex is used as stored (`L/theme.ts:74-78`).
  - Background: default `linear-gradient(135deg, raise 94%, ground 96%)`; blocked `linear-gradient(135deg, crimson 0.12, ground 92%)`; attention `linear-gradient(135deg, amber 0.09, ground 96%)` (`N/NodeShell.tsx:441-447`).
  - Shadow: default `0 10px 28px var(--color-shadow-2)`; selected `0 0 0 1px <crimson or accent> 0.25, 0 12px 30px var(--color-shadow-2)`; blocked `0 0 0 1px crimson 0.18, 0 10px 28px shadow-2`; attention `0 0 0 1px amber 0.14, 0 10px 28px shadow-2` (`N/NodeShell.tsx:448-458`).
- Agent and kind seat shells override border, background and shadow with `!important` (2.1, 2.2), and spine looks get no inline style. Inference: the default card paint above reaches the screen only on image file nodes.
- `.junto-node { transition: border-color .18s ease, box-shadow .18s ease, transform .16s ease; }`, hover `translateY(-1px)`, none when bare or dragging (`S/seat-card.css:4-7`).
- Body clipped for cards, unclipped for spine (`N/NodeShell.tsx:534-540`).

### 2.1 Agent seat

| Element | Size and position | Text or image, and source | Paint |
|---|---|---|---|
| Shell | 216 x 56; `border-radius: 28px 14px 14px 28px`; `padding: 1px 10px 1px 1px` | none | border transparent, `background: color-mix(in oklab, var(--color-ground) 72%, transparent)`, no shadow, all `!important` (`S/factory-grammar.css:15-21`) |
| Row | `junto-seat flex h-full w-full items-center gap-2` (`N/AgentSeatView.tsx:133-138`); gap 8px (Tailwind default, not read from the repo) | | |
| Ring | 52 x 52 atlas cell (`--mark-u: 52px`, `L/activity-atlas.ts:386`); ring radius 7.2 and stroke 1.1 in a 20-unit box (`L/activity-rings.ts:38-39`), so 18.72px and 2.86px at 52px (computed) | ring chosen by `ringState` from control state, trouble reading, health and signal (`SH/wire/rings.ts:178-229`) | atlas pixels in five tones |
| Glow, halo, flag band | one atlas cell on the mark's `::before`, full box (`L/activity-atlas.ts:393`) | glow: two rings at `RING_R + 1.2` and `+ 2.2`; halo: ring at `RING_R + 1.9` width 0.55 alpha 0.75, a four-point spark when exceeding; flag: disc `FLAG_R = 1.9` at angle `-pi/4` on radius `RING_R + 0.9`, a knocked-out bar when blocked (`L/activity-rings.ts:388-471`) | flag tones: blocked crimson, escalate amber, feedback cyan, work amber, notice steel (`SH/wire/rings.ts:123-129`) |
| Portrait | 34px round `<img>` centred in the ring's hole (`SEAT_PORTRAIT_PX = 34`, `N/AgentSeatView.tsx:15, 152-158`; `.junto-mark__seat` grid, `L/activity-atlas.ts:395`) | SVG data URI from `portraitDataUri({ seed, mode, detail, frame, config, face })`, cached, limit 4000 (`C/AgentPortrait.tsx:39-59`); detail "card" at 34px (`SH/agent-portrait.ts:37-38`); expression from `mood` (`C/AgentPortrait.tsx:113-115`) | `outline={false}`: the ring is its edge |
| Harness badge | in `.junto-mark__over`, over the ring's parts; size `min(26, max(11, round(size * 0.42)))` = 14, offset `round(size * (0.5 + SQRT1_2 / 2) - badge / 2)` = 22, radius `round(badge * 8 / 28) + 1.5` = 5.5 (formulas `C/AgentPortrait.tsx:177-186`; values computed) | HarnessMark: vendor image, SVG paths, monogram or prompt glyph (`C/HarnessMark.tsx:30-108`) | plate `var(--color-raise)` with `0 0 0 1.5px var(--color-raise)` (`C/AgentPortrait.css:17-23`); tile fill hue at 0.14 or 0.1, border 1px hue at 0.28 |
| Overseer crest | `left: 50%; top: 0; width: 30%; height: 21%; min-width: 9px; min-height: 6px; transform: translate(-50%, -4%)` (`L/activity-atlas.ts:400`) | SVG `viewBox="0 0 16 11"`, path `M2 9.5V3.2l3.3 2.6L8 1.2l2.7 4.6L14 3.2v6.3Z` (`C/ActivityMark.tsx:228-236`) | fill `var(--color-indigo)`, `stroke: var(--color-ground); stroke-width: 1.6px; paint-order: stroke` (`L/activity-atlas.ts:400-401`) |
| Name | `truncate font-mono text-[13px] font-semibold leading-snug`, native `title` (`N/AgentSeatView.tsx:28-34`) | node label | `color ? accentColor(color) : INK` (`N/SeatCard.tsx:135`) |
| Line | one line: `max-h-[1lh] overflow-hidden text-[10.5px] leading-snug`, inner `block truncate` (`N/AgentSeatView.tsx:163-166`) | `seatSaying` order: signal, failure, AI reading, control state (`L/seat-line.ts:65-89`) | signal word in its tone, semibold, then dim text (107-115); failure amber-fg (116-117); AI reading with prefix "AI" in `font-display text-[9px] tracking-[0.12em] text-faint`, text dim, faint when stale (118-125); cache status (126-127); else tone or dim (128-130), all `N/AgentSeatView.tsx` |
| Task strip | `seat-task flex items-center gap-1 truncate text-caption leading-snug` (`N/SeatTaskStrip.tsx:16-32`) | TaskStateMark, task number (tabular), title (truncate), `+N`; only when `TASKS_ENABLED` (`N/SeatCard.tsx:162`) | INK |
| Preamble bubble | `bottom: calc(100% + 9px); left: calc(7px + var(--pre-dx))`, `max-width: 272px`, `z-index: 30`; node with a bubble `z-index: 1001 !important` (`N/preamble-bubble.css:11-37`) | speaker word (AI, Junto, you), a lucide glyph per action, current line clamped to 2 lines, previous line at opacity 0.5 (`N/PreambleBubbleView.tsx:27-46, 134-183`; `N/preamble-bubble.css:123-134, 169-179`) | padding `6px 6px 6px 9px`, radius 10px, border `color-mix(in oklab, var(--pre-hue) var(--pre-mix), var(--color-stroke))`, background `color-mix(in oklab, var(--pre-hue) var(--pre-wash), var(--color-raise))`, shadow `0 6px 18px var(--color-shadow-2)`, 9px rotated-square tail (`N/preamble-bubble.css:54-87`) |

- Control state words: "done, not read yet", the attention text, "starting up", "running <process>", "resting", "ready", "stopped", "not running" (`L/seat-line.ts:20-49`).
- Seat wrapper `factory-agent-card relative flex h-full w-full flex-col justify-center overflow-hidden` with `data-exit-reason`, `data-machine-state`, `data-seat-complete`, `data-overseer` (`N/SeatCard.tsx:143-149`). No CSS rule selects those four attributes (grep over `src/**/*.css`; `S/canvas-lod.css` read separately).
- A mark with a portrait has no hub: the hub disc (`inset: 33%`, `var(--mark-hub)`) is drawn only when the mark has no children (`C/ActivityMark.tsx:379`, `L/activity-atlas.ts:389`).
- Accessible name and native `title` on the ring: the state, prefixed "Overseer, " with a crest (`C/ActivityMark.tsx:377-378, 400-401`).

### 2.2 Kind seat (terminal, task, artifacts, automations, page, git, files, link, non-image file)

| Element | Size and position | Source | Paint |
|---|---|---|---|
| Shell | 216 x 56; `border-radius: var(--radius-pill) var(--radius-xl) var(--radius-xl) var(--radius-pill)`; `padding: 1px 10px 1px 1px` | selector `.junto-node:has(.kind-seat):not([data-bare])` | border transparent, ground 72%, no shadow, `!important` (`N/kind-seat.css:133-139`) |
| Row | `junto-seat kind-seat flex h-full w-full items-center gap-2`, `data-kind`, `data-state` (`N/KindSeat.tsx:106`) | | |
| Ring | 52px, `ActivityMarkFromSpec spec={kindRing(state)} size="seat"` (`N/KindSeat.tsx:107`) | `kindRing`: working wave cyan; waiting and review wave amber "needs you"; blocked wave crimson; done pulse green; offline static steel glyph off; else static steel "idle" (`N/KindSeat.tsx:18-34`) | atlas |
| Ledger band | `.kind-band` of `<i class="kind-band__layer">` layers, each an SVG data URI with `viewBox='0 0 52 52'`, `background-size: 100% 100%` (`N/KindSeat.tsx:108-118`, `N/kind-seat.css:17-22`, `L/kind-band.ts:242-243`); band radius `R = 24.1`, width `W = 2.3` in `BAND_BOX = 52` (`L/kind-band.ts:57-60`) | still layers plus at most one moving layer (`L/kind-band.ts:6-12`); track `arc(0, 359.9, ink 0.1, w 1.6)` (123) | hues per kind from `themeRuntime(mode)` (`L/kind-band.ts:85-100`) |
| Icon | `img.kind-icon` 34 x 34, round (`N/KindSeat.tsx:119`, `N/kind-seat.css:5-9`) | `kindIconSrc(kind, mode, 34)`: SVG data URI, round tile `r=50`, halo `cx=50 cy=46 r=39`, shapes on a 100 x 100 viewBox; detail tier 1 at 34px, outline 3, misregistration offset 1.4 (`SH/kind-icon.ts:62-126, 138-165`) | colours derived from theme tokens through `hexToOklch` and `oklchToHex` at fixed lightness per mode (`SH/kind-icon.ts:28-48`) |
| Name | `SeatName`, mono 13px 600, truncate (`N/KindSeat.tsx:123`) | per kind, below | `var(--color-ink)` |
| Line | `max-h-[1lh] overflow-hidden text-label leading-snug`, `block truncate`, native `title={lineTitle}` (`N/KindSeat.tsx:126-130`) | per kind | `text-cyan-fg` working, `text-amber-fg` waiting or review, `text-crimson-fg` blocked, `text-green` done, `text-faint` offline, `text-dim` else (`N/KindSeat.tsx:37-53`) |

Status to state: blocked or failed gives blocked; needs-you gives waiting; working gives working; off or retired gives offline; else done when `done`, else resting (`N/KindSeat.tsx:56-74`).

| Kind | Name | Line | Status passed | Band layers | Moving layer | `--kind-hue` |
|---|---|---|---|---|---|---|
| task | `taskBoardTitle` | `body.meta` (`tasksCardBody` not read) | body status; `done` when `count > 0 && finished === count` | arcs by counts with 4 degree gaps, finished at 0.45 opacity, backlog dashed `0.1 4.6`, hot arcs w 3.2 (`L/kind-band.ts:129-150`) | pulse waiting or blocked, chase working, glint done | green |
| artifacts | `titleOf(node)` or "Artifacts" | "1 artifact" or "N artifacts" | none | up to 24 ticks (151-166) | newest tick pulse waiting, shimmer working, ripple done | violet |
| automations | `titleOf(node)` or "Automations" | `facts.meta` (`L/automations-card.ts` not read) | `facts.status` | up to 8 dots: on r 3, off ring r 2.7 stroke 1.5, failed crimson (167-188) | pulse, shake, or clock hand | amber |
| page | host | error, or "browser page, <profile>" | failed on error, working when a seat drives it (`C/browser/PageCard.tsx:37-39, 57-66`) | up to 6 tab arcs, 8 degree gaps (189-202) | scan, pulse | indigo |
| terminal | not pinned in my notes | subtitle, plus " on <machine>" when remote, or the attention reason (`C/terminal/TerminalCard.tsx:163-165, 194`) | blocked, needs-you, working (141-147) | arc 14 to 346 plus a 6 x 4.2 cursor rect (203-211) | blink or blink-fast | steel |
| git | first line of label, or "git" | error, or `<branch or "reading"> <↑ahead ↓behind> <sha7 subject or "no commits">` (`C/git/GitCard.tsx:66-91`) | "off" on error | beads at 20, 100, 170, 230 and a head at 300 (212-219) | pulse or orbit | orange |
| files | `titleOf(node)` | drop notice, count line, unreachable line, or `node.root` (`C/files/FilesCard.tsx:123-171`) | "off" on failure or offline | arc 20 to 290 (220-225) | breathe | blue |
| file | base name | `pathTail(path)`, title = path (`N/FileNode.tsx:119-125`) | none | arc 20 to 290 | breathe | gold |
| link | host, or "retired link" | `hostAndTail(url)` ("host/…/last"), or host (`N/LinkNode.tsx:18-27, 93-99`) | none | two arcs (226-230) | pulse | cyan |

- `--kind-hue` table: `N/kind-seat.css:122-131` (it also lists note gold). Task trailing instrument: `button.tasks-enqueue`, 20 x 20, pill, `Plus size={11} strokeWidth={2.25}`, colour `--mark` amber, hover `var(--color-overlay-2)` and ink (`C/work/WorkSurfaces.tsx:103-171`, `C/tasks/tasks.css:443-480`). Terminal carries a `SeatTaskStrip` child (`C/terminal/TerminalCard.tsx:180-197`).
- Files drop target: `[data-drop]::after`, `inset: 2px`, radius-md, `outline: 1px dashed` cyan, fill cyan 8% (`C/files/files-card.css:6-23`).
- Unbound fallbacks are plain text: "page unbound" `text-xs text-faint` (`C/browser/PageCard.tsx:51-53`), "unbound terminal" `text-body text-dim` (`C/terminal/TerminalCard.tsx:156-160`).

### 2.3 Spine card (peer and stub only)

DOM: `.spine-card[data-status][data-tone]` > `.spine-head` > `.spine-chip[data-dashed][data-hue]` (glyph or portrait, name, count, trailing, pip) and `.spine-tag`; then `.spine-leaf`; then `ul.spine` of meta, rows, `+N more` (`N/SpineCard.tsx:192-243`). `SPINE_ROWS_MAX = 4` (72).

| Element | Rule | Receipt |
|---|---|---|
| Card | `width: max-content; max-width: max(100%, 320px)`; halo `--spine-halo: 0 0 5px var(--color-ground), 0 0 5px var(--color-ground)` (a text-shadow); shell paints nothing, `container-type: size` | `N/spine-card.css:9-36` |
| Chip | height 28px, gap 7px, padding `0 11px 0 9px`, `1px solid var(--color-stroke)`, pill, `var(--color-overlay-3)`, ink; dashed variant `1px dashed var(--color-dim)`, transparent | 48-68 |
| Glyph | 15px lucide SVG; strokes green, violet, amber-fg, indigo, orange, cyan-fg, steel, dim by `data-hue` | 95-107 |
| Name | mono, `--text-body-lg`, 600, leading-compact, nowrap, ellipsis, native `title` | 109-118 |
| Count | dim, mono, `--text-body`, 600, tabular-nums | 120-127 |
| Status tag | height 22px, gap 5px, padding `0 8px 0 7px`, `1.5px solid`, pill, `--text-label`, 700, tracking-soft, uppercase, halo; 8px shape: triangle by `clip-path: polygon(50% 0, 100% 100%, 0 100%)`, dot, arc and ring with 1.5px border (arc's right side transparent) | 143-195 |
| Leaf | `max-width: min(100%, calc(100cqw - 15px))`, margin `5px 0 0 15px`, dim, mono, `--text-label`, ellipsis, halo; tail form truncates at the head with `direction: rtl` and a `<bdi dir="ltr">` | 201-218 |
| Spine rows | margin `6px 0 0 15px`, padding `3px 0 2px`, `border-left: 1.5px solid var(--color-stroke-hi)`; rows padding-left 16px with an 11px tick of 1.5px; row ink-2 `--text-body`; meta dim `--text-label`; 12px dim mark | 222-302 |

- Status shapes: blocked and failed triangle crimson; needs-you dot amber; working arc cyan; off and retired ring faint (`N/SpineCard.tsx:43-57`).
- Peer: dashed chip, 20px portrait disc (margin-left -4px, `1px dashed var(--color-dim)`, ink-2, mono `--text-label` 700) holding the first letter, leaf "seat on <machine>" (`N/RemoteNodeCards.tsx:14-28`, `N/spine-card.css:381-393`).
- Stub: dashed chip inside `.spine-stub { opacity: 0.72 }`; glyph and hue by kind (file FileText dim, link Link2 cyan, git GitBranch orange, page Globe indigo, files FolderTree dim); leaf "<kind> copy" or "<kind> on <machine>" (`N/RemoteNodeCards.tsx:30-57`, `N/spine-card.css:395-397`).

### 2.4 Note

- Callout: body padding `8px 12px`, `1px solid color-mix(in oklab, var(--color-amber) 30%, transparent)`, radius-md, fill amber 8%; text ink-2, `--text-body`, leading-open, ground halo text-shadow; first heading ink, `--text-title`, 600 (`N/spine-card.css:403-421`).
- Content is rendered markdown with no HTML injection: headings 1 to 3, paragraph, list, fenced code, quote, hr, image; inline code, strong, em, link, image (`L/note-markdown.tsx:7-26`). Empty note says "empty note" (247-310).
- Typography literals: `.note-md` 12px, line-height 1.55, `font-feature-settings: "ss01" 1, "zero" 1` (`W/styles.css:1929-1935`); headings font-display 600, `text-wrap: balance`; h1 14px 700 0.06em uppercase; h2 12.5px 0.05em; h3 11px 500 0.08em uppercase dim (1948-1970); on canvas the first heading is overridden to mono 13px 600 with no rule (`S/factory-grammar.css:36-45`); lists with an en dash marker and `counter()` ordinals (1994-2028); inline code `1px solid stroke`, radius 3px, well, amber, 0.9em (2032-2040); pre 10.5px, line-height 1.5, radius 5px, `overflow: auto` (2041-2053); quote font-display italic 1.05em with a `"\201C"` mark in amber at 0.72 (2063-2086); link amber with a border-bottom of main 35% (2089-2098); hr with a centred three-bullet mark (2221-2242).
- Overflow: a shared ResizeObserver sets `data-overflows` when `scrollHeight > clientHeight` (`L/note-overflow.ts:12-48`); the fade is `mask-image: linear-gradient(to bottom, var(--color-ground) calc(100% - 1lh), transparent)` (`W/styles.css:1938-1940`).
- Images: `max-height: 220px`, radius 3px, `object-fit: contain`; figcaption mono 9px faint; a missing image is mono 10px crimson text (`W/styles.css:2110-2151`).

### 2.5 Label

- `label-surface ... items-center overflow-hidden ... font-display`; text `text || "Label"` in `block w-full truncate`; colour `color ? accentColor(color) : INK` (`N/TextNode.tsx:235, 384-414`).
- Type: font-display, `--text-hero` (24px), 700, leading-compact, ground halo text-shadow (`N/spine-card.css:423-429`).

### 2.6 Image file

- Default card shell (2.0), resizable; `button.file-node-image`: block, 100% by 100%, transparent, `cursor: zoom-in`, overflow hidden, radius 2px; the media takes no pointer events (`N/FileNode.tsx:39-115`, `W/styles.css:2154-2171`). `ContentMedia` itself: not read.

### 2.7 States

| State | Agent seat | Kind seat | Spine card | Default card (image file), note, label |
|---|---|---|---|---|
| Selected | border main 55%, background raise 94%, shadow `0 8px 22px var(--color-shadow-2)` (`S/factory-grammar.css:26-30`) | border kind-hue 60%, background `color-mix(in oklab, var(--kind-hue) 10%, var(--color-raise))`, same shadow (`N/kind-seat.css:146-150`) | chip border main plus `0 0 0 1px var(--color-main)` (`N/spine-card.css:74-77`) | card: border accent 0.75, shadow `0 0 0 1px accent 0.25, 0 12px 30px shadow-2` (`N/NodeShell.tsx:448-489`). Note and label: no selected paint rule found in the files read; resizer and toolbar show (inference) |
| Hovered | border stroke, background raise 90% (`S/factory-grammar.css:22-25`); lift 1px; collaboration overlay opens (`N/TextNode.tsx:241-272`) | border stroke, background raise 90% (`N/kind-seat.css:141-144`); lift 1px | chip border stroke-hi (`N/spine-card.css:70-72`) | lift 1px (`S/seat-card.css:5`); source handles show (`W/styles.css:1533-1535`) |
| Keyboard focus | node `outline: 1px solid var(--color-cyan); outline-offset: 3px; border-radius: var(--radius-lg)` (`S/factory-grammar.css:271-275`) | same | chip outline `calc(2px * var(--node-s, 1))` cyan, offset `calc(3px * var(--node-s, 1))` (`N/spine-card.css:85-88`) | note and label: the same 2px cyan ring round the block, radius-sm (`N/spine-card.css:431-435`) |
| Blocked | ring `halt` in crimson; a declared blocker adds the flag with a bar and a crimson glow (`SH/wire/rings.ts:178-229`, `SH/wire/seat-activity.ts:180-187`). Shell border, shadow and the `::after` ring are overridden or hidden (`S/factory-grammar.css:15-35`), so only the ring and line say it (inference) | ring wave crimson, line `text-crimson-fg`; `::after` hidden (`N/kind-seat.css:153-157`) | tag triangle crimson | card: border crimson, crimson gradient, `.junto-blocker` shadow `0 0 0 2px accent 22%, 0 0 12px 0 accent 12%` and a static `::after` ring `inset: -5px`, `2px solid` accent 55%, opacity 0.55 (`W/styles.css:1628-1643`); the inline `boxShadow` outranks the class shadow (inference) |
| Working | ring `work` in cyan (comet over a dashed track), line "working" (`SH/wire/seat-activity.ts:189-196`) | wave cyan, line `text-cyan-fg` | arc cyan | none |
| Idle | ring `rest`: still, steel, alpha 0.42 dark or 0.5 bright, width `RING_W * 0.8` (`L/activity-rings.ts:369-382`); line "resting" or "ready" | static steel "idle", line `text-dim` | no tag tone | none |
| Needs attention | wave amber gives ring `call` ("needs operator input" or "stalled — needs operator look", `SH/wire/seat-activity.ts:165-178`); escalate, feedback or fresh waiting health give ring `wait` in the flag's hue or amber, plus an amber glow band (`SH/wire/rings.ts:178-229`). `data-seat-attention` and `data-attention="fire"` shell rules (`W/styles.css:1665-1683`) are overridden or hidden on seats (inference) | wave amber "needs you", line `text-amber-fg` | dot amber | card: border amber 0.52, amber gradient; `::after` ring `inset: -6px`, `2px solid` main 70%, opacity 0.55 |
| Done, unread | ring `done` in green lands once then glints; line "done, not read yet" (`L/seat-line.ts:20-49`) | pulse green, line `text-green` | none | none |
| Overseer | crest on the ring; spoken name "Overseer, ..."; no other drawing: `.overseer-mark` is the off-canvas chip, "on the canvas the crest alone carries it" (`S/factory-grammar.css:52-66`) | not applicable | not applicable | not applicable |
| Vacant seat | `data-occupancy="empty"`, label "empty seat" (`L/occupancy-chrome.ts:32-76`). No CSS rule for it found (grep), and agents have `outline: none` on `[data-occupancy]` (`S/factory-grammar.css:31`). No vacant drawing exists in what I read | not applicable | not applicable | not applicable |
| Not running, stopped, gone | ring `off`: steel, alpha 0.55, round caps, dash `[0.05, 1.45]` (`L/activity-rings.ts:369-382`); words "not running", "stopped", "gone" (`SH/wire/seat-activity.ts:263-278`). `data-occupancy="gone"` has `opacity: 0.78` (`W/styles.css:1729-1733`); whether it reaches agents: not verified | offline: static steel glyph off, line `text-faint` | ring faint | none |
| Error | spawn failure: wave crimson with the exit message (`SH/wire/seat-activity.ts:241-258`); failure line amber-fg; trouble readings bend the ring to `reverse`, `snake` or `fracture` in amber (`SH/wire/rings.ts:178-229`) | failed gives the blocked state; git error and files failure give offline | triangle crimson | missing note image: crimson text |
| Dimmed | focus modes: `.react-flow.impact-mode .react-flow__node, .react-flow.connection-focus-mode .react-flow__node { opacity: 0.22; filter: saturate(0.35); transition: opacity 0.18s ease, filter 0.18s ease; }`; lead 0.72 and `saturate(0.85)`; members opacity 1 with accent or second rings (`W/styles.css:1151-1188`). Stale AI reading text is faint; a stale band is painted at fade 0.4 (`L/activity-atlas.ts:297-312`) | same focus modes | stub 0.72 | `[data-attention="empty"] { opacity: 0.88 }` (`W/styles.css:1697-1699`) |

- Reach preview (any node): `::before` at `inset: -6px`, radius-lg, `box-shadow: 0 0 0 2px var(--reach-hue), 0 0 18px color-mix(in oklab, var(--reach-hue) 40%, transparent)`; loses is `outline: 2px dashed`; hues gains green, loses orange, both yellow, held cyan; a summary pill from `content: attr(data-reach-summary)` at `left: calc(100% + 14px)` (`S/reach-preview.css:6-49`).
- Occupancy outlines for idle, attention, activity_blocked, stalled, gone exist at `W/styles.css:1706-1733`; actor seats carry only `empty` or `gone` (`L/occupancy-chrome.ts:63-76`).

## 3. Zoom tiers

| Tier | `tierAt(zoom)` | Leaves toward less detail at | Returns at |
|---|---|---|---|
| near | zoom >= 0.62 | zoom < 0.59 | zoom >= 0.65 |
| mid | zoom >= 0.34 | zoom < 0.31 | zoom >= 0.37 |
| far | zoom >= 0.2 | zoom < 0.17 | zoom >= 0.23 |
| overview | below 0.2 | | |

- `TIER_NEAR_MIN = 0.62`, `TIER_MID_MIN = 0.34`, `TIER_FAR_MIN = 0.2`, `TIER_HYSTERESIS = 0.03`; less detail needs `tierAt(zoom + 0.03)` lower, more detail needs `tierAt(zoom - 0.03)` higher (`L/canvas-tier.ts:28-55`). The switch points in the table are computed. Camera range `minZoom={0.15}`, `maxZoom={2.5}` (`C/Canvas.tsx:1881-1882`).

**How it is computed and delivered**
- `CanvasTierGate` subscribes to the React Flow store's transform; the tier is published every frame, the scales once after the camera rests for `CAMERA_SETTLE_MS = 160`, then `cameraSettled$` is bumped (`C/CanvasTierGate.tsx:37-79`, `L/canvas-tier.ts:64-67`).
- `publishCanvasTier` writes `data-canvas-tier` on `<html>` and `canvasTier$` only on change (`L/canvas-tier.ts:36, 70-77`). CSS selectors on that attribute do the rest; no card re-renders.
- One exception: `ActivityMark` reads the tier (`useSeatTier`, `useSyncExternalStore`) and re-keys its moving parts at each tier so they re-raster, then rejoins the shared clock (`C/ActivityMark.tsx:336, 368-375, 438`; `C/seat-view-source.tsx:47-51`).
- Scales are written on the consuming elements, not the root ("Blink restyles all 17,843 of them at a rest", `L/canvas-tier.ts:144-148`):
  - `--far-seat-scale = min(5.2, max(1.75, ceil(40 / (52 * zoom) / 0.1) * 0.1))` from `FAR_RING_SCREEN_PX = 40`, `SEAT_RING_UNITS = 52`, `SEAT_SCALE_MAX = 5.2`, `SCALE_STEP = 0.1` (`L/canvas-tier.ts:86-123`). Computed examples: 2.6 at zoom 0.3, 3.9 at 0.2, 5.2 at 0.15.
  - `--seat-floor-scale`: the same with `OVERVIEW_RING_FLOOR_PX = 22` and floor 1 (`L/canvas-tier.ts:99-126`).
  - `--node-s`: inverse zoom rounded up to a tenth, 1 to `NODE_SCALE_MAX = 6.7` (`L/canvas-tier.ts:359-368`), written on `.spine-card`, `.tasks-enqueue`, and at far on `.spine-chip`, `.spine-pip`, spine text nodes and `.label-surface` (153-161).
  - `--seat-s` written on on-screen, ungathered `.junto-seat > .junto-mark`, on `.junto-seat__text`, and on the seat itself when selected, hovered or its ring is call, wait or halt (178-207).
  - `--ring-cap` per node in the node's inline style (`L/flow-nodes.ts:230-234`).

**What changes**

| Tier | Seats and kind seats | Other cards | Regions and wires |
|---|---|---|---|
| mid, and below | preamble `display: none`; `.junto-seat__text > :not(:first-child) { display: none }` (name only); `.junto-node { box-shadow: none !important; transition: none; }`; no hover lift; badge `.junto-mark__over { visibility: hidden }` (`S/canvas-lod.css:34-56`) | a note shows only its first block (49-51) | `background: var(--region-flat)`; wire labels and pulses hidden; frame `outline: 3px solid` region-hue 40%, offset -3px (`S/canvas-lod-regions.css:41-56`); region names fade in (below) |
| far, and overview | shell transparent; `.junto-seat { --ring-px: 52px; --seat-s: max(1, min(var(--far-seat-scale, 1.75), var(--ring-cap, 1.75))); }`; ring grown in layout: `--mark-u: calc(52px * var(--seat-s)); margin: calc(26px * (1 - var(--seat-s)));`; portrait or icon `zoom: var(--seat-s)`; handles hidden; collaboration overlay off; kind band `display: none`; card `transform: none !important` (`S/canvas-lod.css:66-149`, `N/kind-seat.css:116-118`) | spine chip becomes a disc `min(100cqw, max(28px, calc(26px * var(--node-s, 1))))` square with border `calc(1.5px * var(--node-s, 1))` ink 55%, glyph `calc(14px * var(--node-s, 1))` in ink 78%, and a status pip top right at `calc(-3px * var(--node-s, 1))`, 11px square (triangle 15 by 13), crimson or amber border `calc(2px * var(--node-s, 1))`; tag, spine and leaf `visibility: hidden` (`N/spine-card.css:308-377`). Note: body hidden, an amber tick `min(100cqw, calc(10px * var(--node-s, 1)))` by `min(100cqh, calc(26px * var(--node-s, 1)))` (440-452). Label: `font-size: max(var(--text-hero), calc(13px * var(--node-s, 1)))` (454-457). Remaining cards (image files, inference): `background: ink 5% !important`, children hidden, a centred glyph `height: min(60%, 120px); aspect-ratio: 1`, ink 38%, drawn by `mask: var(--kind-glyph) center / contain no-repeat`; selected `outline: 4px solid` main 70%, offset 2px (`S/canvas-lod.css:220-255`) | wash region-hue 8%, `outline: 6px solid` region-hue 62%, offset -6px; nested coloured 5%; uncoloured 4% with outline 34%; selected outline amber 80%; title bar transparent with hidden children; wires `stroke-opacity: 0.4` (`S/canvas-lod-regions.css:60-101`) |
| overview only | `--seat-s: max(var(--seat-floor-scale, 1), min(var(--far-seat-scale, 1.75), var(--ring-cap, 1.75)))` (`S/canvas-lod.css:84-86`) | every node that is not a region, an agent or a kind seat is `visibility: hidden !important` (`S/canvas-lod-regions.css:109-111`) | all wires hidden; flows track stays; outline 10px offset -10px; regions at depth 3 hidden (74-77, 109-120) |

**Far seat details**
- Unpainted hit disc: `--seat-hit: calc(52px * 1.16 * max(var(--seat-s), var(--ring-cap, 1)))`, round, `z-index: -1` (`S/canvas-lod.css:111-122`).
- Name tag `.junto-seat__text`: absolute, `left: 50%`, `top: calc(50% + var(--ring-px) * var(--seat-s) / 2 + var(--seat-s) * 8px)`, `width: max-content; max-width: 220px`, padding `1px 8px 2px`, `1px solid var(--color-stroke)`, radius 6px, raise, `transform: translateX(-50%) scale(calc(var(--far-seat-scale, 1.75) * 1.4)); transform-origin: 50% 0`; hidden unless the node is hovered or selected; hovered node `z-index: 2000 !important` (`S/canvas-lod.css:150-176`).
- Urgency halo on a `::before` the ring's size: call and wait `0 0 0 calc(var(--seat-s) * 2.5px)` amber 92% plus `0 0 0 calc(var(--seat-s) * 4px)` amber 30%; halt the same in crimson; hover outline `calc(var(--seat-s) * 2px)` ink 45% at offset `calc(var(--seat-s) * 5px)`; selected `calc(var(--seat-s) * 3px)` main 85% (`S/canvas-lod.css:181-215`).
- Ring room: `seatRingCaps` gives each ring half the distance to another ring less `RING_GAP / 2` and the full distance to a card edge less `RING_GAP = 12`, rounded to 0.01, between 1 and 5.2; `evenRingCaps` gives every seat of a region the region's smallest cap (`L/seat-ring-room.ts:26-92`). `RING_FOOTPRINT = 1.16` (34).

**Region names at far zoom (glance gate)**
- `RegionGlanceGate` calls `publishRegionGlance(domNode, zoom)` at mount and on `cameraSettled$` (`C/RegionGlanceGate.tsx:27-38`); it writes `--junto-region-glance` and `--junto-region-glance-sub` on the ReactFlow root, only on change (`L/region-glance.ts:68-113`).
- `REGION_BAND = { rise: 0.62, peak: 0.34, hold: 0, fall: 0 }`; `SUBREGION_BAND = { rise: 1.05, peak: 0.86, hold: 0, fall: 0 }`; opacity 0 at or above rise, linear `(rise - zoom) / (rise - peak)` quantized by `STEP = 0.04`, 1 at or below peak (`L/region-glance.ts:48-88`).
- Far colour of the name: `color-mix(in oklab, color-mix(in oklab, var(--region-hue) 70%, var(--color-ink)) 30%, transparent)`; uncoloured ink 22% (`S/canvas-lod-regions.css:84-89`).

**Seat clusters (far and overview only)**
- Seats closer than `clusterSpan(zoom) = (22 + 4) / zoom` gather by single linkage inside one region (`SEAT_FLOOR_SCREEN_PX = 22`, `CLUSTER_GAP_PX = 4`); a ring budget of `RINGS_PER_SCREEN = 12` forces more gathering: `linksHeldFor = max(linksHeldAt, min(links, seats + apart - floor(12 * screens)))` (`L/seat-clusters.ts:43-170`). Selected seats and seats whose ring is call, wait or halt are never gathered (`C/SeatClusterLayer.tsx:139`).
- A style sheet `#junto-seat-clusters` hides gathered seats (`visibility: hidden !important`) (`C/SeatClusterLayer.tsx:43-103`). The badge sits at the centroid in a `ViewportPortal`: a button with `ActivityMark size="seat"`, the first member's portrait at `portraitFor(52)`, a count, and a hover list of members with 20px portraits (144-204, 284). Mark: work wave cyan, done pulse green, rest static steel (111-115).
- Badge CSS: `z-index: 3000` (3001 hovered); body `scale(var(--far-seat-scale, 1.75))`; 40px disc in raise with a two-ring stack from four box-shadows, rim steel 70%, cyan 85% for work, green 85% for done; count badge min-width 20px, height 20px, radius 10px, mono 12px 700 tabular (`S/canvas-lod.css:264-341`).
- Regroups on zoom only when the number of links held changes; watches `data-mark-ring` with a MutationObserver (`C/SeatClusterLayer.tsx:206-290`).

**Urgency gate**: `RegionUrgencyGate` recomputes region urgencies from `seatUrgency$` and `nodeUrgency$` using `seatRegion`, `homeRegion`, `parentRegion` (`C/RegionUrgencyGate.tsx:25-59`). Drawing in section 6.

## 4. Motion

**The ring clock**: `RING_FRAME_MS = 90`, `RING_CYCLE_FRAMES = 32`, `LAND_FRAMES = 8`, `MARK_PHASE_MS = 896 * RING_FRAME_MS` (80640 ms) (`SH/wire/rings.ts:57-67`). Every mark gets `--mark-t0 = -(Date.now() % MARK_PHASE_MS)ms` as its `animation-delay`, so "every screen showing a seat (the phone too) is in the same phase" (`C/ActivityMark.tsx:116-123`, `L/activity-atlas.ts:360`). Every period divides the phase (computed: 80640 / 1440 = 56, / 2880 = 28, / 5040 = 16, / 5760 = 14, / 11520 = 7).

**Ring animations** (`SH/wire/rings.ts:100-114`, `L/activity-atlas.ts:355-379`). All touch `transform` or `opacity` only, `animation-iteration-count: infinite` unless noted.

| Ring | Still base | Moving part | Keyframes | Period | Easing | Trigger |
|---|---|---|---|---|---|---|
| work | dashed track `[0.7, 1.1]` | comet, span `0.75 pi`, 18 steps | `junto-mark-turn` rotate 0 to 360deg | 1440 ms | linear | working |
| reverse | base | comet, span `-0.55 pi` | turn, `animation-direction: reverse` | 2880 ms | linear | working with a "stuck" trouble reading |
| snake | none | 7-lobe wave ring, amp 0.55 | turn | 5040 ms | linear | working with other trouble |
| call | ring, width `RING_W * 1.05` | wave ring | `junto-mark-send`: scale 1 to 1.31, opacity 1 to 0 by 81.25%, then held | 1440 ms | linear, with `cubic-bezier(.33,1,.68,1)` inside the keyframe | needs operator input |
| wait | ring alpha 0.55 | two beads, arcs of ±0.34 rad | turn | 5760 ms | linear | escalate, feedback, or fresh waiting health |
| halt | four quarters, gap 0.3 rad, butt caps | brighter quarters | `junto-mark-beat`: opacity 0, 18.75% 1, 37.5% 0, 50% .55, 68.75% 0, 100% 0 | 1440 ms | linear | blocked |
| done | blank cell until landed | sealed ring, width `RING_W * 1.45` | `junto-mark-land`: scale .82 to 1, opacity 0 to 1 | 720 ms, once, `both` | `cubic-bezier(.33,1,.68,1)` | a turn settled, unread |
| glint (after done lands) | sealed ring | arc, length 0.9 rad | turn plus `junto-mark-breathe` (opacity 0, 1, 0) | 2880 ms | linear, ease-in-out | until read |
| fracture | none | four arcs, gap 0.45 | turn | 11520 ms | linear | trouble at rest |
| dot, live | base | brighter ring | breathe | 2880 ms | ease-in-out | seated, live process |
| rest, off | still | none | none | | | idle, stopped |

- Ring geometry and alphas per shape: `L/activity-rings.ts:68-312`. Glows are canvas `shadowBlur = blur * p.glow` baked into the atlas, glow factor 1.8 in dark and 0 in bright (`L/activity-rings.ts:55-59`, `L/activity-atlas.ts:249-252`).

**The atlas mechanism** (`L/activity-atlas.ts`)
- `MARK_BOX = 20`, `SCALE = 5.2` ("a 52px seat ring at dpr 2 draws 1:1"), `MARK_CELL = 104`, `MARK_ATLAS_COLS = 32` (54-60). 18 loop rows painted for all 32 frames, a land row with frames 0 to 8, then packed cells: blank, stills, bands (glow by halo by flag, stale variants), per-ring parts (62-165, 274-312). Size 32 by 22 cells, 3328 by 2288 px, is computed, not read from a line.
- `renderAtlas` paints a 2D canvas and returns `canvas.toDataURL("image/png")`; `ensureMarkAtlas(mode)` paints once per mode into the style sheet `#junto-mark-atlas` (317-338, 472-482).
- A mark is one element whose `background-position` picks a cell: `calc(var(--mark-col) * var(--mark-u) * -1) calc(var(--mark-row) * var(--mark-u) * -1)`, `background-size: calc(var(--mark-u) * 32) calc(var(--mark-u) * ROWS)`, `contain: layout style paint` (384). Sizes: default 20px, inline 14px, seat 52px, glance 32px (384-387).
- Moving parts are child spans `.junto-mark__part` that inherit the image and pick their own cell with `--part-col`, `--part-row`, `--part-ms`; they are `display: none` unless `html:not([data-surface-motion="paused"]) .junto-mark[data-mark-visible]` (360-361). While live, a looping mark's background is its still base cell (358). "No will-change" (351-353).
- Theme: dark image by default, `html[data-theme="bright"] .junto-mark` swaps it, `[data-mark-theme]` scopes panels (406-416).
- Paint order inside a mark: portrait, flag button, parts, badge, crest (`C/ActivityMark.tsx:417-442`).

**What stops motion**
- Visibility: one shared IntersectionObserver, `rootMargin: "0px"`, sets `data-mark-visible` on the DOM (`C/ActivityMark.tsx:106-183`).
- Occlusion, `L/mark-occlusion.ts`: a moving mark wholly under an opaque surface (the working panel) stops its parts, "the motion law's third exception" (1-7). One IntersectionObserver per opaque surface with the root box cut to the surface by `rootMargin`, inset by corner radius plus `SLACK = 2`; covered needs ratio `COVER_RATIO = 0.99`, the box within, the mark not owned by the surface, and the surface on top by `elementFromPoint` (27-35, 61-86, 143-166). A surface counts only with an opaque background and no ancestor opacity below 1 (71-78); re-read on resize, animationend and window resize (193-222).
- Surface gate: `html[data-surface-motion]` is "paused" only when the page is hidden or `prefers-reduced-motion: reduce`; blur alone stays live (`L/surface-motion.ts:1-48`). `html[data-surface-motion="paused"] *, *::before, *::after { animation-play-state: paused !important; }` (`W/styles.css:1144-1148`).

**Kind band motion** (`L/kind-band.ts:34-51`, `N/kind-seat.css:27-113`): one moving layer, linear, infinite, delay `--mark-t0`, shown under the same visibility gate.

| Motion | Period | Keyframes |
|---|---|---|
| chase, shimmer, hand, scan, orbit | 10080, 5760, 11520, 2880, 5040 ms | `kind-band-turn` to 360deg |
| pulse, breathe | 1440, 2880 ms | opacity 0.25, 1, 0.25 |
| blink, blink-fast | 1260, 720 ms | opacity 1 until 49%, 0.1 from 50% |
| ripple | 2880 ms | opacity 0.8 to 0 with scale 1 to 1.22 |
| glint | 2520 ms | opacity 0, 0.9 at 30%, 0 at 60% |
| shake | 720 ms | translateX 0, -1px, 1px |

**Other motion on or round cards**

| What moves | Properties | Duration and easing | Trigger | Receipt |
|---|---|---|---|---|
| Far seat ring resize | `transform: scale(ratio)` to none, by `mark.animate` (FLIP) | `SEAT_EASE_MS = 160`, `cubic-bezier(.33, 1, .68, 1)`; skipped when the ratio is within 0.002 of 1 or motion is paused | camera rest, tier entry | `L/canvas-tier.ts:210-232, 309-356` |
| Cluster badge | transform | `transition: transform 160ms cubic-bezier(.33, 1, .68, 1)` | scale change | `S/canvas-lod.css:278-291` |
| Camera to a cluster | viewport | `rf.setCenter(x, y, { zoom, duration: 260 })` | click | `C/SeatClusterLayer.tsx:172-173` |
| Portrait expression | opacity | new face `agent-portrait-face-in 220ms ease-out both`; old face `agent-portrait-face-gone 1ms linear 260ms forwards` | mood change | `C/AgentPortrait.css:26-50` |
| Preamble line | translateY 3px to 0, opacity 0 to 1 | `junto-preamble-in 0.2s cubic-bezier(0.22, 1, 0.36, 1) both` | new line | `N/preamble-bubble.css:108-114, 181-189` |
| Reach preview | opacity 1 to 0.55, scale 1 to 1.015 | `junto-reach-breathe 1.44s ease-in-out infinite` | reach preview | `S/reach-preview.css:11-22, 65-68` |
| Card hover | border-color, box-shadow, transform | `.18s ease`, `.18s ease`, `.16s ease` | hover, select | `S/seat-card.css:4-7` |
| Focus dimming | opacity, filter | `0.18s ease` | impact or connection focus | `W/styles.css:1151-1156` |
| Handles | opacity | `0.15s ease` | hover, connecting | `W/styles.css:1495-1505` |
| Verb landing zones | background, border-color | `120ms ease-out` | drag over | `S/factory-grammar.css:110-128` |
| Region title bar, frame strips | background, border-color | `.16s ease` | hover | `S/region-title.css:5-25`, `W/styles.css:1005-1018` |
| Tooltip | opacity, transform | `70ms ease-out`, `90ms cubic-bezier(0.16, 1, 0.3, 1)` with `@starting-style` | hover | `W/styles.css:2295-2327` |

- A card with a turning ring gets `transform: translateZ(0)` as a layer hint (`S/seat-card.css:8-19`). The viewport itself is deliberately not composited (`W/styles.css:1107-1124`).

**Also off the canvas**: the ring at inline, glance and default sizes, and `SeatRingView` in rows and the palette (`L/activity.ts:35-39`, `C/SeatRing.tsx:128-162`); `AgentSeatView` in "the tour, the gallery and the kit" and `SeatName` in the agent modal's rail (`N/AgentSeatView.tsx:11-12, 27`); the seat in the terminal actor rail (`C/terminal/actor-rail.css:81-85`); the atlas mirrored into shadow roots for the website's kit (`L/activity-atlas.ts:424-466`); the preamble bubble with a right tail in the agent modal's rail (`N/preamble-bubble.css:89-106`); the portrait cross-fade wherever a portrait shows. The kind band, the reach preview, the seat FLIP and the cluster badge were found only on the canvas.

## 5. DOM controls on or round cards

| Control | Where | What it holds | Receipt |
|---|---|---|---|
| Node toolbar | `NodeToolbar` above the card, offset 8, in a `ToolbarPill` (`nodrag nopan flex items-center gap-1 rounded-md border border-stroke bg-inset px-1 py-1 shadow-lg shadow-black/40`) | Maximize2, extras, Crosshair (connection focus), LocateFixed (blocker cause), Trash2; icons size 14; a minimal delete-only form for labels | `N/NodeShell.tsx:158-309`, `C/ui/ToolbarPill.tsx:9` |
| Toolbar extras | agent: Customize, StartParams, SeatMessage, SeatOffboard, TerminalToolbarActions; terminal: TerminalToolbarActions; task: TaskToolbarActions; page: PageToolbarActions | buttons that open popovers (message and offboard are `Popover` width 320) | `N/TextNode.tsx:289-303`, `N/LinkNode.tsx:76`, `N/SeatMessage.tsx:106-142`, `N/SeatOffboard.tsx` |
| Resizer | `NodeResizer`, visible when selected, min 170 by 72 (bare 48 by 24) | handles 10px by 10px, `1px solid var(--color-amber)`, radius 2px; lines main 50% | `N/NodeShell.tsx:492-503`, `W/styles.css:1056-1057` |
| Connection handles | eight per card, sides top, right, bottom, left | 9px dots, ground fill, `1px solid` main 50%, opacity 0 until hover or connecting; `::before` hit area `inset: -9px`; target dashed in second 72% | `N/NodeShell.tsx:61, 154-156`, `W/styles.css:1495-1548` |
| Verb landing zones | over a card during a wire drag, `VERB_ZONE_BLEED = 16` | radius 10px, zone-hue border 72%, fill 16% (34% active), z-index 20 | `N/NodeShell.tsx:67, 90-152`, `S/factory-grammar.css:110-128` |
| Signal flag | transparent button over the ring's top right, 36% by 36%, min 10px | opens the operator modal "feed" | `L/activity-atlas.ts:402-403`, `N/AgentSeat.tsx:63` |
| Task enqueue | trailing button on the task card | Plus, 20 by 20 | `C/work/WorkSurfaces.tsx:103-171` |
| Rename input | in place of the name | `font-mono text-[14px] font-semibold leading-snug`; Enter and blur commit, Escape discards | `N/FirstLineRenameInput.tsx:39-63` |
| Label and note editors | textareas inside the node | `label-edit-inline ... font-display`; `note-edit-inline ... font-mono` 12px, line-height 1.55 | `N/TextNode.tsx:363-382, 421-440`, `W/styles.css:1924-1928` |
| Preamble bubble | above a seat; lifts by `(8 + toolbar height + 6) / zoom` over a lone selected seat's toolbar | close button | `N/PreambleBubble.tsx:13-68`, `N/PreambleBubbleView.tsx:134-183` |
| Collaboration overlay | `absolute left-0 top-full z-50 pt-1`, on hover | SeatAwarenessHoverForNode, SeatCollaborationBlock (not read) | `N/TextNode.tsx:241-272` |
| Cache status hover card | portaled to `document.body`, opens after 350 ms | `junto-popover font-mono text-label`, width 360 | `N/SeatCacheStatus.tsx:11-13, 113-142` |
| Work detail surfaces | mounted inside the node | TasksDetail, GitDetail, ArtifactsDetail, FilesDetail, AutomationsDetail | `N/TextNode.tsx:306-360` |
| Image focus, page open | image button opens a `FocusSurface`; double click on a page opens the dock browser | | `N/FileNode.tsx:39-115`, `N/LinkNode.tsx:60-85` |
| Note links | `target="_blank"` anchors | | `L/note-markdown.tsx:226-238` |
| Region chrome | title bar (drag handle), label span and input (`maxLength={REGION_NAME_MAX}`), toolbar FolderOpen, KeyRound, Trash2, resizer, frame strips, two modals | | `N/GroupNode.tsx:32-144, 354-403` |
| Cluster badge | button plus a hover list of members | | `C/SeatClusterLayer.tsx:144-204` |
| Native tooltips | `title` on ring, names, lines, wrappers | | `C/ActivityMark.tsx:401`, `N/AgentSeatView.tsx:28-34`, `N/KindSeat.tsx:127` |

- An open button (`absolute right-2 top-2 z-10 grid size-6`, `text-cyan-300/70`) exists in NodeShell; no caller passing `onOpen` was found in the files read (`N/NodeShell.tsx:504-518`).
- Layers these sit on: `--layer-canvas-track: 1000`, `--layer-working: 10000`, `--layer-popover: 12000`, `--layer-tooltip: 20000` (`S/layers.css:18-39`).

## 6. Regions

**Drawing (near)**
- Root `junto-group relative h-full w-full rounded-[14px]`, `background: var(--region-fill)` (`N/GroupNode.tsx:314-335`, `S/region-title.css:46`). `--region-fill`: coloured `linear-gradient(135deg, <tint .08>, color-mix(in oklab, var(--color-ground) 25%, transparent))`, else `linear-gradient(135deg, raise 22%, ground 12%)`; `--region-flat`: tint 0.07 or raise 16%.
- Border: `borderColor(color, selected)`; selected amber 0.6 with shadow `0 0 0 1px` amber 0.18; frame hover amber 0.42 (`N/GroupNode.tsx:158-159, 306-335`).
- Title bar: 24px high, padding `0 8px`, gap 6px, radius `13px 13px 0 0`, hover amber 6%; label mono 12px 600, ink 72% (the tint when coloured), text `label || UNNAMED_REGION` ("unnamed region") (`S/region-title.css:4-43`, `N/GroupNode.tsx:89-144`, `SH/model/canvas.ts:102`). Lock icon size 10 at opacity 0.5 when the region holds its contents; AlertTriangle size 10 amber at 0.8 when `depth > MAX_REGION_DEPTH` (8) (`N/GroupNode.tsx:170-171, 381-401`, `SH/graph.ts:74`).
- Frame strips left, right, bottom, 12px wide, radius 12px, hover amber 7%, only when not selected (`W/styles.css:1005-1018`, `N/GroupNode.tsx:366-380`). The wrapper is `pointerEvents: none`; only the chrome takes the pointer (`L/flow-nodes.ts:227-234`).
- Attributes: `data-region-depth` (capped at 3), `data-region-urgency`, `data-region-reach`, `data-region-colored` (`N/GroupNode.tsx:314-335`).

**Membership**: "a thing is inside a region only when its whole rectangle lies inside the region's. It is worked out, never stored." (`SH/model/canvas.ts:91-99`). `regionStack` returns every containing region, outermost first by area then id; regions may overlap (107-118). Depth is the stack length and the parent is the innermost (`L/flow-nodes.ts:122-137`). Agents carry `seatRegion`, other cards `homeRegion`, regions `parentRegion` (195-197).

**Name slot planning** (`L/region-name-slot.ts`)
- Constants: `TITLEBAR = 24`, `FRAME = 12`, `MARGIN = 16`, `GLYPH_RATIO = 0.68`, `WIDTH_SHARE = 0.9`, `HEIGHT_SHARE = 0.6`, `REGION_NAME_MIN_PX = 40`, `REGION_NAME_MAX_PX = 240` (25-40). Font size from the slot by those shares (`nameFontSize`, 47-53).
- `regionNameSlot` finds the largest clear rectangle avoiding child regions and cards (`bestClearRect`, 64-109), and prints over cards only when the open slot is more than 1.25 times larger (124-158).
- Member rectangles include each ringed card's far ring as a square of side `52 * min(cap, FAR_RING_SLOT_SCALE = 3)`; slots are memoised on label, region rect, child rects and card rects (`L/flow-nodes.ts:21, 140-159`).
- Drawn as `.junto-region-glance` placed at the slot with `fontSize: slot.fontSize px`, only for named regions, nested form at depth 1 or more (`N/GroupNode.tsx:179-181, 338-348`). Text: font-display, `line-height: 1`, `letter-spacing: .1em` (`.14em` nested), uppercase, centred, nowrap, ellipsis; colour `var(--region-name, ink 20%)`, nested ink 22%; coloured regions set `--region-name` to the tint at 0.22; opacity from the glance variables (`W/styles.css:1022-1055`).

**Rollups**
- Seats publish their urgency from the ring: halt or signal blocked gives blocked; call or escalate gives needs-you; feedback gives review; fresh waiting health gives needs-you (`L/region-urgency.ts:41-52`, `N/AgentSeat.tsx:46-55`). Non-seat cards publish through `useNodeUrgency` (`L/use-node-urgency.ts:8-13`).
- `regionUrgencies`: "direct" in the home region, "held" in every ancestor (`L/region-urgency.ts:85-108`).
- Drawing at every tier: `--urgency` crimson, amber or cyan for blocked, needs-you, review; `--region-hue` is the tint, 72% toward the urgency, 90% when held; `::after` direct: fill urgency 3%, `inset 0 0 0 1.5px` urgency 50%, `inset 0 0 28px` urgency 9%; held `inset 0 0 0 1px` urgency 28%; far direct 4%, `inset 0 0 0 6px` 52%, `inset 0 0 110px` 11%; far held `inset 0 0 0 4px` 30% (`S/canvas-lod-regions.css:124-160`).
- Other per-region rollups: ring caps evened per region (`L/seat-ring-room.ts:76-92`); seat clusters formed per region (`L/seat-clusters.ts:84-135`); `regionTallyParts` feeds the command bar, off canvas (`L/region-glance.ts:136-147`).

## 7. The design system for a consumer that is not CSS

**Structure of `src/shared/theme/`**

| File | Holds | Receipt |
|---|---|---|
| `primitives.ts` | `NEUTRALS` dark and bright (ground, raise, raise-2, inset, well, ink, ink-2, dim, faint, umbra); `HUES` (amber, amber-hi, amber-fg, cyan, cyan-fg, crimson, crimson-fg, violet, violet-fg, steel, steel-fg, indigo, gold, orange, green, green-fg, yellow, lime, blue, pink, teal); label colours | `T/primitives.ts:52-172` |
| `semantic.ts` | `TokenValue` = solid, mix or alias; dark tokens and bright overrides; `ThemeMode = "dark" or "bright"`; `semanticTokens(mode)` | `T/semantic.ts:19-22, 75-194` |
| `oklch.ts` | `hexToOklch`, `oklchToHex`, `formatOklch`, `contrastRatio`, `hexAtAlpha` | `T/oklch.ts:27-77` |
| `type.ts` | `TEXT_SIZES`, `TRACKING`, `LEADING` | `T/type.ts:12-47` |
| `shape.ts` | `RADIUS` | `T/shape.ts:10-17` |
| `index.ts` | font stacks, `tokenCss`, `themeRuntime(mode)`, `DARK_RUNTIME`, `TOKEN_NAMES`, `resolveThemeMode` | `T/index.ts:35-123` |

- Projections: CSS, generated by `scripts/theme-build.ts` into `S/theme.generated.css` (dark in `@theme static`, bright under `html[data-theme="bright"]`, `S/theme.generated.css:1-175`); and `themeRuntime(mode)`, a `Record<string, string>` with hex for solids and aliases and `rgba()` for mixes (`T/index.ts:84-97`). "canvas, xterm and 3D read themeRuntime(mode)" (`T/index.ts:33`).
- Semantic mixes, dark then bright: stroke `mix(ink, 14)` then 55; stroke-hi 28 then 70; overlay-1 to 4 `mix(ink, 3/5/7/10)` then 5/8/11/14; shadow-1 `mix(umbra, 55)` then 28; shadow-2 42 then 18; focus-ring `mix(second, 10)` then 22; backdrop `mix(ground, 72)` then `mix(umbra, 18)`; selection `mix(main, 28)` then `mix(main-fg, 50)`. Roles: main is amber, second is cyan, accent is crimson (`T/semantic.ts:75-123, 136-185`).

**`W/lib/theme.ts`** (92 lines)
- `themeFor(mode)` = `themeRuntime(mode)` (14-15).
- CSS variable strings, not colours: `HUE` (amber, cyan, violet, crimson, steel, indigo, gold, orange, yellow, lime, blue, pink) as `var(--color-*)` (19-32); `HUE_TEXT` (38-45); `RAISE`, `WELL`, `INK`, `DIM`, `FAINT`, `GREEN` (51-56).
- `accentColor(color)`: palette colour to `var(--color-<token>)`, a custom `#hex` as stored, default `var(--color-main)` (62-68). `borderColor` (74-78). `withAlpha`: `color-mix(in oklab, <var> N%, transparent)` for variables, `rgba()` for hex (80-91).
- Users of the variable strings on the canvas: NodeShell, GroupNode, TextNode, SeatCard, HarnessMark, `L/activity.ts:41-47`. These all assume a CSS engine resolves them.
- Users of resolved values (`themeFor` or `themeRuntime`): `L/activity-atlas.ts:239`, `L/kind-band.ts:98`, `SH/kind-icon.ts:29`, `SH/agent-portrait.ts:327`, `SH/svg.ts:18`, `C/CanvasMagnifier.tsx:22`, `C/Canvas.tsx:1331, 1557`, `L/terminal-theme.ts:29`, `L/region-word-ink.ts:15-16`, pad and machine-figure files, `src/app/index.ts:802, 1131, 1151`.

**How a mode switch is observed**
- `themeMode$ = observable<ThemeMode>("dark")`; `apply` sets it and sets or deletes `html[data-theme]`; it follows the `appearance.theme` setting and `matchMedia("(prefers-color-scheme: light)")` (`L/theme-mode.ts:13-45`).
- Seats read it through `SeatViewSource { theme, tier, portraits }` with `useSyncExternalStore`; the live source is mounted at `W/main.tsx:228-230` (`C/seat-view-source.tsx:12-59`, `C/LiveSeatViewSource.tsx:22-40`). KindSeat reads `use$(themeMode$)` (`N/KindSeat.tsx:103`); the magnifier subscribes with `themeMode$.onChange` (`C/CanvasMagnifier.tsx:393`).
- On a switch: CSS variables flip by selector; the atlas image flips by selector; portraits, kind icons and bands regenerate their data URIs for the new mode.

**OKLCH to RGB**
- `oklchToHex` (`T/oklch.ts:41-55`): `a = c cos h`, `b = c sin h`; `l_ = (l + 0.3963377774a + 0.2158037573b)^3`, `m_ = (l - 0.1055613458a - 0.0638541728b)^3`, `s_ = (l - 0.0894841775a - 1.291485548b)^3`; linear `r = 4.0767416621 l_ - 3.3077115913 m_ + 0.2309699292 s_`, `g = -1.2684380046 l_ + 2.6097574011 m_ - 0.3413193965 s_`, `b = -0.0041960863 l_ - 0.7034186147 m_ + 1.707614701 s_`; then `Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255)` per channel (51). Out-of-gamut colours are clamped per channel, not gamut mapped.
- `srgbToLinear` and `linearToSrgb` are private (12-16). Nothing exported returns linear floats.
- CSS mixes are done by the browser in oklab. The runtime projection of a mix token is the base colour at an alpha. A mix of two opaque colours (kind-seat selected, preamble card, far region name) has no runtime projection; the only JS implementation of `color-mix(in oklab, ...)` is `L/region-word-ink.ts:19-39`, used off canvas.

**Scales**

| Scale | Values | Receipt |
|---|---|---|
| Fonts | `FONT_MONO = '"SF Mono", SFMono-Regular, Menlo, Consolas, monospace'`; `FONT_DISPLAY = '"Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", sans-serif'`; `FONT_BODY = '-apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif'` | `T/index.ts:41-48` |
| Text sizes | micro 8px, caption 9px (legacy), label 10px, body 11px, body-lg 12px, title 14px, display 18px, hero 24px, prose-xl 16px | `T/type.ts:12-27` |
| Tracking | flat 0, soft 0.04em, label 0.08em, eyebrow 0.14em | `T/type.ts:35-40` |
| Leading | compact 1.2, dense 1.35, body 1.45, open 1.6 | `T/type.ts:42-47` |
| Radii | sm 4px, md 6px, lg 8px, xl 12px, pill 999px | `T/shape.ts:10-17` |
| Weights | no token; literals 500, 600, 650, 700 | section 2 receipts |
| Strokes | no token; literals 1px, 1.5px, 2px, 2.5px, 3px, 4px, 6px, 8px, 10px | sections 2, 3, 6 |
| Shadows | colour tokens shadow-1 and shadow-2 only; geometry literal: `0 10px 28px`, `0 12px 30px`, `0 8px 22px`, `0 6px 18px`, `0 14px 34px`, `0 24px 80px` | sections 2, 5 |
| Spacing | no token file; Tailwind utilities and literals | not applicable |

- Root rendering hints: `font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased` (`W/styles.css:20-28`). Canvas ground: `style={{ background: fieldTheme.ground }}`, pane `radial-gradient(circle at 50% 50%, main 1.8%, transparent 45%)`, no ground pattern (`C/Canvas.tsx:1884`, `W/styles.css:1133-1138`).

**Tokens the canvas uses** (seen in the canvas CSS and TSX read)
- Neutrals: ground, raise, raise-2, inset, well, ink, ink-2, dim, faint.
- Mixes: stroke, stroke-hi, overlay-1, overlay-2, overlay-3, overlay-4, shadow-1, shadow-2, focus-ring.
- Roles: main, second, accent.
- Hues: amber, amber-fg, cyan, cyan-fg, crimson, crimson-fg, violet, steel, indigo, gold, orange, green, yellow, lime, blue, pink.
- Type: text-caption, text-label, text-body, text-body-lg, text-title, text-hero; tracking-soft; leading-compact, leading-dense, leading-open; font-mono, font-display.
- Radii: sm, md, lg, xl, pill.
- Off the scale, as literals: sizes 13px, 10.5px, 9px, 12.5px, 14px; tracking 0.12em, .1em, .14em, 0.06em, 0.05em; radii 10px, 14px, 28px, 13px, 2px, 3px, 5px; Tailwind `leading-snug`; custom swatch hexes `#f1d438`, `#9ed24d`, `#509de8`, `#e97ab2`, `#8fa3b0`, and any user hex painted as stored (`SH/canvas-colors.ts:9, 19-31`).
- Exact OKLCH values for both modes: `S/theme.generated.css:7-48` (dark) and `122-175` (bright).

## 8. Sizes and geometry constants

| Constant | Value | Receipt |
|---|---|---|
| `AGENT_NODE_SIZE` | 216 by 56 | `SH/node-geometry.ts:12` |
| `SEAT_RING_PX` | 52 | `SH/node-geometry.ts:15` |
| `NOTE_NODE_SIZE` | 220 by 84 | `SH/node-geometry.ts:53` |
| `SEAT_PORTRAIT_PX` | 34 | `N/AgentSeatView.tsx:15` |
| `portraitFor(px)` | `round(px * RING_HOLE_R / 20) * 2` | `C/SeatRing.tsx:26` |
| `RING_R`, `RING_W`, `RING_HOLE_R` | 7.2, 1.1, `RING_R - RING_W / 2 - 0.25` (6.4) in a 20-unit box | `L/activity-rings.ts:38-41` |
| `MARK_BOX`, `SCALE`, `MARK_CELL`, `MARK_ATLAS_COLS` | 20, 5.2, 104, 32 | `L/activity-atlas.ts:54-60` |
| Mark sizes | 20px default, 14px inline, 52px seat, 32px glance | `L/activity-atlas.ts:384-387` |
| `BAND_BOX`, `R`, `W` | 52, 24.1, 2.3 | `L/kind-band.ts:57-60` |
| `RING_FRAME_MS`, `RING_CYCLE_FRAMES`, `LAND_FRAMES`, `MARK_PHASE_MS` | 90, 32, 8, `896 * 90` | `SH/wire/rings.ts:57-67` |
| Tier thresholds, hysteresis | 0.62, 0.34, 0.2, 0.03 | `L/canvas-tier.ts:28-34` |
| `CAMERA_SETTLE_MS`, `SEAT_EASE_MS` | 160, 160 | `L/canvas-tier.ts:67, 210` |
| `FAR_RING_SCREEN_PX`, `OVERVIEW_RING_FLOOR_PX`, `SEAT_SCALE_MAX`, `SCALE_STEP`, `NODE_SCALE_MAX` | 40, 22, 5.2, 0.1, 6.7 | `L/canvas-tier.ts:86-109, 362` |
| On-screen test | `SEAT_UNITS = 240`, `SEAT_HEIGHT_UNITS = 96`, `RING_UNITS = 52`, `SCREEN_MARGIN_UNITS = 160` | `L/canvas-tier.ts:276-279` |
| `RING_GAP`, `RING_FOOTPRINT`, `FAR_RING_SLOT_SCALE` | 12, 1.16, 3 | `L/seat-ring-room.ts:26, 34`, `L/flow-nodes.ts:21` |
| Cluster | `SEAT_FLOOR_SCREEN_PX = 22`, `CLUSTER_GAP_PX = 4`, `RINGS_PER_SCREEN = 12` | `L/seat-clusters.ts:43-52` |
| Region glance | `GLANCE_START = 0.62`, `GLANCE_FULL = 0.34`, sub band 1.05 to 0.86, `STEP = 0.04` | `L/region-glance.ts:43-73` |
| Region name | min 40px, max 240px, `GLYPH_RATIO = 0.68`, `WIDTH_SHARE = 0.9`, `HEIGHT_SHARE = 0.6`, `MARGIN = 16` | `L/region-name-slot.ts:28-40` |
| Region chrome | title bar 24px, frame 12px, radius 14px, min 320 by 180, `REGION_NAME_MAX = 80`, `MAX_REGION_DEPTH = 8` | `S/region-title.css:4`, `N/GroupNode.tsx:354`, `SH/region-bounds.ts:8`, `SH/graph.ts:74` |
| Z | regions `0 + depth`, cards 32, reach summary 33, track 1000, bubble node 1001, hovered far seat 2000, clusters 3000 | `L/flow-nodes.ts:17-18`, `S/reach-preview.css:32`, `S/layers.css:19-23`, `N/preamble-bubble.css:37`, `S/canvas-lod.css:174-176, 264-277` |
| Spine | chip 28px, tag 22px, glyph 15px, far disc 26 screen px (floor 28px), far pip 11px, `SPINE_ROWS_MAX = 4`, `max-width: max(100%, 320px)` | `N/spine-card.css:28-62, 143-158, 314-366`, `N/SpineCard.tsx:72` |
| Handles | 9px dot, hit area `inset: -9px`; resizer min 170 by 72, bare 48 by 24; handle 10px | `W/styles.css:1495-1514, 1056`, `N/NodeShell.tsx:492-503` |
| Camera | `minZoom={0.15}`, `maxZoom={2.5}` | `C/Canvas.tsx:1881-1882` |

## 9. Surprising things

**Browser features a GPU renderer would have to reproduce by hand**
- `color-mix(in oklab, ...)` everywhere, including nested mixes and mixes of two opaque colours (`S/canvas-lod-regions.css:84-89`, `N/kind-seat.css:146-150`, `N/preamble-bubble.css:54-67`).
- Shell paint decided by the cascade: inline styles from NodeShell overridden by `!important` rules keyed on `:has(.kind-seat)` and `data-node-kind` (`N/kind-seat.css:133-150`, `S/factory-grammar.css:15-30`).
- Container query units `cqw` and `cqh` for far discs, leaves and the note tick (`N/spine-card.css:201-212, 314-319, 444-452`).
- CSS `zoom` on the portrait at far, and layout-time ring growth by `--mark-u` and a negative margin, chosen over a scale transform with a recorded measurement (`S/canvas-lod.css:87-104`).
- `mask` with SVG data URIs for far glyphs, `mask-image` with `1lh` for note overflow, `clip-path` triangles (`S/canvas-lod.css:220-246`, `W/styles.css:1938-1940`, `N/spine-card.css:165-195`).
- Text: ellipsis truncation, head truncation by `direction: rtl` with `<bdi>`, `-webkit-line-clamp: 2`, `max-h-[1lh]`, `text-wrap: balance`, `font-feature-settings`, `tabular-nums`, uppercase transforms, letter-spacing, system font fallback stacks, and a text-shadow halo in the ground colour (`N/spine-card.css:28-36, 215-218`, `N/preamble-bubble.css:123-134`, `W/styles.css:1929-1956`).
- `paint-order: stroke` on the crest; canvas `shadowBlur` glows and `destination-out` knock-outs baked into the atlas (`L/activity-atlas.ts:401`, `L/activity-rings.ts:55-59, 413-471`).
- Box-shadow used as rings, blurred drop shadows, inset shadows up to `inset 0 0 110px`, dashed borders and outlines with offsets, linear and radial gradients (sections 2, 3, 6).
- `filter: saturate()` with opacity for focus modes (`W/styles.css:1151-1166`).
- Pseudo-elements as drawn layers: `::before` for reach preview, the far halo, the note tick and the ring's band; `::after` for the reach summary (`content: attr(...)`), blocker and attention rings and region urgency.
- Native `title` tooltips, `:focus-visible` rings, and accessible names (`role="img"`, `aria-label`) on rings and nodes (`C/ActivityMark.tsx:399-401`, `L/flow-nodes.ts:238`).
- Visibility and occlusion come from IntersectionObserver and `elementFromPoint`; note overflow from ResizeObserver.

**Arbitrary HTML or images**
- No arbitrary HTML: notes never inject HTML (`L/note-markdown.tsx:7-9`).
- Arbitrary images: image file nodes through `ContentMedia`; note images through `ContentMedia` for content-store refs or a plain `<img loading="lazy">` for any safe URL (schemes `https?:`, `mailto:`, `/`, `#`, `junto-content:`) (`L/note-markdown.tsx:36-37, 180-212`). CSP `img-src 'self' data: blob: junto-content: junto-file:` (`index.html:7`).
- Generated SVG data URIs, re-made per theme: portraits, kind icons, kind band layers, far glyph masks. Vendor images inside HarnessMark.
- Live DOM mounted inside nodes: textareas, inputs, popovers, the work detail surfaces and the collaboration overlay (section 5).

**Mismatches worth knowing**
- `docs/node-card-language.md` describes Spines for every non-seat kind; comments in `C/browser/PageCard.tsx:14-21` and `C/terminal/TerminalCard.tsx:25-27` still say "Spines" though both render `KindCard` over `KindSeat`.
- The on-screen test uses 240 by 96 while seats are 216 by 56 (`L/canvas-tier.ts:276-279`, `SH/node-geometry.ts:12`).
- Far glyph keys include `board` and `requests`, which are not in the kind list read (`S/canvas-lod.css:240-246`, `L/flow-nodes.ts:52-68`).
- Wire verb colours are raw `oklch()` literals outside the theme (`S/factory-grammar.css:174-198`); the unused open button uses literal Tailwind cyan and white (`N/NodeShell.tsx:504-518`); `N/seat-message.css:43` uses `color-mix(in srgb, ...)`, the note image border too (`W/styles.css:2110-2137`).
- A second, older `AutomationsCard` lives in `C/work/WorkSurfaces.tsx:191-229`; the canvas uses the one in `C/automations/`.
- A second 2D renderer of cards already exists: `C/CanvasMagnifier.tsx` repaints cards on a canvas from `themeFor`, with fonts hard-coded as `ui-monospace, SFMono-Regular, Menlo, monospace` (22, 199-217); `SH/svg.ts:17-35, 136-138` renders cards headless to SVG with truncation by `(width - 24) / 7.5` characters.

## Not read

`C/region-crumb.css`; `S/kbd.css`; `W/styles.css` outside lines 1-60, 996-1255, 1476-1745, 1900-2360; `SH/agent-portrait.ts` beyond a grep (how a face is drawn); `SH/portrait-expression.ts`; `L/portrait-mood.ts`; `SH/wire/urgency.ts` beyond a grep; `SH/wire/seat-level.ts`; `L/seat-rollup.ts`; `L/seat-card-status.ts`; `L/automations-card.ts`; `tasksCardBody` and the rest of `C/work/WorkSurfaces.tsx`; `L/reach-preview.ts`; `SH/occupancy/derive.ts`; `C/work/ContentMedia`; `C/ui` beyond ToolbarPill (IconButton, TaskStateMark, Popover, `task-state.css`); `automations.css`, `git.css`; SeatAwarenessHover, SeatCollaborationBlock; the toolbar action components (Terminal, Task, Page, Customize, StartParams); `scripts/theme-build.ts` beyond a grep; `C/CanvasMagnifier.tsx` beyond a grep; the rest of `C/Canvas.tsx`; minimap, edges and the flows track (other agents' scope). The terminal card's name source and the exact `nameFontSize` formula were not pinned.
