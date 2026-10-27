import {
  asCanvasName,
  asNodeId,
  asWireId,
  canvasFromOpened,
  type Canvas,
  type Node,
  type NodeOf,
  type Wire,
} from "../../src/shared/model";
import type { SeatTaskIndex } from "../../src/shared/execution-graph";
import type { World } from "../../src/main/junto/kernel/world";
import { THIS_MACHINE } from "./machines";

// Model nodes and wires for a test to put on a canvas. Each builder gives the
// smallest valid node of its kind; a test names only what it cares about.
// A node that lives on a machine is on THIS_MACHINE unless the test says so.

type Place = Partial<Pick<Node, "x" | "y" | "width" | "height" | "z" | "color">>;

const placed = (id: string) => ({
  id: asNodeId(id),
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  z: 0,
});

export const seat = (id: string, more: Partial<NodeOf<"agent">> = {}): NodeOf<"agent"> => ({
  kind: "agent",
  ...placed(id),
  agentKey: `local:${id}`,
  label: id,
  host: THIS_MACHINE,
  overseer: false,
  bindingId: `binding-${id}` as NodeOf<"agent">["bindingId"],
  harness: "claude",
  ...more,
});

export const terminal = (id: string, more: Partial<NodeOf<"terminal">> = {}): NodeOf<"terminal"> => ({
  kind: "terminal",
  ...placed(id),
  host: THIS_MACHINE,
  bindingId: `terminal-${id}` as NodeOf<"terminal">["bindingId"],
  ...more,
});

export const taskBoard = (id: string, more: Partial<NodeOf<"task">> = {}): NodeOf<"task"> =>
  ({ kind: "task", ...placed(id), ...more });
export const artifacts = (id: string, more: Partial<NodeOf<"artifacts">> = {}): NodeOf<"artifacts"> =>
  ({ kind: "artifacts", ...placed(id), ...more });
export const automations = (id: string, more: Partial<NodeOf<"automations">> = {}): NodeOf<"automations"> =>
  ({ kind: "automations", ...placed(id), ...more });
export const files = (id: string, more: Partial<NodeOf<"files">> = {}): NodeOf<"files"> =>
  ({ kind: "files", ...placed(id), host: THIS_MACHINE, root: "/Users/me/Projects/junto", ...more });
export const page = (id: string, more: Partial<NodeOf<"page">> = {}): NodeOf<"page"> => ({
  kind: "page",
  ...placed(id),
  url: "https://example.com/",
  profile: "default",
  onRemove: "kill-session",
  ...more,
});
export const note = (id: string, text = id, more: Place = {}): NodeOf<"note"> =>
  ({ kind: "note", ...placed(id), text, ...more });
export const region = (
  id: string,
  frame: Pick<Node, "x" | "y" | "width" | "height">,
  more: Partial<NodeOf<"region">> = {},
): NodeOf<"region"> => ({ kind: "region", ...placed(id), ...frame, hold: false, ...more });

export const wire = (
  id: string,
  from: string,
  to: string,
  verb: Wire["verb"],
  more: Partial<Wire> = {},
): Wire => ({ id: asWireId(id), from: asNodeId(from), to: asNodeId(to), verb, ...more });

/** A canvas holding these nodes and wires. Nodes stack in the order given. */
export const canvasOf = (
  nodes: ReadonlyArray<Node>,
  wires: ReadonlyArray<Wire> = [],
  name = "factory",
): Canvas =>
  canvasFromOpened({
    canvas: asCanvasName(name),
    seq: 0,
    nodes: nodes.map((node, z) => (node.z === 0 ? { ...node, z } : node)),
    wires,
  });

/** What the kernel holds of a canvas: the canvas and the task each seat holds. */
export const worldOf = (canvas: Canvas, seatTasks: SeatTaskIndex = {}): World => ({ canvas, seatTasks });
