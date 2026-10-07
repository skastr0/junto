// A card renders when its own node changed and at no other time.
//
// React Flow renders a node again whenever the node object it is given is a
// different object, and it keeps what it measured (a card's size on screen) on
// its own copy of that object. A rebuild of the canvas hands back the nodes as
// the canvas has them, which never carry a measurement. Handing those to React
// Flow as they are replaces every node it holds, so every card renders again
// and is measured again, for a change that touched one of them.
//
// So a rebuilt node is given to React Flow only when it says something its
// copy does not. Otherwise React Flow keeps the object it has, measurement and
// all, and the card is left alone.

type Position = { readonly x: number; readonly y: number };

/** The fields a rebuild sets. Anything else on a node is React Flow's own. */
const OURS = [
  "type",
  "data",
  "style",
  "zIndex",
  "className",
  "selected",
  "ariaLabel",
  "connectable",
  "focusable",
  "selectable",
  "draggable",
  "hidden",
  "parentId",
] as const;

type FlowLike = { readonly id: string; readonly position: Position } & {
  readonly [K in (typeof OURS)[number]]?: unknown;
};

/** True when the rebuilt node says nothing the held one does not already say. */
export const saysTheSame = <N extends FlowLike>(held: N, rebuilt: N): boolean =>
  held === rebuilt ||
  (held.position.x === rebuilt.position.x &&
    held.position.y === rebuilt.position.y &&
    OURS.every((field) => held[field] === rebuilt[field]));

/**
 * The nodes to give React Flow after a rebuild: each held node that still says
 * what the rebuilt one says, and the rebuilt one where it does not. The held
 * array itself when nothing changed, so React Flow is not told anything.
 */
export const keepHeldNodes = <N extends FlowLike>(held: ReadonlyArray<N>, rebuilt: ReadonlyArray<N>): N[] => {
  const heldById = new Map<string, N>();
  for (const node of held) heldById.set(node.id, node);
  let same = held.length === rebuilt.length;
  const next = rebuilt.map((node, index) => {
    const before = heldById.get(node.id);
    const kept = before !== undefined && saysTheSame(before, node) ? before : node;
    if (kept !== held[index]) same = false;
    return kept;
  });
  return same ? (held as N[]) : next;
};

type CardProps = { readonly id: string; readonly selected?: boolean; readonly data: object };

/**
 * Whether a card needs no render for new props. A card reads its node from the
 * store by canvas and id; from React Flow it takes only its id, whether it is
 * selected, and the few facts on `data`. Where React Flow says the node is, how
 * big it measured, or that it is being dragged does not reach a card.
 */
export const sameCard = (before: CardProps, after: CardProps): boolean => {
  if (before.id !== after.id || before.selected !== after.selected) return false;
  if (before.data === after.data) return true;
  const was = before.data as Record<string, unknown>;
  const now = after.data as Record<string, unknown>;
  const keys = Object.keys(now);
  return keys.length === Object.keys(was).length && keys.every((key) => was[key] === now[key]);
};
