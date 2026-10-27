import { topModal } from "./modal-stack";
import { sectionOpen, setSectionOpen, type SectionOpenMap } from "./sidebar-sections";

/**
 * The Artifacts node's comments rail: collapsed to an edge by default, open
 * or closed as one choice for every artifact, kept with the other sidebar
 * state for the session. Cmd+B (`rail.toggle`) flips it while a rail shows
 * in the modal in front.
 */

const RAIL_OPEN_KEY = "artifact-comments";

export const commentsRailOpen = (map?: SectionOpenMap): boolean => sectionOpen(RAIL_OPEN_KEY, false, map);

export const setCommentsRailOpen = (open: boolean): void => setSectionOpen(RAIL_OPEN_KEY, open);

/** Rails on screen, open or as an edge. */
const shown = new Set<HTMLElement>();

/** A ref for the rail's root: while it is mounted, Cmd+B can reach it. */
export const commentsRailRef = (element: HTMLElement | null): (() => void) | undefined => {
  if (element === null) return undefined;
  shown.add(element);
  return () => {
    shown.delete(element);
  };
};

/** A rail shows inside the modal in front, so Cmd+B is its to take. */
export const commentsRailInFront = (): boolean => {
  const front = topModal()?.container();
  if (front === null || front === undefined) return false;
  for (const element of shown) if (front.contains(element)) return true;
  return false;
};
