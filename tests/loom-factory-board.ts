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

export const factoryBoard = (path = factoryFixturePath()): FactoryBoard => {
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
  const geometry: LoomNode[] = fixture.model.nodes.map((node) => ({
    nodeId: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    obstacle: node.kind !== "region",
    dragging: false,
  }));
  const wires: LoomWire[] = fixture.model.wires.map((wire) => ({
    id: wire.id,
    source: wire.from,
    target: wire.to,
    heldSource: wire.fromSide ?? "right",
    heldTarget: wire.toSide ?? "left",
  }));
  const specs = specsOf(wires, geometry);
  const { inputs } = buildInputs(specs, geometry);
  return { geometry, wires, edges: inputs, obstacles: collectObstacles(geometry) };
};
