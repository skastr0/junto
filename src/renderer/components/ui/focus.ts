/**
 * The kit's keyboard focus mark: one treatment for every control. Two pixels
 * of cyan at full strength (a ring is a mark, so the mark hue), 3 to 1 on the
 * ground and on raise in both themes (a 1px ring at 60 percent was near 2 to
 * 1 in bright). Inset where a clipping parent would cut an outer ring;
 * outside, with a gap, for a control too small to hold a ring inside it.
 *
 * The inset ring is written as a shadow, never as ring-inset: the theme has a
 * colour named inset, so Tailwind also reads ring-inset as "ring colour
 * inset" and that rule lands after ring-cyan. The ring was drawn in the
 * surface colour and could not be seen.
 */
export const FOCUS_RING_INSET = "focus-visible:shadow-[inset_0_0_0_2px_var(--color-cyan)]";
export const FOCUS_OUTLINE = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";
