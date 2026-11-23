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

/**
 * Every control can be hit across at least 24px of height, the WCAG 2.2 AA
 * target minimum, whatever its drawn size: an invisible area centred on it.
 * The control is positioned for that, so do not place one with absolute or
 * fixed from a caller's className; wrap it instead. A parent that clips
 * (overflow hidden) cuts the area back to the drawn size.
 */
export const HIT_24 =
  "relative before:absolute before:inset-x-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:content-['']";
