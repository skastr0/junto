# GPU canvas: architecture

**Status:** agreed direction, not yet built. Decided by the operator in November 2026.
**Owner:** the Canvas team writes all of the code.
**Measuring:** the Performance team measures, and only once a build ships in a version.

Companions:

- [canvas-gpu-plan.md](canvas-gpu-plan.md): the work as eight parallel tracks, with a done-test each.
- [canvas-gpu-spike.md](canvas-gpu-spike.md): what the spike measured, and what it did not.
- [canvas-gpu-inventory/](canvas-gpu-inventory/README.md): what today's canvas does, file by
  file, with line receipts. Parity is checked against it.

This document says what must be true and recommends how. Where it says **must**, a
decision or a measurement stands behind it. Where it says **recommended**, the
mechanism is the Canvas team's to change, as long as the musts hold.

## 1. What is being replaced

Today the canvas is React Flow (`@xyflow/react` 12.11.2). Every card, handle,
ring and wire is DOM, and moving the camera costs main thread time in
proportion to what is on the board: about 25 ms per camera frame on the factory
board, against 8.3 ms for a frame at 120 Hz.

The replacement is one `<canvas>` drawn by WebGPU, inside the app's page, under
one React component that mounts once. The React app, the keyboard, the modals,
the bottom bar, the terminals and every other surface stay as they are, on top.
React Flow is deleted at the end.

27 files under `src/` import `@xyflow/react`, 147 CSS selector lines name
`.react-flow`, and 46 of 51 e2e specs depend on its DOM (43 by name, 3 through
a harness helper). The plan retires all of them in order.

## 2. Decisions already made

These are settled. They are quoted so nobody has to reopen them.

| Subject | The operator's words | What it means for the build |
| --- | --- | --- |
| Ownership | "the Canvas team is set and ready... they should own it, and the Performance team should collaborate on measuring, but only when the thing is shipped to a version" | Canvas writes the code. Performance measures shipped versions. |
| Where it runs | "I'd start with inside the app page first, as that'd be ideal" | One canvas in the page. A worker or a view of its own stays possible and is chosen only by measurement. |
| The component | A new fat React `Canvas` component, "ideally leveraging legend state as much as possible to not risk react renders messing up with it" | React mounts it once. Everything after that reaches the canvas through Legend-State observers, never through a render. |
| Terminals | "there are and wont be live terminals on the canvas" | No live DOM inside a card, now or later. |
| Design system | "We cannot have something that obviously looks different from the rest of the app. And that communication path between this GPU piece and the overall CSS and styling of the overall app needs to be a primary objective." | Section 7. It is tested, not hoped for. |
| Motion | "several aesthetic and design details of the app aren't just flourish, they are actual features... the rings, for example, they're a crucial part of the attention mechanism". "If it works on the page main thread, then so be it. Otherwise, we can see if a worker works best or not." | Section 10. No ring, pulse or track is ever slowed, stepped, throttled or stilled to save work. Where the frame loop runs is decided by whether motion holds, not by the law's wording. |
| The switch | "We can have a switch as a feature flag in the experimental settings where we can toggle, especially if it's something we can toggle with the app open, on the fly... would allow us to ship a version earlier." | Section 21. One experimental key, live. |
| No GPU | "We make it a GPU a hard dependency and have a toggle that turns off the Canvas, but I really don't want to support a crappy no-GPU Canvas... If anything, we make another screen that doesn't have any Canvas" | Section 21. No second renderer, ever. |
| Chromium | "We can update Electron, ship whatever Chromium shit we need" | Chromium switches and Electron upgrades are available. |
| Accessibility | "I'm ok with loss of accessibility structure for now... the canvas is at this point, from now on, equivalent to a video game so we'll focus on making the auxiliary UI accessible" | Section 24. |
| 2.5D | "at least 2.5d ready, not necessarily that we're doing anything right now, but ensuring we're not blocked" | Section 23. Conventions only, no features. |
| React Flow | "we aim towards deleting React Flow... let's create our own thing. Let's create our own small SDKs and wrappers and libraries... we're only implementing the basics that we need for what we use. We're not trying to saturate a Canvas library space." | Section 4. Small pure modules for what the app uses today, and nothing more. |

## 3. What must be true

1. **It looks like the app.** Every colour, radius, font and size the canvas
   draws comes from `src/shared/theme/`. No colour literal exists in canvas
   code. An image comparison test holds the GPU cards against the DOM versions
   of the same cards.
2. **Motion is a feature.** Rings, pulses, tracks and bands keep today's tempo,
   easing and shared wall clock. Nothing visible drops below the display's
   rate to save work. Motion no one can see may stop.
3. **React does not render on a camera move, a seat report or a drag.** The
   canvas component renders once. Data arrives through observers.
4. **A camera frame costs the same on any board.** Script time per camera
   frame does not grow with the number of cards.
5. **One row changed means one record rewritten.** A seat report rewrites that
   seat's bytes and nothing else. This is `AGENTS.md`'s "one command must
   change one row" carried to the GPU.
6. **The write path does not change.** The canvas emits the commands it emits
   today, through the writers in `src/window/lib/model-edits.ts` and
   `commitCommands`. Undo, redo and the optimistic store are untouched.
7. **Paint order is exact.** A card on top covers every part of the card under
   it, text included.
8. **One function converts screen to board, and one converts back.** Nothing
   else does that arithmetic.
9. **The engine can move.** Engine code imports nothing from React,
   Legend-State or the DOM, and talks in plain data. Moving it to a worker or
   a view of its own is a relocation, not a rewrite.
10. **The GPU is required.** There is no second renderer.
11. **Both canvases live behind one seam until the new one is the only one.**
    The switch is live. The old canvas is deleted, not kept.
12. **2.5D is not blocked.** The conventions in section 23 hold from the first
    commit.
13. **Only what we use.** No feature React Flow has and Junto does not use is
    rebuilt.

## 4. Shape

```
  Legend-State stores                         React (mounts once)
  modelStore, agentSeat$, state$, ...          <Canvas> shell, overlay islands
          |                                            |
          v                                            v
   +-------------+   facts (plain data)   +-------------------------+
   |    feed     | ---------------------> |         engine          |
   | observers,  |                        |  scene   paint   text   |
   | derivations | <--------------------- |  camera  pick    images |
   +-------------+   intents, frame facts |  interaction  renderer  |
          |                               +-------------------------+
          v                                            |
   model-edits.ts, commitCommands                      v
   (today's write path, unchanged)                 one <canvas>
```

Recommended layout, under `src/window/canvas/`:

