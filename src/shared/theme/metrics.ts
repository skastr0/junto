// Card measurements that are literals in CSS today (architecture §7, "One
// source"): the seat name's 13px, its line's 10.5px, the seat card's
// 28px 14px 14px 28px radius. They are component metrics, not theme steps —
// the type scale (type.ts) is a different thing and these px values are what
// the DOM draws today, so parity keeps them exact.
//
// Two projections read them:
//   - paint/card-spec.ts and the GPU canvas import CARD directly
//   - theme.generated.css emits --card-* so a DOM stylesheet can adopt the
//     same value (scripts/theme-build.ts)
// Mode-independent: one block serves both themes.

export const CARD = {
  /** Seat card name: mono, semibold, 13px (AgentSeatView, SeatCard, KindSeat). */
  nameSize: 13,
  /** Seat card line under the name: 10.5px leading-snug. */
  lineSize: 10.5,
  /** Seat card corner radii, CSS order: top-left, top-right, bottom-right,
   *  bottom-left — the 28px 14px 14px 28px asymmetric seat silhouette. */
  seatRadii: [28, 14, 14, 28],
} as const;
