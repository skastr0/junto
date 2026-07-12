import type { CanvasDoc } from "./canvas";
import type { SnapshotState } from "./entities";
import { blockedClosure, groupMembers } from "./graph";

// Deterministic text projection of a canvas + snapshots for agent consumption.
// Contract: same doc + same snapshots -> byte-identical output. No timestamps,
// no randomness. Sections: regions (with members), entities (with stats),
// edges, blockers (with closure), seeds (unbound entity nodes), sources.
//
// PLACEHOLDER implementation — VL-005 replaces this with the full digest.
export const digestCanvas = (
  name: string,
  doc: CanvasDoc,
  snapshots: SnapshotState,
): string => {
  const blocked = blockedClosure(doc);
  const groups = groupMembers(doc);
  return [
    `canvas :: ${name}`,
    `nodes :: ${doc.nodes.length}`,
    `edges :: ${doc.edges.length}`,
    `groups :: ${groups.size}`,
    `blocked :: ${blocked.size}`,
    `sources :: ${snapshots.bundles.map((b) => `${b.source}=${b.ok ? "ok" : "down"}`).join(" ")}`,
    "",
  ].join("\n");
};