| Folder | Holds | May import |
| --- | --- | --- |
| `engine/` | Scene, camera, picking, the pointer machine, the renderer, text and image caches, the frame loop | `src/shared/` only. No React, no Legend-State, no `document`, no `window` beyond what it is handed. |
| `paint/` | One pure function per card kind and for regions and wires: facts in, drawing records out | `src/shared/` only |
| `feed/` | Legend-State observers that turn store changes into facts, and the derivations that used to live inside mounted cards | Stores, `engine/` types |
| `shell/` | `Canvas.tsx`, the `CanvasApi`, the overlay, the test hook | React, `feed/`, `engine/` |

The engine's whole surface, as a sketch (names are suggestions, the shape is the contract):

```ts
interface Engine {
  apply(ops: ReadonlyArray<SceneOp>): void;   // facts in; taken at the next frame
  input(event: CanvasInput): void;            // pointer, wheel, modifiers, resize, visibility
  moveCamera(to: CameraTarget, opts?: { durationMs?: number }): void;
  pick(screen: Point): Hit | null;
  onIntent(listener: (intent: Intent) => void): () => void;   // select, move, resize, connect, open, menu, hover
  onFrame(listener: (facts: FrameFacts) => void): () => void; // camera, tier, anchored rects
  dispose(): void;
}
```

Three rules keep it honest:

- **Facts in, never drawing instructions.** The feed sends a node's row, its
  derived facts (region depth, ring cap, blocked) and its live facts (ring
  state, line text). `paint/` turns them into records inside the engine, so a
  tier change or a theme switch repaints without the feed.
- **Intents out, never commands.** The engine says "these cards were dropped
  here". The shell turns that into `syncPositions` and one `Move`.
- **Everything the engine needs from the browser is handed to it.** The
  canvas, a clock, a frame scheduler, and a `rasterize` function for images.
  Tests hand it fakes.

### What carries over unchanged

These are pure today and import nothing from React or React Flow. Reuse them as they are.

| Module | What it is |
| --- | --- |
| `src/shared/wire-route.ts`, `wire-sides.ts`, `canvas-wire-path.ts` | The wire router, side choice, path builder |
| `src/window/lib/wire-loom.ts`, `flow-track.ts`, `wire-pulse.ts`, planners in `loom-view.ts` | Cable planning, track geometry, pulse planning |
| `src/shared/wire/rings.ts` | The ring language: `ringState`, `RING_MOTION`, the clock constants |
| `src/window/lib/activity-rings.ts`, the painter in `activity-atlas.ts` | The ring art |
| `src/window/lib/canvas-tier.ts` (the pure parts), `seat-ring-room.ts`, `seat-clusters.ts`, `region-name-slot.ts`, `region-glance.ts`, `region-urgency.ts` | Tiers, ring room, clusters, region names and urgency |
| `src/shared/node-geometry.ts`, `src/shared/model/canvas.ts` | Sizes, region membership |
| `src/window/lib/model-edits.ts`, `mutations.ts`, `model-authoring.ts`, `model-store.ts`, `geometry.ts` | The write path |
| `parseBlocks`, `parseInline` in `src/window/lib/note-markdown.tsx` | The note parser |
| `src/shared/agent-portrait.ts`, `kind-icon.ts`, `src/window/lib/kind-band.ts` | Portrait, icon and band art, as SVG |

### Our own small modules

React Flow's controllers (`XYDrag`, `XYPanZoom`, `XYMinimap`, `XYResizer`,
`XYHandle`) are bound to the DOM and to d3 and cannot be reused. Its useful
pure maths is small. Write these, each with unit tests, and nothing beyond them:

| Module | Replaces | Size |
| --- | --- | --- |
| Camera maths: screen to board, board to screen, zoom about a point, bounds to camera, smooth zoom interpolation | `screenToFlowPosition`, `getViewportForBounds`, d3 `interpolateZoom` | small |
| Bounds of a set of rectangles | `getNodesBounds` | tiny |
| Elbow path as points | `getSmoothStepPath` (the fallback wire) | small |
| Spatial index over rectangles and polylines | DOM hit testing | small |
| Pointer machine | `XYDrag`, `XYResizer`, `XYHandle`, selection | the largest; section 15 |
| Edge auto-pan | `calcAutoPan` | tiny |

## 5. The frame

One `requestAnimationFrame` loop owns everything visible. Each frame, in order:

1. Take the input that arrived since the last frame (wheel deltas summed,
   the last pointer position, key state).
2. Step the pointer machine and the camera (gesture, keyboard pan, camera
   animation, edge auto-pan).
3. Take the staged facts and repaint only the cards they touch.
4. Rasterize queued text and images within a time budget; the rest waits.
5. Upload the byte ranges that changed.
6. Draw.
7. Report frame facts: camera, tier, and the screen rectangles of anchored
   cards. The shell writes those straight to overlay elements' styles.

Rules:

- The loop draws every display frame while anything visible moves: a ring, a
  pulse, a track, a transition, the camera, a drag. It may skip drawing only
  when the picture would be identical.
- It never lowers its own rate, never skips a frame to catch up, and holds no
  timer. Work that does not fit (text and image rasterizing) is queued, not
  motion.
- It stops when no one can see the canvas: the page is hidden, or an opaque
  surface covers the whole canvas (today's `mark-occlusion.ts` rule, applied
  to the canvas as a whole).
- The clock and the scheduler are injected, so no test waits on a real clock.
- React's StrictMode mounts twice in development and device creation is
  asynchronous: creating, disposing before ready, and creating again must all
  be safe.
- The device can be lost (sleep, a GPU process restart). The engine recreates
  it and uploads the scene again, from its own records.

The wheel listener must be registered with `{ passive: false }` and call
`preventDefault()`. A passive listener makes Chromium treat the gesture as a
scroll, which alone dropped 7% of refreshes at 120 Hz and 22% at 60 Hz in the
spike.

### Where the loop runs

It starts on the page's main thread, by decision. The spike found that there a
long task on the page stalls the canvas for as long as the task lasts, and the
installed app under 30 agents showed tasks of 280 to 440 ms. Today's rings do
not have that problem, because CSS animation runs off the main thread. So the
first shipped version measures two things on the real app: dropped frames per
gesture, and dropped frames at rest while rings turn under fleet load. If rings
hold, the main thread stays. If they do not, the engine moves to a worker, then
to a view of its own, in that order, with no change to its code beyond where it
is started. The spike's worker result was poor and never explained, so that
move is an investigation, not a given.

## 6. Scene and records

**Must:** fixed-size records in GPU buffers, each at a stable slot; a change
rewrites bytes in place; no allocation per frame; paint order exact.

**Recommended:** one record type, the quad, drawn by one pipeline, in one
ordered list.

A card is a handful of quads: a shell, a ring, a portrait, two lines of text.
A quad is one of four kinds:

| Kind | Draws | Used for |
| --- | --- | --- |
| shape | A rounded rectangle from a style: fill (flat or a two-stop gradient), stroke (solid or dashed), per-corner radii; also a disc and a triangle | Shells, region frames, chips, handles, outlines, focus rings, the marquee |
| shadow | A blurred rounded rectangle, outside or inset | Card shadows, region urgency glows |
| sprite | A cell of an image atlas, with an optional motion | Rings and their moving parts, portraits, icons, bands, glyph masks, media |
| text | A cell of the text atlas, tinted by a style colour | Every run of text |

