# Junto pad

The pad is an artifact body type ([plan 05](plans/0.10/05-artifacts.md)): a
spatial page of images, shapes, edges and ink. There is no pad node; an
Artifacts node holds pad artifacts, and the artifact pad editor edits them.
Comments on a pad are artifact threads anchored to a box, never pad JSON.

This file is the contract for the pad domain. A production counterexample
updates this file, then the code.

## Laws

1. `applyPatch` is the only mutation of a `Pad`. The editor emits `PadPatch`;
   an artifact edit carries the drawing-layer patches (`ArtifactPadPatch`).
2. Layers do not mix. Render order is always `image → shape+edge → ink`.
   `z` orders inside a layer.
3. Bytes never live in pad JSON. Images are `ContentRef`.
4. Persisted `fill`, `stroke` and ink `color` are untrusted. Rendering paints
   only exact `none` or `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`; anything else
   takes a theme default without rewriting storage. The renderer never puts a
   pad string into markup.
5. Stock dependencies only: no drawing framework inside the editor.

## Files

| File | Owns |
|---|---|
| `src/shared/pad.ts` | `Pad`, elements, `PadPatch`, `applyPatch`, `PadError` |
| `src/shared/pad-geom.ts` | camera, hit-test, bounds, edge anchors, `strokePath` |
| `src/shared/pad-project.ts` | `padToSvg`, `padToDigest`, `padToFocused` |
| `src/renderer/components/pad/PadEditor.tsx` | the editor, host-agnostic |
| `src/renderer/components/artifacts/ArtifactPadEditor.tsx` | the artifact host |

## Domain

```
Pad
  revision: int          // +1 per accepted patch
  images: PadImage[]
  shapes: PadShape[]     // id, type box|ellipse|triangle|label, x, y, w, h, z, fill?, stroke?, text?, status?
  edges:  PadEdge[]      // id, from, to, fromSide?, toSide?, label?
  inks:   PadInk[]       // id, z, color, width, points (>= 2)
```

`applyPatch` keeps ids unique, `w > 0` and `h > 0`, edge endpoints present
(deleting a shape deletes its edges in the same application), ink at two
points or more, and layers fixed in type. An invalid patch leaves the pad
unchanged. Upsert is create or replace by id; the last write per id wins.

## Editor

`PadEditor` takes the pad, `onCommit` (queued patches, resolving with the
authoritative outcome) and a pin mode for the P tool: `area` drags a box and
hands it to the host without writing (the artifact host starts an anchored
comment from it), and `none` has no P tool. Typing targets and focused
controls own their keys; only `Esc` joins the editor's cancel chain.

## Projections

`pad-project.ts` is deterministic and has no DOM. `padToDigest` is the text IR
the CLI shows for a pad artifact; `padToSvg` is safe to parse as markup on its
own. The renderer draws structural React SVG (`PadSvg.tsx`), never the
serialized string.

## Non-goals

Rotation, pressure, pixel eraser, lasso, frames, CRDT.
