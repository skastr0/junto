/**
 * A deterministic board for the loom's routing parity check: twelve right-side
 * fans, each with a field of cards between its hub and its far ends, so the
 * comb legs detour and the spine has something to clear.
 */
import type { LoomEdgeInput, LoomObstacle } from "../src/window/lib/wire-loom";

const FAN = 4000;

export const loomParityObstacles = (): LoomObstacle[] => {
  const out: LoomObstacle[] = [];
  for (let h = 0; h < 12; h += 1) {
    const ox = h * FAN;
    const hubY = (h % 3) * 300;
    for (let i = 0; i < 24; i += 1) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      // Kept clear of the spine's own line: the cables are what the fan is.
      const side = row % 2 === 0 ? 1 : -1;
      out.push({
        nodeId: `c${h}-${i}`,
        x: ox + 140 + col * 60 + ((i * 13) % 20),
        y: hubY + side * (120 + Math.floor(row / 2) * 70) - 18,
        width: 48,
        height: 36,
      });
    }
  }
  return out;
};

export const loomParityEdges = (): LoomEdgeInput[] => {
  const out: LoomEdgeInput[] = [];
  for (let h = 0; h < 12; h += 1) {
    const ox = h * FAN;
    const hubY = (h % 3) * 300;
    for (let k = 0; k < 5; k += 1) {
      out.push({
        id: `e${h}-${k}`,
        sourceNodeId: `hub${h}`,
        sourceSide: "right",
        sourceAnchor: { x: ox, y: hubY },
        targetNodeId: `m${h}-${k}`,
        targetSide: "left",
        targetAnchor: { x: ox + 400, y: hubY + (k - 2) * 100 },
      });
    }
  }
  return out;
};