What a quad record carries:

| Field | Meaning |
| --- | --- |
| rectangle | Position and size in board units, relative to its card |
| owner | The card it belongs to, so a drag moves one offset, not every quad |
| source | Atlas cell (sprite, text) or radii (shape) |
| style, previous style, change time | Indexes into the style table (section 7); two of them and a time give a transition |
| tier mask | At which of near, mid, far and overview it is drawn |
| scale rule | Board-scaled, or held at a screen size around an anchor (far rings, far discs, name tags) |
| motion | None, or one of the ring and band motions with its period (section 10) |
| elevation | Height above the board, zero today (section 23) |

Paint order is a separate small list: for each position, which slot to draw.
Records never move when the order changes; a restack rewrites the list. The
list is contiguous by band, so each band is one draw call:

| Band | Contents | Today's z |
| --- | --- | --- |
| ground | The field and its radial wash | under everything |
| regions | Region quads, by depth | 0 plus depth |
| wires | Wire meshes at rest | 16 |
| cards | Card quads by model `z`, then id | 32 |
| tracks | Flow tracks and wire pulses | 1000 |
| lifted | A card with a preamble bubble, a hovered far seat, cluster badges, handles, the marquee, a card being dragged | 1001 to 3000 |

Wires are not quads. Each wire is a strip of triangles along its route (section
13), in its own buffer, with one small record per wire for its colour, opacity
and pulse.

The reason for one ordered list, and against one pipeline per kind as in the
spike: with separate pipelines the text of a lower card draws over the shell of
the card above it. Shells are translucent, so a depth buffer cannot fix it.

Culling: a grid over the board (the spike used 512 units for hits and 1536 for
text) gives the visible set. Cull by whole cards.

## 7. The design system bridge

This is a primary objective, by decision. It has five parts.

### One source

`src/shared/theme/` stays the one source. Today it has two projections: CSS
(`theme.generated.css`) and `themeRuntime(mode)` (hex and `rgba()` strings).
Add a third, for the canvas: `themeGpu(mode)`, numbers ready for a buffer.

The canvas reads colour, type and shape only through that projection and
through `TEXT_SIZES`, `TRACKING`, `LEADING`, `RADIUS` and the font stacks.
Three things the canvas needs are not in the theme source today. Move them in,
so CSS and the canvas read one value:

- The wire verb colours, which are raw `oklch()` literals in
  `src/window/styles/factory-grammar.css:173-197`.
- Shadow geometry, border widths and motion durations. `src/shared/theme/index.ts`
  says these "have no tokens yet"; the cards use literals such as
  `0 10px 28px`, `1.5px` and `.18s`.
- The card measurements that are literals in CSS today (the 13px name, the
  10.5px line, the `28px 14px 14px 28px` seat radius). They become named
  constants in one card spec module that `paint/` reads. The DOM seat, which
  still shows in the tour, the gallery and the agent modal, should read the
  same constants.

### Styles, not colours

**Recommended:** records name a style by index and never hold a colour. A
style is what a CSS class is today: fill, stroke, stroke width, radii, shadow.
The style table is computed from tokens, per mode, into one small buffer.

- A theme switch rewrites the style table. No record changes.
- A hover or a selection sets a record's style, keeps the previous one, and
  stamps the time. The shader blends the two over the token's duration. That is
  today's `.18s ease` on border and shadow.
- A style that depends on a card's own colour (a region tint, a kind hue, a
  custom hex) is made on first use, keyed by recipe and colour. There are few
  colours, so the table stays small.

### The same arithmetic as CSS

- **Blend the way the browser does.** CSS composites gamma-encoded sRGB with
  premultiplied alpha. Use a canvas format that is not an `-srgb` view, write
  encoded values, and keep atlas textures unconverted, so a 7% wire over a
  card comes out as the DOM would draw it.
- **Mix the way the browser does.** The cards use `color-mix(in oklab, ...)`
  everywhere, including mixes of two opaque colours, which `themeRuntime` cannot
  express. Put one `mixOklab` in `src/shared/theme/` (the only implementation
  today is private to `src/window/lib/region-word-ink.ts:19-39`) and build
  styles with it.
- **One colour on every screen.** Every primitive sits inside sRGB (`inSrgb` in
  `src/shared/theme/oklch.ts`, held by `tests/theme-gamut.test.ts`), so a
  token's hex is exact and the canvas needs no colour-space handling of its
  own. Eight tokens used to lie outside and were pinned in `a9ef0a3bb`. If a
  colour needs to change, change the token; never adjust it in canvas code.
- **Dimming.** Focus modes fade a card to 22% and desaturate it. Recommended:
  mix the finished colour toward the ground and desaturate in the shader. Over
  the ground that equals group opacity; over a region wash it differs slightly.
  It is on the deviation list (section 26).

### Fonts

No font file ships. The three stacks are system fonts. Text is rasterized by
the browser from those same stacks (section 8), so the canvas cannot drift from
the DOM in font, weight or hinting.

### The lock

- A lint: no hex, `rgb(`, `oklch(` or named colour under `src/window/canvas/`.
- A look test: a gallery page shows each card kind in each state twice, once
  as today's DOM component and once drawn by the engine, and a test compares
  the two images within a tolerance, in both themes. The app has no screenshot
  assertion today; this is the first, and it is what makes "looks like the
  app" a gate.
- Controls that float over the canvas (toolbars, menus, editors) are ordinary
  kit components in the DOM, so they match by construction.

## 8. Text

**Must:** text on the canvas is indistinguishable from the same text in the
DOM at rest, on a 1x display as well as a 2x one, in every script the app
shows.

**Recommended:** the browser rasterizes whole runs, and the engine caches them.

A run is one piece of text in one style: a seat's name, its line, one line of
a note. The engine draws it with canvas 2D `fillText`, in the token's font
stack, at the size it will have on screen in device pixels, into an atlas. A
run is one quad. The browser does the shaping, kerning, fallback fonts, emoji,
`font-feature-settings`, tabular figures and letter spacing, exactly as it
does for the DOM.

Why not the spike's distance-field glyphs: distance-field text goes soft at
small sizes, and a 1920 by 1080 display such as the Mac mini's shows card text
at 10 to 13 device pixels. They also covered ASCII only. This is a design
judgment, not a measurement; the look test is what settles it.

