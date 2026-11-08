import { topModal } from "./modal-stack";
import { nodeViewStore, useNodeView } from "./node-view-state";

/**
 * The Artifacts node's comments rail: collapsed to an edge by default, open
 * or closed as one choice for every artifact, kept in view state so a quit
 * brings it back (0.11, 04, V3). Cmd+Shift+M (`comments.toggle`) flips it while a rail shows
 * in the modal in front.
 */

export const commentsRailOpen = (): boolean => nodeViewStore().commentsRailOpen();

/** The rail's choice, read again as it changes in any window. */
export const useCommentsRailOpen = (): boolean => useNodeView((store) => store.commentsRailOpen());

export const setCommentsRailOpen = (open: boolean): void => nodeViewStore().writeCommentsRailOpen(open);

/** Rails on screen, open or as an edge. */
const shown = new Set<HTMLElement>();

/** A ref for the rail's root: while it is mounted, the toggle's chord can reach it. */
export const commentsRailRef = (element: HTMLElement | null): (() => void) | undefined => {
  if (element === null) return undefined;
  shown.add(element);
  return () => {
    shown.delete(element);
  };
};

/** A rail shows inside the modal in front, so the toggle's chord is its to take. */
export const commentsRailInFront = (): boolean => {
  const front = topModal()?.container();
  if (front === null || front === undefined) return false;
  for (const element of shown) if (front.contains(element)) return true;
  return false;
};
