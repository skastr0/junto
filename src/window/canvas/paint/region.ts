/**
 * A region (inventory 2.6 and 3): fill, border or outline by tier, title bar,
 * frame strips, urgency rollup glow and the name at a distance. Facts in,
 * quads out, all in the regions band. The wrapper is pointer-transparent in
 * the DOM; only the title bar and the frame strips answer the pointer, so
 * only they carry a `part`.
 */

import { MAX_REGION_DEPTH } from "@shared/graph";
import { canvasSwatchFor } from "@shared/canvas-colors";
import { UNNAMED_REGION } from "@shared/model/canvas";
import { BORDER } from "@shared/theme";
import { RegionUrgency } from "@shared/wire/urgency";
import type { CardFact, CardPaint, CardView, ColorRef, PaintEnv, Quad, QuadStyle, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { accentAt, accentRef, at, fade, mixOf, shadow, shape, sprite, text, tok } from "./refs";
import { dimOf, reachQuads } from "./overlays";

const NEAR = TIER_BIT.near;
const MID = TIER_BIT.mid;
const FAR = TIER_BIT.far;
const OVERVIEW = TIER_BIT.overview;

/** `region-title.css`, `styles.css` frame strips, `GroupNode.tsx`. */
export const REGION = {
  radius: 14,
  titlebar: 24,
  frame: 12,
  stripRadius: 12,
  titlePad: 8,
  titleGap: 6,
  titleRadii: [13, 13, 0, 0] as const,
  labelSize: 12,
  icon: 10,
} as const;

/** `canvas-lod-regions.css` `--urgency`: the group's hue, read from the urgency view. */
const urgencyHue = (kind: NonNullable<CardFact["derived"]["regionUrgency"]>["kind"]): ColorRef => {
  if (kind === RegionUrgency.group.blocked) return tok("crimson");
  if (kind === RegionUrgency.group["needs-you"]) return tok("amber");
  return tok("cyan");
};

/** `--region-hue`: the tint, leaning 72% (90% when held) toward the urgency's hue. */
const hueOf = (tint: ColorRef, urgency: CardFact["derived"]["regionUrgency"]): ColorRef =>
  urgency === undefined
    ? tint
    : mixOf(tint, urgencyHue(urgency.kind), urgency.reach === "held" ? 0.9 : 0.72);

/** `borderColor(color, emphasized)`: stored custom hex as it is, else stroke, else the accent at 32% or 50%. */
const borderOf = (color: string | undefined, emphasized: boolean): ColorRef => {
  const custom = color !== undefined && color.startsWith("#") && canvasSwatchFor(color) === undefined;
  if (custom) return accentRef(color);
  if (color === undefined || color === "") return tok(emphasized ? "stroke-hi" : "stroke");
  return accentAt(color, emphasized ? 0.5 : 0.32);
};

export const paintRegion = (
  fact: CardFact,
  view: CardView,
  env: PaintEnv,
  glance: { readonly region: number; readonly sub: number },
): CardPaint => {
  const row = fact.row;
  if (row.kind !== "region") return { quads: [], dim: dimOf(view), lift: 0 };
  const depth = fact.derived.regionDepth;
  const coloured = row.color !== undefined && row.color !== "";
  const tint = coloured ? accentRef(row.color) : tok("ink");
  const hue = hueOf(tint, fact.derived.regionUrgency);
  const w = row.width;
  const h = row.height;
  const box = at(0, 0, w, h);
  const name = (row.label ?? "").trim();
  // Depth 3 and below is hidden at the overview.
  const hideDeep = depth >= 3;
  const m = (mask: number): number => (hideDeep ? mask & ~OVERVIEW : mask);
  const quads: Quad[] = [];
  const R = REGION.radius;
  const region = { band: "regions" as const };

  // --- fill: gradient near, flat wash mid, hue wash at far and overview ----------
  const nearFill: QuadStyle["fill"] = coloured
    ? { kind: "gradient", angle: 135, from: fade(tint, 0.08), to: tok("ground", 0.25) }
    : { kind: "gradient", angle: 135, from: tok("raise", 0.22), to: tok("ground", 0.12) };
  const midFill: ColorRef = coloured ? fade(tint, 0.07) : tok("raise", 0.16);
  const farShare = coloured ? (depth === 0 ? 0.08 : 0.05) : 0.04;
  quads.push(
    shape({ key: "fill.near", z: 0, rect: box }, { fill: nearFill }, { ...region, tiers: NEAR, radii: R }),
    shape({ key: "fill.mid", z: 0, rect: box }, { fill: { kind: "flat", color: midFill } }, { ...region, tiers: MID, radii: R }),
    shape({ key: "fill.far", z: 0, rect: box }, { fill: { kind: "flat", color: fade(hue, farShare) } }, { ...region, tiers: m(FAR | OVERVIEW), radii: R }),
  );

  // --- frame: the 1px border near, an outline in canvas units below ---------------
  const border: ColorRef = view.selected
    ? tok("amber", 0.6)
    : view.hoveredPart === "regionFrame"
      ? tok("amber", 0.42)
      : borderOf(row.color, view.selected);
  quads.push(shape({ key: "border", z: 1, rect: box }, { stroke: { color: border, width: BORDER.hairline } }, { ...region, tiers: NEAR, radii: R }));
  if (view.selected) {
    quads.push(shape({ key: "border.ring", z: 1, rect: box }, { stroke: { color: tok("amber", 0.18), width: 1, outside: true } }, { ...region, tiers: NEAR, radii: R }));
  }
  const outline = (key: string, tiers: number, width: number, share: number, share34?: number): Quad => {
    const color: ColorRef = view.selected ? tok("amber", 0.8) : fade(hue, !coloured && share34 !== undefined ? share34 : share);
    return shape({ key, z: 1, rect: box }, { stroke: { color, width } }, { ...region, tiers, radii: R });
  };
  quads.push(
    outline("outline.mid", MID, BORDER["region-mid"], 0.4),
    outline("outline.far", m(FAR), BORDER["region-far"], 0.62, 0.34),
    outline("outline.overview", m(OVERVIEW), BORDER["region-overview"], 0.62, 0.34),
  );

  // --- urgency rollup: a faint fill and an inset frame and glow --------------------
  const urgency = fact.derived.regionUrgency;
  if (urgency !== undefined) {
    const tintU = urgencyHue(urgency.kind);
    const direct = urgency.reach === "direct";
    const nearName = direct ? "region-urgency" : "region-urgency-held";
    const farName = direct ? "region-urgency-far" : "region-urgency-held-far";
    if (direct) {
      quads.push(
        shape({ key: "urgency.fill.near", z: 2, rect: box }, { fill: { kind: "flat", color: fade(tintU, 0.03) } }, { ...region, tiers: NEAR | MID, radii: R }),
        shape({ key: "urgency.fill.far", z: 2, rect: box }, { fill: { kind: "flat", color: fade(tintU, 0.04) } }, { ...region, tiers: m(FAR | OVERVIEW), radii: R }),
      );
    }
    quads.push(
      shadow({ key: "urgency.near", z: 3, rect: box }, { shadow: { name: nearName, tint: tintU } }, { ...region, tiers: NEAR | MID, radii: R }),
      shadow({ key: "urgency.far", z: 3, rect: box }, { shadow: { name: farName, tint: tintU } }, { ...region, tiers: m(FAR | OVERVIEW), radii: R }),
    );
  }

  // --- title bar (near and mid), its hit area at every tier -----------------------
  const bar = at(0, 0, w, REGION.titlebar);
  const titleHover = view.hoveredPart === "regionTitle";
  quads.push(
    shape(
      { key: "title", z: 5, rect: bar },
      titleHover ? { fill: { kind: "flat", color: tok("amber", 0.06) } } : {},
      { ...region, tiers: NEAR | MID, radii: REGION.titleRadii, part: { kind: "regionTitle" } },
    ),
    shape({ key: "title.far", z: 5, rect: bar }, {}, { ...region, tiers: m(FAR | OVERVIEW), radii: REGION.titleRadii, part: { kind: "regionTitle" } }),
  );
  if (!view.editing) {
    const label = name === "" ? UNNAMED_REGION : name;
    const run: TextRun = { text: label, font: "mono", size: REGION.labelSize, weight: 600, leading: 1.4, truncate: "end", width: Math.max(0, w - REGION.titlePad * 2) };
    const lh = REGION.labelSize * 1.4;
    const icons = (row.hold ? 1 : 0) + (depth > MAX_REGION_DEPTH ? 1 : 0);
    const room = Math.max(0, w - REGION.titlePad * 2 - icons * (REGION.icon + REGION.titleGap));
    const used = Math.min(room, env.measure({ ...run, truncate: "none" }));
    const ink: ColorRef = coloured ? tint : tok("ink", 0.72);
    quads.push(
      text(
        { key: "title.label", z: 6, rect: at(REGION.titlePad, (REGION.titlebar - lh) / 2, used, lh) },
        { ink: view.hoveredPart === "regionTitle" ? tok("ink") : ink },
        { ...region, tiers: NEAR | MID, text: { ...run, width: used } },
      ),
    );
    let x = REGION.titlePad + used + REGION.titleGap;
    const iy = (REGION.titlebar - REGION.icon) / 2;
    if (row.hold) {
      quads.push(sprite({ key: "title.lock", z: 6, rect: at(x, iy, REGION.icon, REGION.icon) }, { ...region, tiers: NEAR | MID, sprite: { atlas: "glyph", name: "lock" }, style: { ink: tok("ink"), opacity: 0.5 } }));
      x += REGION.icon + REGION.titleGap;
    }
    if (depth > MAX_REGION_DEPTH) {
      quads.push(sprite({ key: "title.warn", z: 6, rect: at(x, iy, REGION.icon, REGION.icon) }, { ...region, tiers: NEAR | MID, sprite: { atlas: "glyph", name: "alert-triangle" }, style: { ink: tok("amber"), opacity: 0.8 } }));
    }
  }

  // --- frame strips: left, right and bottom; gone while selected (the resizer owns the edges) --
  if (!view.selected) {
    const wash: QuadStyle = view.hoveredPart === "regionFrame" ? { fill: { kind: "flat", color: tok("amber", 0.07) } } : {};
    const side = Math.max(0, h - REGION.titlebar);
    const strips: ReadonlyArray<readonly [string, number, number, number, number]> = [
      ["strip.left", 0, REGION.titlebar, REGION.frame, side],
      ["strip.right", w - REGION.frame, REGION.titlebar, REGION.frame, side],
      ["strip.bottom", 0, h - REGION.frame, w, REGION.frame],
    ];
    for (const [key, x, y, sw, sh] of strips) {
      quads.push(shape({ key, z: 4, rect: at(x, y, sw, sh) }, wash, { ...region, tiers: m(15), radii: REGION.stripRadius, part: { kind: "regionFrame" } }));
    }
  }

  // --- the name at a distance, in the clear slot --------------------------------
  const slot = fact.derived.nameSlot;
  const nested = depth >= 1;
  const opacity = nested ? glance.sub : glance.region;
  if (name !== "" && slot !== undefined && opacity > 0) {
    const tracking = nested ? 0.14 : 0.1;
    const run: TextRun = {
      text: name,
      font: "display",
      size: slot.fontSize,
      weight: 400,
      leading: 1,
      tracking,
      upper: true,
      align: "center",
      truncate: "end",
      width: slot.rect.width,
    };
    const rect = at(slot.rect.x, slot.rect.y + (slot.rect.height - slot.fontSize) / 2, slot.rect.width, slot.fontSize);
    const nearInk: ColorRef = coloured ? accentAt(row.color, 0.22) : tok("ink", nested ? 0.22 : 0.2);
    const farInk: ColorRef = coloured ? fade(mixOf(hue, tok("ink"), 0.7), 0.3) : tok("ink", 0.22);
    quads.push(
      text({ key: "name", z: 7, rect }, { ink: nearInk, opacity }, { ...region, tiers: NEAR | MID, text: run }),
      text({ key: "name.far", z: 7, rect }, { ink: farInk, opacity }, { ...region, tiers: m(FAR | OVERVIEW), text: run }),
    );
  }

  quads.push(...reachQuads(view, box, env));
  return { quads, dim: dimOf(view), lift: 0 };
};
