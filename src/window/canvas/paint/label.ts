/**
 * A label (inventory 2.5): bare display type, no card. Held at a screen size at
 * far, hidden at overview.
 */

import { RADIUS, TEXT_SIZES } from "@shared/theme";
import type { CardFact, CardPaint, CardView, PaintEnv, Quad, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { dimOf, focusQuads, reachQuads } from "./overlays";
import { accentRef, at, grow, shape, text } from "./refs";

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
/** `px-1 py-0.5` on the bare shell. */
const PAD = { x: 4, y: 2 } as const;
const HERO = Number.parseFloat(TEXT_SIZES.hero);
/** The far floor, `13px * --node-s`. */
const FAR_FLOOR = 13;
const LEADING = 1.2;

export const paintLabel = (fact: CardFact, view: CardView, env: PaintEnv): CardPaint => {
  const row = fact.row;
  const value = row.kind === "label" ? row.text || "Label" : "";
  const w = row.width;
  const h = row.height;
  const box = at(0, 0, w, h);
  const width = w - 2 * PAD.x;
  const ink = accentRef(row.color, "ink");
  const run = (size: number): TextRun => ({ text: value, font: "display", size, weight: 700, leading: LEADING, truncate: "end", width, halo: true });
  const quads: Quad[] = [];
  const near = HERO * LEADING;
  if (!view.editing) {
    quads.push(
      text({ key: "text", z: 10, rect: at(PAD.x, (h - near) / 2, width, near) }, { ink }, { tiers: NEAR_MID, text: run(HERO), part: { kind: "body" } }),
      // Far: the floor size, held by the node scale about the text's left centre.
      text(
        { key: "text.far", z: 10, rect: at(PAD.x, (h - FAR_FLOOR * LEADING) / 2, width, FAR_FLOOR * LEADING) },
        { ink },
        { tiers: TIER_BIT.far, text: run(FAR_FLOOR), scale: { kind: "node", anchor: { x: PAD.x, y: h / 2 } }, part: { kind: "body" } },
      ),
    );
  }
  quads.push(shape({ key: "hit", z: 0, rect: box }, {}, { tiers: NEAR_MID | TIER_BIT.far, part: { kind: "body" } }));
  if (view.keyboardFocus) {
    quads.push(shape({ key: "focus", z: 2, rect: grow(box, 3) }, { stroke: { color: { token: "cyan" }, width: 2, outside: true } }, { tiers: NEAR_MID, radii: Number.parseFloat(RADIUS.sm) + 3 }));
  }
  quads.push(...focusQuads(view, box, Number.parseFloat(RADIUS.sm)), ...reachQuads(view, box, env, true));
  return { quads, dim: dimOf(view), lift: 0 };
};
