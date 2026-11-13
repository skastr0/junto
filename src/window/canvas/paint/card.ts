/**
 * The default card shell (inventory 2.0, 2.6): reaches the screen only on an
 * image file. Near and mid draw the shell and the image; far a tinted box with
 * a glyph; overview nothing.
 */

import type { CardFact, CardPaint, CardView, ColorRef, PaintEnv, Quad } from "../contract";
import { TIER_BIT } from "../contract";
import { LIFT_PX } from "./card-spec";
import { dimOf, focusQuads, reachQuads } from "./overlays";
import { accentRef, at, fade, grow, shadow, shape, sprite, tok } from "./refs";

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const RADIUS_CARD = 10;
/** `px-3.5 py-3` under a 1px border. */
const PAD = { x: 14, y: 12, border: 1 } as const;

/** `borderColor(color, selected)` of `lib/theme.ts` for an unselected card. */
const border = (color: string | undefined, blocked: boolean, selected: boolean): ColorRef => {
  if (selected) return blocked ? fade(tok("crimson"), 0.75) : fade(tok("accent"), 0.75);
  if (blocked) return tok("crimson");
  if (color === undefined) return tok("stroke");
  return fade(accentRef(color), 0.32);
};

export const paintDefaultCard = (fact: CardFact, view: CardView, env: PaintEnv): CardPaint => {
  const row = fact.row;
  const w = row.width;
  const h = row.height;
  const box = at(0, 0, w, h);
  const blocked = fact.derived.blocked;
  const quads: Quad[] = [];
  const color = "color" in row ? row.color : undefined;
  if (view.selected) {
    quads.push(
      shadow({ key: "shell.shadow", z: 0, rect: box }, { shadow: { name: "card-lift" } }, { tiers: NEAR_MID, radii: RADIUS_CARD }),
      shape({ key: "shell.ring", z: 0, rect: grow(box, 1) }, { stroke: { color: fade(blocked ? tok("crimson") : tok("accent"), 0.25), width: 1 } }, { tiers: NEAR_MID, radii: RADIUS_CARD + 1 }),
    );
  } else {
    quads.push(shadow({ key: "shell.shadow", z: 0, rect: box }, { shadow: { name: "card" } }, { tiers: NEAR_MID, radii: RADIUS_CARD }));
    if (blocked) {
      quads.push(shape({ key: "shell.ring", z: 0, rect: grow(box, 1) }, { stroke: { color: fade(tok("crimson"), 0.18), width: 1 } }, { tiers: NEAR_MID, radii: RADIUS_CARD + 1 }));
    }
  }
  const fill = blocked
    ? ({ kind: "gradient", angle: 135, from: fade(tok("crimson"), 0.12), to: fade(tok("ground"), 0.92) } as const)
    : ({ kind: "gradient", angle: 135, from: fade(tok("raise"), 0.94), to: fade(tok("ground"), 0.96) } as const);
  quads.push(shape({ key: "shell", z: 1, rect: box }, { fill, stroke: { color: border(color, blocked, view.selected), width: 1 } }, { tiers: NEAR_MID, radii: RADIUS_CARD, part: { kind: "body" } }));
  if (blocked) {
    // The static ring `.junto-blocker::after`: inset -5, 2px, accent 55% at opacity 0.55.
    quads.push(shape({ key: "blocker", z: 3, rect: grow(box, 5) }, { stroke: { color: fade(tok("accent"), 0.55), width: 2 }, opacity: 0.55 }, { tiers: NEAR_MID, radii: RADIUS_CARD + 5 }));
  }
  if (row.kind === "file" && !view.editing) {
    quads.push(
      sprite(
        { key: "image", z: 10, rect: at(PAD.border + PAD.x, PAD.border + PAD.y, w - 2 * (PAD.border + PAD.x), h - 2 * (PAD.border + PAD.y)) },
        { tiers: NEAR_MID, radii: 2, sprite: { atlas: "media", ref: row.path, fit: "contain" }, part: { kind: "image" } },
      ),
    );
  }
  if (view.keyboardFocus) {
    quads.push(shape({ key: "focus", z: 2, rect: grow(box, 3) }, { stroke: { color: tok("cyan"), width: 1, outside: true } }, { tiers: NEAR_MID, radii: 8 + 3 }));
  }

  // Far: a box tinted ink 5% with its kind's glyph, 60% of the height up to 120, ink 38%.
  quads.push(shape({ key: "far.box", z: 1, rect: box }, { fill: { kind: "flat", color: tok("ink", 0.05) } }, { tiers: TIER_BIT.far, part: { kind: "body" } }));
  const g = Math.min(h * 0.6, 120);
  quads.push(
    sprite(
      { key: "far.glyph", z: 2, rect: at((w - g) / 2, (h - g) / 2, g, g) },
      { tiers: TIER_BIT.far, sprite: { atlas: "glyph", name: `kind:${row.kind}` }, style: { ink: tok("ink", 0.38) } },
    ),
  );
  if (view.selected) {
    quads.push(shape({ key: "far.selected", z: 3, rect: grow(box, 2) }, { stroke: { color: tok("main", 0.7), width: 4, outside: true } }, { tiers: TIER_BIT.far }));
  }
  quads.push(...focusQuads(view, box, RADIUS_CARD), ...reachQuads(view, box, env, true));
  return { quads, dim: dimOf(view), lift: view.hovered && !view.dragging ? LIFT_PX : 0 };
};
