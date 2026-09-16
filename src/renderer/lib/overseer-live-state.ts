import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import { observable } from "@legendapp/state";
import type { CanvasNode } from "@shared/canvas";
import type { LiveAttention } from "@shared/overseer-live";
import { state$ } from "./state";

export interface LiveSeatTarget {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly title: string;
}

/** Call lifetime belongs to the app shell, independent of canvas selection. */
export const overseerLive$ = observable({
  target: null as LiveSeatTarget | null,
  expanded: false,
});

export const canStartOverseerLive = (node: CanvasNode): boolean =>
  LIVE_OVERSEER_ENABLED && node.ether?.entity?.kind === "agent" && node.ether.overseer === true &&
  node.ether.terminal?.harness === "junto-overseer";

export const openOverseerLive = (target: LiveSeatTarget): void => {
  if (!LIVE_OVERSEER_ENABLED) return;
  // An existing call stays with its occupant. Opening a different seat never
  // silently replaces a live connection or transfers its authority.
  if (!overseerLive$.target.peek()) overseerLive$.target.set(target);
  overseerLive$.expanded.set(true);
};

export const readLiveAttention = (): LiveAttention => {
  const selected = state$.selectedNodeIds.peek();
  const single = state$.selectedNodeId.peek();
  return {
    canvasName: state$.canvasName.peek(),
    selectedNodeIds: [...new Set([...selected, ...(single ? [single] : [])])].slice(0, 100),
  };
};
