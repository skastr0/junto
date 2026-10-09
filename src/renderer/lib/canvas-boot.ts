export type CanvasBootAction =
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "seed" };

/**
 * What the window shows first: the first canvas this machine holds, its own
 * or a copy of one another machine edits. With none, it starts an empty one.
 */
export const nextCanvasBootAction = (
  names: ReadonlyArray<string>,
): CanvasBootAction => {
  const first = names[0];
  return first === undefined ? { kind: "seed" } : { kind: "open", name: first };
};
