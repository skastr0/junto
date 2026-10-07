/**
 * The kit's keyboard focus mark: one treatment for every control. Two pixels
 * of cyan at full strength (a ring is a mark, so the mark hue), 3 to 1 on the
 * ground and on raise in both themes (a 1px ring at 60 percent was near 2 to
 * 1 in bright). Inset where a clipping parent would cut an outer ring;
 * outside, with a gap, for a control too small to hold a ring inside it.
 */
export const FOCUS_RING_INSET = "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan";
export const FOCUS_OUTLINE = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";
