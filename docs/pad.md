# Junto pad

A first-party spatial work sink. The factory canvas stays the ACL.
The pad is the shared page: images, shapes, ink, pins. Wired agents
read a picture + a text IR and patch structure and comments. Ordinary
agents never write the factory canvas.

This document is the contract and the guide: laws, domain and persistence
first, then how the operator and a wired agent use the page. A production
counterexample updates this file, then the code.

## Product sentence

Operator and wired agents share one page. The operator marks. The
agent sees the same page (SVG + digest + look-here crop) and
patches named boxes and pins.

## Laws

1. Ordinary agents never write the factory canvas. Pad body lives on the work
   plane (same class as `board`). An overseer authors canvas through closed
   `overseer` commands, not through pad.
2. `applyPatch` is the only mutation of a `Pad`. Editor, CLI, and
   WorkService all emit `PadPatch`.
3. Layers do not mix. Render order is always
   `image → shape+edge → ink → pin`. `z` orders inside a layer.
4. Mentions are factory agent node ids on inbound edges to this pad.
   `@` cannot name an unwired agent.
5. Agents may upsert shapes/edges and pin posts. Agents may not
   upsert ink or images. Refuse, do not ignore.
6. Bytes never live in pad JSON. Images are `ContentRef`.
7. User-facing strings say **Junto**. Never the bare token.
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

Persisted `fill` / `stroke` / ink `color` are untrusted data. They
remain arbitrary strings in Pad IR and Work facts so historical
patches still decode. Rendering never treats them as HTML or CSS:
only exact `none` or `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`
paint. Anything else, including quotes, tags, `url()`, `var()`,
named colors, and functions, uses a role-specific theme default
without rewriting storage. `padToSvg` must be safe when parsed as
markup independently of CSP. The privileged renderer must not
interpolate Pad strings into HTML; factory-card thumbs are
structural React SVG. Serialized SVG is for `pad.read` / CLI /
look-here export only.

- `padToSvg(pad, theme)` — layer order; images as labeled rect +
  sha prefix unless caller supplies an href map; every dynamic
  attribute escaped; paint resolved as above
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

## Operator

Focus the pad card (double-click or RTS **Open pad**). One SVG. Every write
is a `PadPatch`. Theme is the dim command room, not a crayon whiteboard.

### Tools

| key | tool |
|---|---|
| `v` | select, move, resize (4 AABB handles) |
| `r` | box |
| `o` | ellipse |
| `t` | triangle |
| `l` | label |
| drag from a side | edge |
| `p` | pin — click places, drag sets look-here bounds |
| `i` | image — content store → `ContentRef` (also paste or drop) |
| `d` | ink — record points, upsert on pointer up |
| `[` `]` | z inside the layer |
| delete | delete the selection |
| `⌘z` | local inverse patch — durable with the next editor write |
| space + drag / middle mouse | pan |
| wheel | zoom |

Undo changes the local view immediately. Pending inverse patches become
durable with the next successful editor write; closing before that write
discards them. External pad changes clear local undo history. Deleting a
pin that has replies is not undoable — the confirm-free delete removes
the thread for good. Typing targets (label input, pin reply) and focused
controls own their keys; only `Esc` joins the editor cancel chain.

Empty pad: mark the page. `R` box, `P` pin, `I` image, `D` ink.

### Pins and @

A pin is a comment site, not a shape. Drag while placing to set
`bounds` (the look-here crop). The pin thread is inbound wired actors
only. `@` cannot name an unwired agent.

### Images

Bytes never live in pad JSON. The operator picks, pastes, or drops an
image. Junto stores a `ContentRef`. Agents may not upsert
images.

### Ink

Human overlay. Points are recorded at 1–2px spacing and committed as one
ink element. Agents may not upsert ink. No pressure, no pixel eraser.

Factory card thumbnail is framed structural React SVG (`PadSvg`) or
the empty-state glyph. `padToSvg` is the export picture, not an
HTML sink.
Theme tokens from `src/shared/theme`. This is a Junto
surface: dim command room, not a crayon whiteboard. Resize handles
are view-stable (4 AABB). Hit slop is view pixels, not scene units.

## Agent

Working copy is `pad.read`, not the crew digest. Process-bind + an
edge that grants the port. No edge is `ScopeError`.

### Ports

Only two work ports exist:

| port | grant | result |
|---|---|---|
| `pad.read` | read the connected pad | `{ revision, pad, digest, svg }`. Optional `pinId` adds `lookHere { bounds, digest, svg }`. |
| `pad.patch` | apply `PadPatch[]` | `{ revision, pad, digest }` |

CLI projections of `pad.read` (same grant):

```
junto pad read '{"target":"<pad-id>"}'
junto pad digest '{"target":"<pad-id>"}'
junto pad svg '{"target":"<pad-id>"}'
junto pad get '{"target":"<pad-id>","id":"<element-id>"}'
junto pad look-here '{"target":"<pad-id>","pinId":"<pin-id>"}'
junto pad tagged '{"target":"<pad-id>"}'
```

Mutation:

```
junto pad patch '{"target":"<pad-id>","patches":[{"op":"upsert","layer":"shape","shape":{"id":"box-1","type":"box","x":0,"y":0,"w":80,"h":40,"z":0}}]}'
```

Agents may upsert shapes, edges, and pin posts. Discover schemas with
`junto schema show pad.read` and `junto schema show pad.patch`.

### Refusals

Refuse, do not ignore:

- `agents cannot upsert ink`
- `agents cannot upsert images`
- `mention "<id>" is not an inbound actor on this pad`
- `ScopeError` without an inbound edge that grants the port

Mentions on `pin.upsert` must be inbound actor node ids. `@` cannot name
an unwired agent. `pin.reply` authors are stamped by WorkService.

### look-here

`pad.read` with `pinId`, or `junto pad look-here`. Crop is
`pin.bounds` when present, otherwise the pin ± margin. Use it when the
operator pointed at a region. A pinId that no longer resolves degrades a
`pad.read` to a plain read (`lookHere` omitted, nothing marked read);
`junto pad look-here` stays strict and fails on the same input.

### tagged

`junto pad tagged` lists pins that mention this process-bound
seat. Same `pad.read` grant. The mention universe is inbound actor
edges; unwired names are refused on `pad.patch`.

CLI discovery: `junto docs node pad`. Every verb is JSON-only, same envelope
as board, with a discovery schema and examples.

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