| Concern | Rule |
| --- | --- |
| Colour | The atlas holds coverage only; the style colours it. Coverage is rasterized for the run's ink, not for white: Skia's mask pre-blend picks its correcting table by paint luminance, so the alpha must be the coverage Chromium computes for that colour or the text reads heavier than the DOM's. Text cells key on theme and ink like sprite cells do, so a theme switch re-rasters them queued. Colour emoji go to a second, colour atlas. |
| Zoom | A run is rasterized for the scale it is shown at. During a gesture the existing raster is scaled; a run more than about a quarter off its scale is queued again. All visible runs are exact once the camera rests (`CAMERA_SETTLE_MS = 160`). |
| Budget | Rasterizing is queued and capped per frame. A late raster shows the previous text one frame longer; it never delays a frame. |
| Changing text | A seat's line changes with each report (30 a second in the probes). The run is redrawn into its own cell. |
| Truncation | Ellipsis, head truncation (paths), and the two-line clamp are computed with `measureText`, once per text and width. |
| Halo | Spine cards, notes and labels have a ground-coloured `text-shadow`. Rasterize it as a second channel of the same run. |
| Memory | Evict by least recent use against a byte cap. |

Notes are the one place with real layout: headings, lists, fenced code, quotes,
rules, links and images. Write one pure layout function over `parseBlocks` and
`parseInline` that returns positioned runs, rules, boxes and image slots for a
width. At mid tier a note shows its first block; at far tier, an amber tick.
The typography is in the cards inventory, section 2.4.

## 9. Images

Portraits, kind icons and kind bands are generated SVG. Note and file images
are arbitrary bitmaps from the content store.

- One image atlas, keyed by content and size. The shell rasterizes (SVG data
  URI or content ref in, bitmap out) and hands the bitmap to the engine,
  because decoding SVG needs a document. The engine never fetches.
- Portraits, icons and bands are regenerated per theme, as today.
- A portrait changes expression with a 220 ms cross-fade: two sprites and a
  transition.
- Far-tier glyphs (`mask` with an SVG today) are coverage sprites tinted by a
  style.

## 10. Rings and motion

### The ring language does not change

`src/shared/wire/rings.ts` decides what a ring says: `ringState(input)` returns
a form (work, reverse, snake, call, wait, halt, glint, fracture, dot, live,
rest, off, done), a tone, and whether it carries a glow, a halo or a flag. It
already serves two painters, the desktop's DOM and the phone's native canvas.
The GPU canvas reads the same answer. Nothing about what a ring means is
decided in canvas code.

### The same art

The DOM ring is a sprite sheet: `activity-atlas.ts` paints every ring cell
once per theme with canvas 2D (`paintAtlas`), publishes it as an image, and CSS
moves child elements that each show one cell. The GPU canvas uploads that same
painted canvas as a texture and draws the same cells: a still base, the band
cell (glow, halo, flag), and the moving part. Export the painted canvas from
`activity-atlas.ts` beside the data URL it returns today. One painter, so the
two cannot drift.

### The same motion, from the same clock

Every moving part is one of five motions. Each is a few lines of shader:

| Motion | What it does | Used by |
| --- | --- | --- |
| turn | Rotate 0 to 360 degrees, linear, either direction | work (1440 ms), reverse (2880), snake (5040), wait (5760), fracture (11520), glint |
| send | Scale 1 to 1.31 while opacity falls 1 to 0 by 81.25% of the period | call (1440) |
| beat | Opacity 0, 1, 0, 0.55, 0 at fixed stops | halt (1440) |
| breathe | Opacity 0, 1, 0, ease in-out | dot, live, glint (2880) |
| land | Once: scale 0.82 to 1, opacity 0 to 1, 720 ms | done |

- Periods come from `RING_MOTION`. The engine holds no tempo of its own.
- Phase is wall time modulo `MARK_PHASE_MS`, the rule the DOM uses
  (`--mark-t0`), taken from the frame's timestamp plus `performance.timeOrigin`.
  A DOM ring in a side panel and the same seat's ring on the canvas turn in
  step, and so does the phone.
- Easing curves are sampled from a small lookup texture built from the same
  cubic-bezier numbers.
- `land` plays once from the time the seat's state changed, which the record
  carries.

Kind bands move the same way (chase, shimmer, hand, scan, orbit, pulse,
breathe, blink, ripple, glint, shake; periods in the cards inventory, section
4): still layers plus one moving layer, on the same clock.

### Other motion on cards

| Motion today | On the GPU |
| --- | --- |
| Hover and selection: border, shadow, 1px lift, `.18s` and `.16s ease` | Style transition; the lift is two offsets and a time |
| Focus dimming, `0.18s ease` | Style transition |
| Far seat ring resize, 160 ms after the camera rests | A scale value set by the engine (section 11) |
| Preamble line: 3px rise and fade, 0.2 s | Transition on the bubble's text quad |
| Reach preview: breathe 1.44 s | A motion on the outline quad |
| Region title and frame strips: hover wash, `.16s` | Style transition |

### The law and its lock

`AGENTS.md` says motion never runs on the main thread, and
`tests/motion-law.test.ts` enforces it for DOM rings: no frame callbacks or
timers in the ring sources, keyframes that touch only `transform` and
`opacity`. The operator's ruling is that the canvas may draw rings from a frame
loop on the main thread if motion holds there.

What that means for the lock, which only the operator may change, named in the
commit:

- The existing assertions stay for DOM rings. Rings remain DOM everywhere off
  the canvas: rows, the palette, the tour, the agent modal's rail.
- The assertions that name React Flow selectors and files (reach preview,
  wire pulse, the minimap root, `FlowTrack.tsx`, `SeatClusterLayer.tsx`,
  `canvas-lod.css`) are replaced by canvas equivalents in the same commit that
  deletes what they name.
- New assertions for the canvas: its motion table is built from `RING_MOTION`
  and has no numbers of its own; the frame loop holds no timer and draws on
  every tick while any visible quad moves (a unit test with a fake clock
  counts draws); phase is continuous, never stepped.
- The law's text gets a canvas clause. Draft for the operator: "On the canvas,
  rings are drawn every display frame by the canvas's frame loop, from the
  shared clock."

Motion stops only where it stops today: the page is hidden, the operator
asked for reduced motion (`data-surface-motion="paused"`), the ring is off
screen, or it is wholly covered by an opaque surface.

## 11. Cards at each tier

Tiers keep today's thresholds and hysteresis from `canvas-tier.ts`: near at
0.62, mid at 0.34, far at 0.2, hysteresis 0.03. The engine computes the tier
from its camera with the existing function and publishes `canvasTier$` and
`data-canvas-tier`, which the rest of the app reads. The tier reaches the
shader as one value; each quad's tier mask says where it is drawn. Crossing a
tier costs nothing.

The three zoom-dependent scales (`--far-seat-scale`, `--seat-floor-scale`,
`--node-s`) become three engine values computed by the existing functions,
plus each seat's ring cap in its record. Today they are written to card DOM by
query after the camera rests, because restyling is expensive. That reason is
gone; whether they stay stepped and eased on rest, or track the zoom every
frame, is a look decision (section 26). The mechanism supports both.

