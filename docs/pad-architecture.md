# Vellum Command pad

A first-party spatial work sink. The factory canvas stays the ACL.
The pad is the shared page: images, shapes, ink, pins. Wired agents
read a picture + a text IR and patch structure and comments. They
never write the factory canvas.

This document is the contract. Implementation follows it. A production
counterexample updates this file, then the code.

## Product sentence

Operator and wired agents share one page. The operator marks. The
agent sees the same page (PNG/SVG + digest + look-here crop) and
patches named boxes and pins.

## Laws

1. Agents never write the factory canvas. Pad body lives on the work
   plane (same class as `board`).
2. `applyPatch` is the only mutation of a `Pad`. Editor, CLI, and
   WorkService all emit `PadPatch`.
3. Layers do not mix. Render order is always
   `image → shape+edge → ink → pin`. `z` orders inside a layer.
4. Mentions are factory agent node ids on inbound edges to this pad.
   `@` cannot name an unwired agent.
5. Agents may upsert shapes/edges and pin posts. Agents may not
   upsert ink or images. Refuse, do not ignore.
6. Bytes never live in pad JSON. Images are `ContentRef`.
7. User-facing strings say **Vellum Command**. Never the bare token.
8. Stock dependencies only. No tldraw, no Excalidraw, no xyflow
   inside the pad editor. `perfect-freehand` is not v1.
9. Expand-only SQLite: append `N → N+1`. Read
   `CURRENT_STATE_SCHEMA_VERSION` at implement time (do not hardcode).
10. Product name lint, no middle dots, Effect schemas at the
    component and the seam.

## PCMI

**Pristine (monofiles)**

| File | Owns |
|---|---|
| `src/shared/pad.ts` | `Pad`, elements, `PadPatch`, `applyPatch`, `PadError` |
| `src/shared/pad-geom.ts` | camera, hit-test, AABB, edge anchors, `strokePath` |
| `src/shared/pad-project.ts` | `padToSvg`, `padToDigest`, `padToFocused`, `padLookHere` |

**Pristine seams (extend existing fail-closed tables)**

- `SinkKind` += `"pad"`
- Ports: `pad.read`, `pad.patch` only
- `WorkOpName` += `pad.read`, `pad.patch`
- `KindSpecs`, `PortForWorkOp`, `OPS_BY_SINK`

**Messy glue**

- SQLite repository, WorkService author rules, IPC, CLI flags
- React + SVG editor, pointer events, handles, focus modal
- PNG raster of SVG (replaceable)

Do not invent a second pad document, a CRDT, a drawing framework,
or a second comment body. Pin posts reuse `BoardAuthor` + `Part`.

## Domain

```
Pad
  revision: int          // +1 per accepted patch
  images: PadImage[]
  shapes: PadShape[]
  edges:  PadEdge[]
  inks:   PadInk[]
  pins:   PadPin[]

PadShape
  id, type: box|ellipse|triangle|label
  x, y, w, h            // axis-aligned, w>0, h>0
  z: int
  fill?, stroke?, text?
  status?: none|active|done|blocked

PadEdge
  id, from, to
  fromSide?, toSide?    // top|right|bottom|left
  label?

PadImage
  id, x, y, w, h, z
  ref: ContentRef

PadInk
  id, z, color, width
  points: {x,y}[]       // >= 2

PadPin
  id, x, y
  bounds?: {w, h}       // look-here crop
  mentions: string[]    // agent node ids
  posts: PadPost[]      // BoardAuthor + Part[]
```

### Invariants (`applyPatch` enforces)

- Ids unique within the pad.
- `w > 0`, `h > 0`.
- Edge endpoints exist. Deleting a shape deletes its edges in the
  same patch application.
- Ink has ≥ 2 points.
- Image carries `ContentRef`, never bytes.
- No rotation. Ink is not a shape.
- Layers cannot change type.

### Patch

```
PadPatch =
  | { op: "upsert", layer: "shape", shape }
  | { op: "upsert", layer: "edge",  edge }
  | { op: "upsert", layer: "image", image }
  | { op: "upsert", layer: "ink",   ink }
  | { op: "pin.upsert", pin }          // posts omitted; creates/updates shell
  | { op: "pin.reply",  pinId, post }
  | { op: "delete",     id }
  | { op: "z",          id, z }

applyPatch(pad, patch) -> Either<PadError, Pad>
applyPatches(pad, patches) -> Either<PadError, Pad>
```

Upsert is create-or-replace by id (idempotent). Invalid patch leaves
the pad unchanged. Last write per id wins. No CRDT.

