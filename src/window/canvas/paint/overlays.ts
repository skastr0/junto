/**
 * What a card wears that is not its own kind: focus dimming, the focus-mode
 * roots, the keyboard ring and the reach preview (inventory 2.7 and the reach
 * rule at its end).
 */

import { BORDER, DURATION } from "@shared/theme";
import type { CardView, ColorRef, PaintEnv, Quad, Radii, ReachEffect, Rect, TextRun } from "../contract";
import { ALL_TIERS, TIER_BIT } from "../contract";
import { DIM, REACH } from "./card-spec";
import { at, grow, shadow, shape, text, tok } from "./refs";

/** Card-wide group opacity and saturation for the focus modes (0.18 s ease). */
export const dimOf = (view: CardView): { readonly opacity: number; readonly saturate: number } => {
  switch (view.focus?.role) {
    case "outsider":
      return DIM.outsider;
    case "lead":
      return DIM.lead;
    case "member":
    case "root":
      return DIM.member;
    default:
      return DIM.rest;
  }
};

/** The box-shadow a focus mode puts on its root and its members (`.junto-node` rules). */
export const focusQuads = (view: CardView, box: Rect, radii: Radii): ReadonlyArray<Quad> => {
  const focus = view.focus;
  if (focus === undefined || (focus.role !== "root" && focus.role !== "member")) return [];
  const name = `focus-${focus.kind}-${focus.role}`;
  return [shadow({ key: "focus.shadow", z: 3, rect: box }, { shadow: { name } }, { radii, tiers: TIER_BIT.near | TIER_BIT.mid })];
};

const REACH_HUE: Readonly<Record<ReachEffect, string>> = { gains: "green", loses: "orange", both: "yellow", held: "cyan" };

/**
 * The reach preview: a breathing ring round the card (a dashed outline when
 * the card loses reach), and on the one under the pointer the summary pill
 * beside it. `hiddenAtOverview` is true for a card the overview hides.
 */
export const reachQuads = (
  view: CardView,
  box: Rect,
  env: PaintEnv,
  hiddenAtOverview = false,
): ReadonlyArray<Quad> => {
  const mark = view.reach;
  if (mark === undefined) return [];
  const hue: ColorRef = tok(REACH_HUE[mark.effect]);
  const out: Quad[] = [];
  const motion = { kind: "reach", periodMs: DURATION.reach } as const;
  const loses = mark.effect === "loses";
  const tiers = (near: boolean): number =>
    near
      ? TIER_BIT.near | TIER_BIT.mid
      : hiddenAtOverview
        ? TIER_BIT.far
        : TIER_BIT.far | TIER_BIT.overview;
  for (const near of [true, false]) {
    const inset = near ? REACH.inset : REACH.insetFar;
    const rect = grow(box, inset);
    const key = near ? "reach" : "reach.far";
    if (loses) {
      out.push(
        shape(
          { key, z: 70, rect },
          { stroke: { color: hue, width: near ? BORDER.heavy : BORDER["reach-far"], dash: near ? [6, 4] : [24, 16], outside: false } },
          { tiers: tiers(near), radii: REACH.radius, motion, band: "lifted" },
        ),
      );
    } else {
      out.push(
        shadow(
          { key, z: 70, rect },
          { shadow: { name: near ? "reach" : "reach-far", tint: hue } },
          { tiers: tiers(near), radii: REACH.radius, motion, band: "lifted" },
        ),
      );
    }
  }
  if (mark.summary !== undefined) {
    for (const near of [true, false]) {
      const k = near ? 1 : 3;
      const run: TextRun = { text: mark.summary, font: "mono", size: 10 * k, weight: 400, leading: 1.2, truncate: "none", width: 4096 };
      const w = env.measure(run);
      const padX = near ? 8 : 24;
      const padY = near ? 3 : 10;
      const h = run.size * 1.2 + padY * 2;
      const gap = near ? REACH.pillGap : REACH.pillGapFar;
      const x = box.x + box.width + gap;
      const y = box.y + box.height / 2 - h / 2;
      const m = near ? TIER_BIT.near | TIER_BIT.mid : TIER_BIT.far | TIER_BIT.overview;
      out.push(
        shape(
          { key: `reach.pill${near ? "" : ".far"}`, z: 71, rect: at(x, y, w + padX * 2, h) },
          { fill: { kind: "flat", color: tok("raise-2") }, stroke: { color: tok("stroke-hi"), width: 1 } },
          { tiers: m, radii: 999, band: "lifted" },
        ),
        text(
          { key: `reach.pill.text${near ? "" : ".far"}`, z: 72, rect: at(x + padX, y + padY, w, run.size * 1.2) },
          { ink: tok("ink") },
          { tiers: m, band: "lifted", text: { ...run, width: w } },
        ),
      );
    }
  }
  return out;
};

export { ALL_TIERS };