What each card is, by tier. Exact sizes, paddings and colours are in the cards
inventory, sections 2 and 3.

| Card | Near | Mid | Far | Overview |
| --- | --- | --- | --- | --- |
| Agent seat (216 by 56) | Shell, ring with glow, halo and flag, portrait, harness badge, overseer crest, name, one line, task strip, preamble bubble | Name only; no shadow, badge or bubble | Ring and portrait held at 40 screen px within the ring cap; shell gone; name tag on hover or selection; urgency halo | Same with a 22 px floor; close seats gather into cluster badges |
| Kind seat: terminal, task, artifacts, automations, page, git, files, link, file | Shell, ring, ledger band, icon, name, line | Name only | Ring and icon; band hidden | As far |
| Spine card: peer, stub | Chip, status tag, leaf, up to four rows | As near, no shadow | A disc with a glyph and a status pip | Hidden |
| Note | Callout with rendered markdown | First block only | Amber tick | Hidden |
| Label | Display text, 24px | Same | Text held at a screen size | Hidden |
| Image file | Card shell and the image | Same | Tinted box with a glyph | Hidden |
| Region | Gradient fill, border, title bar, frame strips | Flat fill, 3px outline, name fades in | Wash, 6px outline, large name | 10px outline; depth 3 hidden |

Notes for the build:

- `docs/node-card-language.md` says every non-seat kind is a Spines card. The
  code disagrees: only peer and stub are. Follow the code.
- Seat clusters are computed today by reading ring state out of card DOM. The
  pure grouping in `seat-clusters.ts` stays; its input becomes the feed's seat
  facts.
- The cards also draw things that are easy to miss: the blocked ring and
  crimson gradient on default cards, the dashed drop target on a files card,
  the reach preview outline and its summary pill, the "empty note" text. The
  inventory's states table (2.7) is the checklist.

## 12. Regions

- Membership is derived, never stored: a card is inside a region when its
  whole rectangle is (`frameContains`). Depth, parent and the stack come from
  `regionStack`. The feed computes these once per change and sends them as
  facts, as `flow-nodes.ts` does today.
- Names at mid and far zoom come from `region-name-slot.ts` (the largest clear
  rectangle) and fade by `region-glance.ts`. Both are pure; reuse them.
- Urgency rollups come from `region-urgency.ts`. Direct and held urgency draw
  as inset glows (shadow quads).
- A region is not selectable by marquee and takes the pointer only on its
  title bar and frame strips. With `region.hold`, dragging it carries the
  cards whose centres lie inside.

## 13. Wires

**Reuse the router and the loom unchanged.** Replace only what reads React Flow.

| Today | Becomes |
| --- | --- |
| `CanvasLoom.tsx` reads positions and measured sizes from React Flow's `nodeLookup` | A feed module that gives the same planners rectangles from the model. Export the pure helpers it keeps private today (`specsOf`, `laneOffsets`, `buildInputs`, `movedNodeIds`, `collectObstacles`). |
| The route is an SVG path string, parsed back by regex in three places | Carry the router's `points` through `LoomRoute`. The string stays only while the old canvas lives. |
| `WireEdge.tsx`, `FlowTrack.tsx`, `WirePulse.tsx`, `WirePulseFeed.tsx` | Drawn by the engine |
| The fallback elbow from `getSmoothStepPath` | Our own elbow, as points |

Behaviour to keep:

- Three sources of a path: a cable strand when three or more wires share a
  handle (`LANE_GAP 3`), a planned route (`routeWire`, padding 14), and the
  fallback elbow, corner radius 8.
- Sides are always recomputed by `wireSides`; stored sides do not steer
  painting.
- Routing runs only when the board is settled. While a card is dragged, its
  wires drop to the fallback elbow. Only wires whose cause is moved, changed
  or dragged are routed again (`ROUTE_REACH 56`).

Drawing:

- Each wire is a strip of triangles along its points, corners rounded as short
  arcs, with distance along the wire at every vertex. **The strip must not
  overlap itself**: wires rest at 7% opacity, where any double coverage shows
  as a dot.
- Width is `WIRE_WIDTH = 1.2` board units. Opacity is 0.07 at rest, 0.9 while
  the loupe is held or a connection is being made, 1 in a focus cone; the far
  tier multiplies by 0.4; the overview hides wires except tracks. These are
  per-wire or global values, never a rebuild.
- Flow tracks (verbs flows and derives) are chevrons placed by distance along
  the wire in the shader: period 18 units, 450 ms per period, derives breathes
  at 1600 ms, scaled by tier (1, 1.75, 3, 5), phased by the wall clock.
- A pulse is a lit span moving along the wire: one per wire, at most 24 at
  once, 900 ms with `cubic-bezier(.45, 0, .55, 1)`, width 3.2, 16% of the
  wire's length, near tier only, in violet, amber or green. `wire-pulse.ts`
  plans them; a pulse rewrites one value in the wire's record.
- Selected and hovered wires glow in their own hue. Today that is a CSS
  `drop-shadow`; draw a wider soft pass under the wire.
- A wire can be hit only in loupe or cone mode, within 20 units (3 for a cable
  member).
- The connection preview is React Flow's default curve in its own grey
  (`#b1b1b7`), a colour from outside the design system. Draw ours with a token.

Everything else about wires is in the wires inventory.

## 14. Camera

The camera is `{x, y, zoom}` today and is held as a matrix (section 23). It
lives in the engine. The shell mirrors it into an observable once per changed
frame for the few consumers that need it.

Behaviour to keep, all from today's code:

| Input | Result |
| --- | --- |
| Zoom range | 0.15 to 2.5 |
| Wheel | Pans, `-(delta / zoom) * 1.2` |
| Pinch, or ctrl+wheel | Zooms about the pointer by `2 ^ (-deltaY * 0.002 * (ctrl on macOS ? 10 : 1))` |
| Cmd+wheel | Zooms |
| Middle-button drag | Pans |
| Arrows, WASD | Pan at 900 px/s; Shift 2.4x; ramp 130 ms; longest step 64 ms |
| Cmd+Equal, Cmd+Minus | Zoom by 1.2 over 160 ms |
| Cmd+0 | Zoom to 1 over 200 ms |
| Fit view | Padding 0.18; max zoom 1.15 with regions, else 1.35; 320 ms |
| Focus a card | Padding 0.35; max zoom 1.45; 360 ms |
| Minimap click | Centre there, 240 ms; double click zooms to `clamp(zoom * 1.55, 0.35, 1.6)`, 280 ms |
| Cluster click | 260 ms |
| Camera moves | Cubic in-out easing over the smooth zoom path |
| Rest | The camera counts as settled after 160 ms |

Off, and to stay off: Space to pan, double-click zoom, snapping. The camera is
not saved per canvas; the opening camera comes from `openingViewport`.

