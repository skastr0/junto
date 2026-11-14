/**
 * The card measurements that are literals in CSS today, as named constants
 * (architecture section 7, "Three things the canvas needs are not in the theme
 * source"). Every number here has a receipt in docs/canvas-gpu-inventory/
 * cards.md; `paint/` reads them and nothing else does arithmetic on a card.
 * Colours are never here: they are token names in `refs.ts`.
 */

import { AGENT_NODE_SIZE, SEAT_RING_PX } from "@shared/node-geometry";
import { CARD, RADIUS } from "@shared/theme";

/** A seat's box: 216 by 56. */
export const SEAT_BOX = AGENT_NODE_SIZE;

/** A radius token's length in board units (`RADIUS` holds CSS strings). */
const radiusPx = (name: keyof typeof RADIUS): number => Number.parseFloat(RADIUS[name] ?? "0");

/**
 * A kind seat's shell corners as its sheet authors them:
 * `border-radius: var(--radius-pill) var(--radius-xl) var(--radius-xl)
 * var(--radius-pill)` (`kind-seat.css`). The sheet's pill beside an xl is not
 * what CSS draws — it clamps the whole set — so `paint/` hands these to the
 * quad builder and `cssRadii` gives the used values: a fully round left end
 * concentric with the ring, square right corners.
 */
export const KIND_SHELL_RADII = [radiusPx("pill"), radiusPx("xl"), radiusPx("xl"), radiusPx("pill")] as const;

export const SEAT = {
  /** `border-radius: 28px 14px 14px 28px` (inventory 2.1). */
  radii: CARD.seatRadii,
  /**
   * Room the selected seat's drop needs: `0 8px 22px`, so 8 down plus half
   * the blur reaches 19 past the box. The shadow quad grows by this much and
   * names the element as its hole; the element is what the corners clamp to.
   */
  shadowInset: 20,
  /** Shell border 1px plus padding `1px 10px 1px 1px`: the row starts at 2 and ends 11 short of the edge. */
  rowLeft: 2,
  rowTop: 2,
  rowRight: 11,
  ring: SEAT_RING_PX,
  /** `gap-2` between ring and text. */
  gap: 8,
  portrait: 34,
  nameSize: CARD.nameSize,
  lineSize: CARD.lineSize,
  /** Tailwind `leading-snug`. */
  snug: 1.375,
  /** The task strip's `text-caption`. */
  captionSize: 9,
  /** The AI prefix of a reading: display face, 9 by 0.12 tracking. */
  aiSize: 9,
  aiTracking: 0.12,
} as const;

/** The ring's centre inside a seat's box: the anchor every far scale holds. */
export const SEAT_RING_CENTRE = {
  x: SEAT.rowLeft + SEAT.ring / 2,
  y: SEAT.rowTop + SEAT.ring / 2,
} as const;

/** The seat's content-box centre against the card's own (node-geometry.ts). */
export { SEAT_CONTENT_CENTRE_DX } from "@shared/node-geometry";

/** Text column of a seat: right of the ring and its gap, to the padded edge. */
export const SEAT_TEXT = {
  x: SEAT.rowLeft + SEAT.ring + SEAT.gap,
  width: SEAT_BOX.width - SEAT.rowRight - (SEAT.rowLeft + SEAT.ring + SEAT.gap),
} as const;

/** Harness badge on the portrait's circle (`AgentPortrait.tsx` Badge formulas at size 34). */
export const BADGE = (() => {
  const size = Math.min(26, Math.max(11, Math.round(SEAT.portrait * 0.42)));
  const offset = Math.round(SEAT.portrait * (0.5 + Math.SQRT1_2 / 2) - size / 2);
  return { size, offset, radius: Math.round((size * 8) / 28) + 1.5, plate: 1.5 } as const;
})();

/** Overseer crest: `left 50% top 0, 30% by 21%, min 9 by 6, translate(-50%, -4%)` of the ring. */
export const CREST = (() => {
  const width = Math.max(9, SEAT.ring * 0.3);
  const height = Math.max(6, SEAT.ring * 0.21);
  return { width, height, dy: -height * 0.04 } as const;
})();

/** The signal flag's hit box: top right 36% by 36% of the ring, min 10. */
export const FLAG_HIT = Math.max(10, SEAT.ring * 0.36);

/** Far and overview. */
export const FAR = {
  /** The name tag: padding `1px 8px 2px`, border 1, radius 6, `max-width: 220px`. */
  tag: { padX: 8, padTop: 1, padBottom: 2, border: 1, radius: 6, maxWidth: 220, gapUnits: 8, nameScale: 1.4 },
  /** Hit disc: `52 * 1.16`. */
  footprint: 1.16,
  /** Urgency halo rings in units of the seat scale: 2.5 amber 92%, 4 amber 30%. */
  halo: { inner: 2.5, outer: 4, innerAlpha: 0.92, outerAlpha: 0.3 },
  /** Hover outline 2 at offset 5, selected 3 (main 85%), both times the seat scale. */
  hover: { width: 2, offset: 5, alpha: 0.45 },
  selected: { width: 3, offset: 5, alpha: 0.85 },
} as const;

/** The focus ring on a keyboard-focused node: `1px` cyan, offset 3, radius-lg. */
export const FOCUS = { width: 1, offset: 3, radius: 8 } as const;

/** Reach preview: `inset -6px`, radius-lg; at far `-18px`. */
export const REACH = { inset: 6, insetFar: 18, radius: 8, pillGap: 14, pillGapFar: 40 } as const;

/** Preamble bubble (`preamble-bubble.css`). */
export const BUBBLE = {
  gap: 9,
  maxWidth: 272,
  padding: { top: 6, right: 6, bottom: 6, left: 9 },
  radius: 10,
  tail: 9,
  leftBase: 7,
  nowSize: 10.5,
} as const;

/** Focus dimming (`styles.css` focus modes). */
export const DIM = {
  outsider: { opacity: 0.22, saturate: 0.35 },
  lead: { opacity: 0.72, saturate: 0.85 },
  member: { opacity: 1, saturate: 1 },
  rest: { opacity: 1, saturate: 1 },
} as const;

/** Hover lift, one px (`seat-card.css`). */
export const LIFT_PX = 1;
