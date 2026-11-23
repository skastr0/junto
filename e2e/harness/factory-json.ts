/**
 * The GPU proof's board as JSON (JUNTO_FACTORY_JSON), made from the board-only
 * file factory-board.sql writes. The JSON is the shape the gates draw:
 * rects, z order, region colours, card kinds and wire verbs. Every id, name,
 * key and text in it is made up (rebuildShape in nested-canvas-fixture.ts),
 * and its signals are a seeded tenth of the seats, not the board's.
 *
 *   bun e2e/harness/factory-json.ts <board-only.db> <out.json>
 *
 * gpu-proof.ts loadFactoryFixture reads it back.
 */

import { writeFileSync } from "node:fs";
import { loadFactoryShapeCanvas } from "./nested-canvas-fixture";

const [board, out] = process.argv.slice(2);
if (board === undefined || out === undefined) {
  console.error("usage: bun e2e/harness/factory-json.ts <board-only.db> <out.json>");
  process.exit(2);
}

const fixture = loadFactoryShapeCanvas({ dbPath: board, canvasName: "factory" });
writeFileSync(
  out,
  JSON.stringify({
    model: { nodes: fixture.model.nodes, wires: fixture.model.wires },
    stats: fixture.stats,
    signalRows: fixture.signals("factory"),
  }),
);
console.log(`${out}: ${String(fixture.stats.seats)} seats, ${String(fixture.stats.regions)} regions, ${String(fixture.stats.edges)} wires`);
