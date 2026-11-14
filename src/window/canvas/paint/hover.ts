/**
 * The hovered card's full-detail bloom at mid and far: every near-detail
 * quad drawn again in the lifted band, scaled about the ring centre by the
 * engine's hover rule. The normal mid pill and far ring step aside while it
 * stands in, so the card under the pointer becomes the readable card the
 * operator was reaching for.
 */

import { TIER_BIT, type Quad, type Radii, type ScaleRule } from "../contract";
import { SEAT, SEAT_BOX, SEAT_RING_CENTRE } from "./card-spec";
import { at, grow, shadow } from "./refs";

/** Mid and far bloom; near is already full, overview keeps its quiet ring. */
export const HOVER_TIERS = TIER_BIT.mid | TIER_BIT.far;

/** The scale every bloomed quad grows by, anchored on the ring the pointer holds. */
export const HOVER_SCALE: ScaleRule = { kind: "hover", anchor: SEAT_RING_CENTRE };

/** A lifted copy of every near quad, plus the hover drop when nothing selected one. */
export const hoverBloom = (
  quads: ReadonlyArray<Quad>,
  options: { readonly selected: boolean; readonly radii: Radii },
): ReadonlyArray<Quad> => {
  const bloom = quads
    .filter((quad) => (quad.tiers & TIER_BIT.near) !== 0)
    .map((quad): Quad => ({
      ...quad,
      key: `hover.${quad.key}`,
      tiers: HOVER_TIERS,
      band: "lifted",
      scale: HOVER_SCALE,
      // The bloom is one readable surface: an enqueue hit is answered from
      // the inverse point, not from a part rectangle in grown coordinates.
      part: undefined,
    }));
  if (!options.selected) {
    bloom.push(
      shadow(
        { key: "hover.shell.shadow", z: 0, rect: grow(at(0, 0, SEAT_BOX.width, SEAT_BOX.height), SEAT.shadowInset) },
        { shadow: { name: "seat" } },
        { tiers: HOVER_TIERS, band: "lifted", scale: HOVER_SCALE, radii: options.radii, hole: SEAT.shadowInset },
      ),
    );
  }
  return bloom;
};
