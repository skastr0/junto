/**
 * One notification that a canvas's automations changed, for open panes:
 * a ruled command, a firing claimed or settled on this machine, or a firing
 * revision folded from the exchange (0.11, 05 S3). The pane reads only
 * `automation_firings` again; the node id is the Automations node.
 */
import type { NodeId } from "@shared/physics/schema";

export type AutomationsChangedListener = (canvasName: string, nodeId: NodeId) => void;

const listeners = new Set<AutomationsChangedListener>();

/** Returns the unsubscribe. */
export const onAutomationsChanged = (listener: AutomationsChangedListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyAutomationsChanged = (canvasName: string, nodeId: NodeId): void => {
  for (const listener of listeners) listener(canvasName, nodeId);
};
