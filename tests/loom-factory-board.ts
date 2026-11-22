/**
 * The proof's 1x factory board as the loom sees it: every card that is not a
 * region is an obstacle, and every wire keeps its stored sides. This is the
 * board the loom plans in the app (feed/loom's geometryOf/wiresOf), rebuilt
 * here without a renderer so a launch's plan can be hashed in a test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildInputs,
  collectObstacles,
  specsOf,
  type LoomNode,
  type LoomWire,
} from "../src/window/lib/loom-geometry";
import type { LoomEdgeInput, LoomObstacle } from "../src/window/lib/wire-loom";

export type FactoryBoard = {
  readonly geometry: LoomNode[];
  readonly wires: LoomWire[];
  readonly edges: LoomEdgeInput[];
  readonly obstacles: LoomObstacle[];
};

/** The scratch fixture's path: an explicit env, else the e2e probe's copy. */
export const factoryFixturePath = (): string =>
  process.env.JUNTO_FACTORY_FIXTURE ?? join(__dirname, "..", "e2e/scenarios/zz-idle-probe.factory.json");

const GAP = 1200;
const columnsFor = (copies: number): number => (copies === 1 ? 1 : copies === 10 ? 5 : 10);

export const factoryBoard = (copies = 1, path = factoryFixturePath()): FactoryBoard => {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as {
    readonly model: {
      readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly kind: string;
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }>;
      readonly wires: ReadonlyArray<{
        readonly id: string;
        readonly from: string;
        readonly to: string;
        readonly fromSide?: "left" | "right" | "top" | "bottom";
        readonly toSide?: "left" | "right" | "top" | "bottom";
      }>;
    };
  };
  const base = fixture.model.nodes;
  const boundWidth = Math.max(...base.map((node) => node.x + node.width));
  const boundHeight = Math.max(...base.map((node) => node.y + node.height));
  const columns = columnsFor(copies);
  const geometry: LoomNode[] = [];
  const wires: LoomWire[] = [];
  for (let tile = 0; tile < copies; tile += 1) {
    const prefix = copies === 1 ? "" : `t${tile}-`;
    const dx = (tile % columns) * (boundWidth + GAP);
    const dy = Math.floor(tile / columns) * (boundHeight + GAP);
    for (const node of base) {
      geometry.push({
        nodeId: `${prefix}${node.id}`,
        x: node.x + dx,
        y: node.y + dy,
        width: node.width,
        height: node.height,
        obstacle: node.kind !== "region",
        dragging: false,
      });
    }
    for (const wire of fixture.model.wires) {
      wires.push({
        id: `${prefix}${wire.id}`,
        source: `${prefix}${wire.from}`,
        target: `${prefix}${wire.to}`,
        heldSource: wire.fromSide ?? "right",
        heldTarget: wire.toSide ?? "left",
      });
    }
  }
  const specs = specsOf(wires, geometry);
  const { inputs } = buildInputs(specs, geometry);
  return { geometry, wires, edges: inputs, obstacles: collectObstacles(geometry) };
};