While both canvases exist, the camera is handed across the switch: the canvas
that unmounts leaves its camera for the one that mounts.

## 15. Interaction

**Recommended:** one pointer machine, pure: `(state, event) -> (state,
effects)`. It is the largest new module and the one most worth a test table.

Picking is one function over the spatial index, aware of paint order. It
returns a card and a part:

| Part | Leads to |
| --- | --- |
| pane | Marquee, context menu, deselect |
| card body | Select, drag, open, context menu |
| resize handle | Resize |
| connect handle (side, source or target) | Connect |
| verb zone | A connection lands with that verb |
| ring flag | Opens the needs-you feed |
| task enqueue | Adds a task |
| bubble close, note link, image | Their own actions |
| region title bar, frame strip | Region drag, region select |
| wire | Select, only in loupe or cone mode |
| cluster badge | Camera moves to the cluster |

Gestures, with today's numbers:

| Gesture | Rule |
| --- | --- |
| Click | Selects one card; Shift toggles it in the selection |
| Left drag on the pane | Marquee; a card is taken when partly inside; regions never |
| Drag a card | Starts after 1 px; moves the whole selection; the engine moves the cards itself every frame and writes nothing; on drop, one `Move` with only the cards whose rounded position changed (`syncPositions`) |
| Drag a region | From its title bar or frame strips; with `region.hold`, riders are the cards whose centres lie inside |
| Resize | Cards min 170 by 72 (bare 48 by 24), regions min 320 by 180; seat cards, image and page cards are fixed; one `Move` with `size` on release |
| Connect | Eight handles a card, loose mode, snap radius 42; refused for region, label, git and files; a drop on a card body counts; when a pair offers two verbs, landing zones pick one (`VERB_ZONE_BLEED = 16`); otherwise the pair's first verb |
| Edge auto-pan | Speed 15 within 40 px of the edge, during drag, connect and marquee |
| Delete | Backspace or Delete asks first (`window.confirm` today), then one `Remove` |
| Right click | Pane: the add deck. Card: seat menu or target menu. Selection: the multi-select menu |
| Double click | Opens what the card opens today (a page in the dock, an image in focus, a work detail) |

Selection stays where it is, in `state$` (`selectedNodeId`, `selectedNodeIds`,
`selectedEdgeId`, `connectionFocusNodeId`). The engine is told the selection
as a fact and draws it. The one-shot requests (`focusNodeId`, `focusNodeIds`,
`fitViewRequest`, `editNodeId`) are observed by the shell and become camera
moves and overlay mounts.

Keys stay in `installKeyDispatcher(KEY_ACTIONS)`. The canvas element takes
focus where a card or the pane does today, and replaces `.react-flow__node` in
the focus law's scope selector.

Do not copy these without asking; they look like accidents. All were found by
reading; none was run in the app:

- A click and a double click on the empty pane probably do nothing today. The
  handler tests the event's click count, and React Flow calls it from a
  pointer-up, whose count is zero. The code means: click deselects, double
  click adds a note.
- React Flow's arrow-key nudge moves a selected card on screen without
  writing a command.
- The region-hold branch inside `Canvas.tsx` is unreachable.
- Click-to-connect comes with React Flow and nobody chose it.

## 16. Controls on cards and the overlay

The canvas draws and picks everything that is part of a card at rest:
handles, resize corners, verb zones, the ring's flag, the enqueue button, the
preamble bubble, region chrome, cluster badges. `AGENTS.md`'s card law (no
action buttons on nodes) continues to hold.

The DOM appears over the canvas only for what is being operated right now.
There are at most a handful of these at once:

| Control | Size follows | Shown when |
| --- | --- | --- |
| Node toolbar and its popovers | Screen | A card is selected |
| Rename input, label editor, note editor | The card (scaled with zoom) | Editing; the card's own text is hidden meanwhile |
| Collaboration hover card, cache status card, cluster member list | Screen | Hover |
| Context menus, the add deck | Screen | Right click |
| Region toolbar and its two modals | Screen | A region is selected |
| Work detail surfaces (tasks, git, artifacts, files, automations) | Screen | Opened from a card; today they mount inside the card's React tree and need a host of their own |
| Tooltips | Screen | Native `title` today; set the canvas element's `title` from the hovered part |

Anchoring: the engine reports the screen rectangle of each anchored card in
its frame facts, and the shell writes it to the anchor element's `transform`
directly, in the same frame, with no render. Overlay components are ordinary
kit components. They sit in the layers `src/window/styles/layers.css` already
defines.

## 17. Minimap

`FactoryMinimap.tsx` is already the app's own SVG, written to replace React
Flow's because that one re-rendered on every camera change. It draws one
rectangle per card, a circle per seat, a mask for the camera frame, urgency
pings as HTML, and no wires. Its only tie to React Flow is where it gets
geometry and the camera.

- Keep its drawing. Give it a source interface: rectangles, a subscription to
  their changes, the camera, a subscription to the camera, and a way to set the
  camera. Both canvases implement it while both exist.
- The whole bottom bar is a React Flow `Panel` today only so the minimap can
  find React Flow's store. Mount the bar beside the canvas instead.
- The motion-law lock names the minimap root's class string
  (`react-flow__panel react-flow__minimap`). That assertion changes in the
  operator-named commit.
- `state$.regionSeverityByNodeId`, which colours the minimap and the
  magnifier, is written only while `RtsBottomBar` is mounted. Move that
  observer into the feed.
- `settings.canvas.showMinimap` and `fitOnOpen` are declared and never read.
  Leave them or prune them; do not wire the new canvas to them by accident.

Drawing the minimap with the engine is possible later and is not needed.

## 18. Magnifier

`CanvasMagnifier.tsx` is a canvas 2D loupe shown while Alt is held: a
schematic of what is under the pointer, 312 px, at most 64 cards, wires as
straight lines. It is a second, simpler renderer of cards with fonts and
colours of its own.

- Port its data source to the `CanvasApi`: screen to board, the cards near a
  point, the wires. Its window listeners and Alt handling stay.
- It sets `data-wires="shown"` on the React Flow root so CSS reveals wires.
  That becomes one call on the `CanvasApi`.
- Its pointer test (`.react-flow__pane, .react-flow__node, .react-flow__edge`)
  becomes "the pointer is over the canvas element".

Later option, not needed now: draw the loupe with the engine as a second
camera on the same scene, which would make it a true magnified view.

## 19. The CanvasApi

One object, provided by the shell through context and as a module handle for
code outside React. It replaces `useReactFlow`, `useStoreApi` and every DOM
lookup of `.react-flow`.