Author class is **not** in `pad.ts`. WorkService refuses agent
ink/image with `InputError`.

## Geometry

`pad-geom.ts` is numbers in, numbers out. No React. No SVG strings.

- `Camera { x, y, zoom }`
- `viewToScene` / `sceneToView`
- `boundsOf`, `contentBounds`
- `hitTest(pad, scenePt, slop)` — topmost by layer then z;
  ink = distance-to-polyline < width/2 + slop
- `anchorPoint(shape, side)`, `routeEdge`
- `strokePath(points, width) -> path d` — orthogonal stays a polyline;
  freehand (3+ non-axis-aligned points) gets a first-party midpoint
  quadratic smooth. No `perfect-freehand`.

## Projections

`pad-project.ts` is deterministic, no DOM (same posture as
`digest.ts` / `svg.ts`).

- `padToSvg(pad, theme)` — layer order; images as labeled rect +
  sha prefix unless caller supplies an href map
- `padToDigest(pad)` — text IR, no ink point dumps
- `padToFocused(pad)` — compact `{id, type, bounds, text, status}`
- `padLookHere(pad, pinId)` — crop around `pin.bounds` or pin ± margin

Factory digest (`src/shared/digest.ts`) adds one pad block under
entities (counts + digest). The working copy for a wired agent is
`pad.read`, not the factory digest.

## Physics and work plane

Card: JSON Canvas `text` node, `ether.entity.kind = "pad"`. Glance
= title + shape count + unread pin count. SQLite owns truth.

```
pad.read   → { revision, pad, digest, svg }
             optional pinId → + lookHere { bounds, digest, svg }
pad.patch  → { patches } → { revision, pad, digest }
```

Process-bind + edge ports, identical to board. Command Center-homed
sink. Remotes enqueue; material pad lives on CC.

Mention check on `pin.upsert` / `pin.reply`: inbound edges → actor
node ids. Anything else is `InputError`.

## Persistence

Element tables, not one blob:

```
work_pad_meta
work_pad_images
work_pad_shapes
work_pad_edges
work_pad_inks
work_pad_pins
work_pad_posts
```

Load → `Pad` → `applyPatch` → write changed rows → bump revision.

Expand-only migration. Frozen board/task SQL is not edited.

## Editor

Focus modal (existing `activate-node-surface` path). One SVG.
All writes are `PadPatch`. No xyflow.

| key | tool |
|---|---|
| `v` | select / move / resize (4 AABB handles) |
| `r` | box |
| `o` | ellipse |
| `t` | triangle |
| `l` | label |
| drag from side | edge |
| `p` | pin |
| `i` | image → content store → ContentRef |
| `d` | ink (record points, upsert on pointerup) |
| `[` `]` | z inside layer |
| `delete` | delete |
| `⌘z` | local inverse patch (not durable) |

Factory card thumbnail is framed `padToSvg` or the empty-state glyph.
Theme tokens from `src/shared/theme`. This is a Vellum Command
surface: dim command room, not a crayon whiteboard. Resize handles
are view-stable (4 AABB). Hit slop is view pixels, not scene units.

## CLI (agent-first)

JSON-only, same envelope as board. Discovery schemas + examples
required for every verb.

```
vellum-command pad read
vellum-command pad patch
vellum-command pad digest
vellum-command pad svg
vellum-command pad look-here
vellum-command pad get
vellum-command pad tagged
```

`docs node pad` must exist. Descriptions name the grant, the
refusal (ink/image from agents), and the mention rule.

## Tests

- Unit: `applyPatch` refusals, geom hit-test, golden digest/svg
- Work plane: IPC/CLI mocks, process-bind, ScopeError without edge,
  agent ink refused, mention of unwired agent refused
- E2E (Playwright sandbox, no real harnesses): create pad node,
  wire mock seat, patch via work API, persist across reload,
  focus modal draws a box, pin + look-here

## Non-goals (v1)

Rotation, pressure, pixel eraser, lasso, frames, C4 stencils,
agent-written ink, nested factory canvas, Rust, CRDT, tldraw kit.

## Build order

1. `pad.ts` + refusal tests
2. `pad-geom.ts` + `pad-project.ts` + goldens
3. Physics tables + `makePadNode`
4. Migration + repository + WorkService
5. CLI + discovery + `docs node pad`
6. Focus-modal SVG editor (box/ellipse/triangle/label/edge/z)
7. Pins + @wired-agents + look-here
8. Images via ContentRef
9. Ink overlay
10. Feel, theme, operator docs

1–6 is the context engine. 7 is the collaboration verb.
8–9 is the dream page. 10 is taste.
