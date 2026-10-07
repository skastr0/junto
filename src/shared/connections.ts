import type { Entity, SnapshotState } from "./entities";
import type { BindingHint } from "./ipc";
import type { Canvas } from "./model/canvas";

// Where a seat joins the live corpus. A seat stores only the agent it runs
// (its agent key, "<host>:<profile>"); what that agent is doing is derived
// here, per snapshot, and never written back to the canvas. The live plane is
// Hermes only, and only seats join it.

// Built once per snapshot, O(corpus); every node resolution is O(1) lookups.
export interface ConnectionIndex {
  readonly byKey: ReadonlyMap<string, Entity>; // `${source}:${key}`
}

export const buildConnectionIndex = (snapshots: SnapshotState): ConnectionIndex => {
  const byKey = new Map<string, Entity>();

  for (const bundle of snapshots.bundles) {
    for (const entity of bundle.entities) {
      // A failed bundle may still carry facts observed during this exact
      // partial attempt. Admit only those explicit current rows; unspecified
      // or retained stale facts must not become authoritative connections.
      if (!bundle.ok && entity.stale !== false) continue;
      byKey.set(`${entity.source}:${entity.key}`, entity);
    }
  }

  return { byKey };
};

/**
 * The agents to look up, from canvases: every seat names the Hermes agent it
 * runs by its agent key, whether or not that agent is in the current bundle.
 */
export const seatIdentityHints = (
  canvases: Iterable<Pick<Canvas, "nodes">>,
): ReadonlyArray<BindingHint> => {
  const seen = new Set<string>();
  const hints: BindingHint[] = [];
  for (const canvas of canvases) {
    for (const node of canvas.nodes.values()) {
      if (node.kind !== "agent" || seen.has(node.agentKey)) continue;
      seen.add(node.agentKey);
      hints.push({ source: "hermes", key: node.agentKey });
    }
  }
  return hints;
};