| Method | Replaces today | Used by |
| --- | --- | --- |
| `screenToBoard`, `boardToScreen` | `rf.screenToFlowPosition`, `flowToScreenPosition` | Add at pointer, context menus, drop, the magnifier |
| `camera()`, `camera$` | `store.transform`, `getViewport` | Minimap, keyboard pan, tier gate |
| `moveCamera`, `fit`, `focusNodes`, `zoomBy`, `zoomTo` | `setViewport`, `setCenter`, `fitView`, `zoomIn`, `zoomOut`, `zoomTo` | Fit button, zoom keys, focus requests, minimap, clusters, the demo's camera bridge |
| `rectOf(id)`, `boundsOf(ids)` | `getNode`, `nodeLookup`, `getNodesBounds` | Multi-select menu placement, sound panning (`sound/index.ts` pans stereo by a card's screen position), tooltips |
| `pick(point)` | `document.elementFromPoint` plus `.closest(".react-flow__node")` | Connect drop, file drop, context menus |
| `anchor(id)` | `NodeToolbar`, `ViewportPortal` | Every overlay in section 16 |
| `setWiresShown`, `setFocusCone` | Root class names and `data-wires` | Magnifier, impact mode, connection focus |
| `tier()` | `data-canvas-tier` | Already an observable; unchanged |

Because the camera and the rectangles are mirrored in the shell, the calls
that return values stay synchronous even if the engine later leaves the page.

The full list of places that reach into React Flow today, file by file, is in
the integration inventory, section 8. It includes selectors in
`focus-ownership.ts`, `urgency-step.ts`, `modal-stack.ts`, `reach-preview.ts`,
`impact-mode.ts`, `TooltipLayer.tsx` and `terminal-modifier-fence.ts`.

## 20. The feed

The feed is plain Legend-State: `observe` and `onChange` outside React. It
turns store changes into facts for the engine.

| Source | Becomes |
| --- | --- |
| `modelStore.canvas$(name)`: `nodes`, `wires`, `nodeIds` | Card and wire facts. `Opened` loads the scene; `Changed` touches only the rows it names. |
| `agentSeat$`, `terminal$.sessionByBindingId`, signal rollups, thread health, onboarding, offboard failure | Seat facts, through `seatFactsForNode`, `cardMark` and `ringState`, then one seat's ring and line |
| `kernel$` | Blocked |
| `seatTasks$`, `canvasTasks$` | Task strips and task card counts |
| `state$` selection and focus | Selection facts, camera requests |
| `themeMode$` | The style table and regenerated portraits, icons and bands |
| `state$.settings` | The switch |
| `WireTrafficEvent` from main | Wire pulses |

Seat reports reach the renderer unthrottled (the core debounces; the interval
was not read). Each must cost one seat's bytes.

**Derived state must leave the cards.** Several values are computed today only
because a card is mounted, and other parts of the app depend on them:

| Value | Computed today | Depends on it |
| --- | --- | --- |
| Seat urgency | A `useEffect` inside `AgentSeat` | Region urgency, the minimap |
| Node status and urgency | Inside `SpineCard` and `useNodeUrgency` | Region urgency |
| Seat clusters | By reading `data-mark-ring` from card DOM | Far and overview tiers |
| Zoom scales | By querying card DOM after the camera rests | Far rings, discs |
| A seat's session hydration | A `useEffect` in `SeatCard` that calls `terminalGet` and follows terminal events | The seat's line on first paint |
| Region severity and counts | An `observe` inside `RtsBottomBar` | Minimap, magnifier |

Move each into a feed module that derives it from the stores, with no
component mounted. The readers that are React hooks today
(`useSeatSignalRollup`, `useThreadHealthMark`, `useSeatOnboardingOf`,
`useSeatOffboardFailure`) need plain readers beside them. Do this first: it is
needed before the new canvas can show a correct seat, and the old canvas keeps
working on top of it.

## 21. The switch, no GPU, and Chromium switches

### The switch

Use the existing experimental feature mechanism; it is already live.

- Add a key (for example `gpuCanvas`) to `src/shared/feature-catalog.ts` with
  `applies: "live"`, the way `files` is declared, and its tier to
  `src/shared/features.ts`. The Settings row and persistence come for free.
- The seam is `src/window/App.tsx:634-637`, where `<ReactFlowProvider><Canvas />
  <DemoCameraBridge /></ReactFlowProvider>` is mounted. A small host reads
  `useFeatureOn("gpuCanvas")` and mounts one canvas or the other. Nothing like
  this whole-component swap exists in the app yet.
- The camera is handed across (section 14).
- e2e has no settings seed. Give the harness a launch option that sets the
  key, so every spec can run under either canvas.

`docs/state-architecture.md` forbids "feature flags... that keep an obsolete
path alive". That list is storage law, and the operator asked for this switch
by name. It is temporary: the plan's finish deletes it with the old canvas.

### No GPU

Measured in the spike: with the GPU off, Chromium offers no WebGPU adapter at
all, the software one included, and the canvas does not start. WebGPU runs on
any real graphics hardware, integrated included, and every Mac that runs Junto
has it. Today's canvas with the GPU off drew 6 to 9 frames a second, so there
is nothing worth falling back to.

- No adapter while the old canvas exists: the host mounts the old canvas and
  says why.
- No adapter after it is gone: a plain screen with no canvas. What it shows is
  a product decision still to make (section 26).
- Linux desktop is an official alpha target (`docs/linux-v1-support-matrix.md`,
  Ubuntu 24.04). WebGPU there, and under a headless display in e2e, has not
  been checked in this Electron. Check it before the new canvas becomes the
  default.

### Chromium switches

The spike found two Chromium features that each took dropped frames from as
much as 13.6% to between 0 and 3 in about 1,700:
`VSyncAlignedPresentation,VSyncAlignedPresentationForScrolling` and
`CADisplayLinkInGpu`. Both cost one more refresh of delay. Both are set at
process start (`src/app/index.ts:172-180` is where the app sets its switches),
so neither can be toggled live. They were measured on the spike's separate
view, not on a canvas in the page. Measure them again on the first shipped
version before turning either on.

## 22. Tests

| Layer | How it is tested |
| --- | --- |
| Pure cores: camera maths, bounds, elbow, spatial index, pick, the pointer machine, paint functions, text truncation, note layout, wire strips | Vitest, no GPU. The pointer machine gets a table of event sequences and the intents they must produce. Paint functions are checked as data: these facts give these quads. |
| The engine's frame | A fake clock and scheduler: a moving ring is drawn on every tick; an idle scene is not; a hidden canvas stops. No test waits on a real clock. |
| The look | The gallery comparison of section 7, in both themes, at near, mid and far. |
| Motion | The lock in section 10. Plus one phase test: at a frozen clock, a DOM ring and the canvas ring of the same seat show the same angle. |
| The app | e2e, through one harness helper. |
| Performance | The gesture script from the spike on the shipped version, read as dropped frames per gesture by `lab/gpu-canvas/trace-nav.py`. |

### The e2e helper comes first

46 of 51 specs read React Flow's DOM, and only two harness files centralise
any of it. Before any drawing work, add `e2e/harness/canvas.ts` and move every
spec onto it, still against today's canvas:

| Helper | Replaces |
| --- | --- |
| `canvasReady(page)` | `.react-flow` visible (19 lines) |
| `card(page, id)`: `visible`, `box`, `text`, `click`, `dblclick`, `rightClick`, `drag`, `selected` | `.react-flow__node[data-id]`, `rf__node-<id>`, `.selected` |
| `cardCount`, `regionCount` | `.react-flow__node`, `.react-flow__node-group` counts |
| `pane(page)`: `click`, `rightClick` | `.react-flow__pane` |
| `camera(page)`, `cameraSettled(page)` | The `.react-flow__viewport` transform |
| `handle(page, id, side)`, `verbZone(page, id, verb)` | `.junto-handle--source...`, `[data-verb]` |
| `regionHandle(page, id)` | `.region-drag-handle` |

Under the old canvas the helper reads the DOM. Under the new one it reads a
test hook the shell exposes in test and development builds: ready, ids,
screen rectangle of a card or a part, text, selection, camera, tier. Clicks
and drags are real pointer input at the points the hook returns, so the
engine's own picking is what gets tested.

Then every spec runs under both canvases, and "the suite passes with the
switch on" is a done-test.

### Tests that go with React Flow

Four unit tests mount real React Flow in jsdom
(`canvas-window-native-readers`, `page-card-native-reader`,
`card-render-count`, `minimap-pings`), and several lock React Flow selectors
by source text (`viewport-promotion`, `canvas-chrome-blur`,
`renderer-boot-graph` which requires `@xyflow/react` in the boot graph, and
parts of `motion-law`). Each is replaced by its canvas equivalent or deleted
with what it guards. The invariant behind `card-render-count` (a card changes
only when its own node changed) becomes: one changed row uploads one card's
bytes.

There is no frame budget on the canvas anywhere today; every canvas probe is
opt-in. The plan adds one gate, on dropped frames.

## 23. 2.5D readiness

Nothing here is a feature. These conventions keep a tilted or layered camera
possible later without rewriting what is built now.

1. The camera reaches every shader as a matrix. Today it is built from `{x, y,
   zoom}`.
2. Every record carries an elevation. It is zero today.
3. Paint order is the order list, back to front. A tilted camera changes the
   matrix, not the list. No depth buffer: shells are translucent.
4. One function turns a pointer into a board point, and picking goes through
   it. Later it casts a ray.
5. Nothing reads "the zoom" directly. Code asks the camera for the scale at a
   point, which is the same everywhere today.
6. Screen-held sizes (far rings, name tags) are expressed as a screen size at
   an anchor, not as a division by the zoom.
7. Text and images are textures on quads, so they survive any transform.

## 24. Accessibility

By decision the canvas is treated as a game surface and loses its
accessibility structure for now: the per-card accessible names, the ring's
`role="img"`, native focus on a card. Everything around it (toolbars, menus,
editors, modals, the bottom bar, the command bar) stays standard, accessible
DOM. The app already turns renderer accessibility off at start
(`src/app/index.ts:172`).

## 25. What is deleted at the end

- The dependency `@xyflow/react` and, with it, `@xyflow/system` and its d3
  packages.
- `Canvas.tsx` as it is, `nodes/` card components that exist only for the
  canvas, `edges/`, `CanvasTierGate`, `RegionGlanceGate`, `RegionUrgencyGate`,
  `SeatClusterLayer`, `flow-nodes.ts`, `flow-edges.ts`, `flow-identity.ts`,
  `multi-select-gesture.ts`, `terminal-modifier-fence.ts`.
- The `.react-flow` selectors: 147 lines across 13 style sheets, most of
  `canvas-lod.css` and `canvas-lod-regions.css`.
- The DOM workarounds that existed only for React Flow; the integration
  inventory lists them under "Workarounds and past-bug comments".
- The switch.

Card components that also show off the canvas stay: `AgentSeatView` (the tour,
the gallery, the agent modal's rail), `ActivityMark` and `SeatRingView` (rows,
the palette), the preamble bubble in the modal's rail. Two places borrow the
class `react-flow__node` for styling outside any flow (`KindSeatGallery.tsx`,
`tour-demo.tsx`); give them a class of their own.

## 26. Deviations, open questions and risks

### Deviations from today's look and behaviour

Any change to the look needs the operator's yes. The default everywhere is
parity. These are the places where the GPU canvas would differ, or could be
better. None stops the work: build the closest match to today, raise the
item to the operator as a signal, and carry on.

| Item | Today | On the GPU |
| --- | --- | --- |
| Text during a zoom gesture | Rasterized fresh every frame | Scaled between rasters, exact at rest; could be briefly soft mid-gesture |
| Far ring and disc sizes | Stepped by 0.1, eased 160 ms after the camera rests | Can do the same, or hold the screen size continuously through the zoom |
| Focus dimming over a region | Group opacity | Mix toward the ground: equal over the ground, slightly different over a wash |
| Wire glow | CSS `drop-shadow` | A soft wider pass |
| Card and region shadows | Browser blur | A closed-form blur, within the look test's tolerance |
| Connection preview | React Flow's grey curve | A token colour |
| Pane click and double click | Probably dead | As the code intends, if the operator wants it |
| Arrow-key nudge without a write | Inherited | Dropped or made real |
| Tier crossing | Hard switch | Same; the spike's fade is available if wanted |

### Questions for the operator, to raise when reached

1. What the no-canvas screen shows.
2. Whether a card keeps keyboard focus (Tab to a seat, the cyan ring, the menu
   key). `canvas-keyboard-seat` tests it today. It can live on as engine
   state without the accessibility structure.
3. The number for the dropped-frame gate. Proposed: at most 1% of refreshes in
   a gesture run on both rigs, and none at rest under fleet load.
4. Linux: whether the canvas must run there before it becomes the default.
5. The motion-law wording and lock changes, which only the operator may sign.

### Risks, with what is and is not known

| Risk | Known | Not known |
| --- | --- | --- |
| The page's long tasks stall the canvas and freeze rings | Measured in the spike: stalls as long as the task, 280 to 440 ms in the test load | How long the real app's tasks are once the DOM canvas is gone |
| A worker as the way out | The spike's worker underperformed | Why |
| Frame pacing in Chromium | Two switches fix it on a separate view | Their effect on a canvas in the page |
| Text rasterizing during zoom | The design | Its cost on the factory board; no measurement exists |
| WebGPU on Linux and in headless e2e | Nothing | Whether it runs at all |
| SVG decode off the page | From the platform's documentation | Not tried in this Electron |
| Memory | The spike used about 510 MB against 2.2 to 2.4 GB, not like for like | The product's real figure |
| Hidden dependence on mounted cards | Six cases found (section 20) | Whether there are more |
| Editing text in a scaled overlay | The design | Caret and IME behaviour at small zoom |
