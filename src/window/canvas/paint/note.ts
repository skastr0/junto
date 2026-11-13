/**
 * A note (inventory 2.4): typeset markdown in an amber callout. Near draws the
 * whole note, mid its first block, far an amber tick, overview nothing.
 */

import { RADIUS } from "@shared/theme";
import type { CardFact, CardPaint, CardView, PaintEnv, Quad } from "../contract";
import { TIER_BIT } from "../contract";
import { LIFT_PX } from "./card-spec";
import { layoutNote } from "./note-layout";
import { dimOf, focusQuads, reachQuads } from "./overlays";
import { at, grow, mixOf, shape, tok } from "./refs";

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const PAD = { x: 12, y: 8, border: 1 } as const;
/** The far tick, in screen px held by `--node-s`: 10 by 26. */
const TICK = { width: 10, height: 26 } as const;
const RADIUS_MD = Number.parseFloat(RADIUS.md);

export const paintNote = (fact: CardFact, view: CardView, env: PaintEnv): CardPaint => {
  const row = fact.row;
  const source = row.kind === "note" ? row.text : "";
  const w = row.width;
  const h = row.height;
  const box = at(0, 0, w, h);
  const quads: Quad[] = [
    shape(
      { key: "shell", z: 1, rect: box },
      { fill: { kind: "flat", color: tok("amber", 0.08) }, stroke: { color: tok("amber", 0.3), width: 1 } },
      { tiers: NEAR_MID, radii: RADIUS_MD, part: { kind: "body" } },
    ),
  ];
  if (view.keyboardFocus) {
    quads.push(
      shape({ key: "focus", z: 2, rect: grow(box, 3) }, { stroke: { color: tok("cyan"), width: 2, outside: true } }, { tiers: NEAR_MID, radii: 4 + 3 }),
    );
  }
  if (!view.editing) {
    const origin = { x: PAD.border + PAD.x, y: PAD.border + PAD.y };
    const contentW = w - 2 * (PAD.border + PAD.x);
    const contentH = h - 2 * (PAD.border + PAD.y);
    const layout = layoutNote(source, contentW, origin, env);
    quads.push(...layout.quads);
    if (layout.height > contentH) {
      // The last line fades into the callout rather than being cut through its glyphs.
      const lineH = 11 * 1.6;
      quads.push(
        shape(
          { key: "fade", z: 30, rect: at(origin.x, origin.y + contentH - lineH, contentW, lineH) },
          { fill: { kind: "gradient", angle: 180, from: { token: "ground", alpha: 0 }, to: mixOf(tok("amber"), tok("ground"), 0.08) } },
          { tiers: NEAR_MID },
        ),
      );
    }
  }
  // Far: a tick the size of the card at most, held at 10 by 26 screen px.
  quads.push(
    shape(
      { key: "tick", z: 1, rect: at(0, 0, Math.min(w, TICK.width), Math.min(h, TICK.height)) },
      { fill: { kind: "flat", color: tok("amber") } },
      { tiers: TIER_BIT.far, scale: { kind: "node", anchor: { x: 0, y: 0 } }, part: { kind: "body" } },
    ),
  );
  quads.push(...focusQuads(view, box, RADIUS_MD), ...reachQuads(view, box, env, true));
  return { quads, dim: dimOf(view), lift: view.hovered && !view.dragging ? LIFT_PX : 0 };
};
