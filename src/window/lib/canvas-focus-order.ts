/**
 * The order the keyboard walks the canvas: every card that paints the cyan
 * focus ring, read like a page (top to bottom, then left to right), with the
 * id as the last tie-break so two cards in one place still have one order.
 *
 * Regions are geography, not cards the operator works with a keyboard, and
 * their painter draws no focus ring; they stay out of the walk.
 */

/** The fields the order reads from a node row. */
export type FocusCard = {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
};

/** Card ids in Tab order. */
export const focusOrder = (nodes: Iterable<FocusCard>): ReadonlyArray<string> =>
  [...nodes]
    .filter((node) => node.kind !== "region")
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => node.id);

/**
 * The card one step away, wrapping at either end. `current` is "" when
 * nothing holds the ring: forward starts at the first card, backward at the
 * last.
 */
export const stepFocus = (
  order: ReadonlyArray<string>,
  current: string,
  direction: 1 | -1,
): string | undefined => {
  if (order.length === 0) return undefined;
  const at = current === "" ? -1 : order.indexOf(current);
  if (at === -1) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(at + direction + order.length) % order.length];
};
