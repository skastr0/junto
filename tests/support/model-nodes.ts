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
import type { KernelWork } from "../../src/shared/work-kernel";
import type { World } from "../../src/main/junto/kernel/world";

// Model nodes and wires for a test to put on a canvas. Each builder gives the
// smallest valid node of its kind; a test names only what it cares about.

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
  host: "local",
  overseer: false,
  bindingId: `binding-${id}` as NodeOf<"agent">["bindingId"],
  harness: "claude",
  onRemove: "detach",
  ...more,
});

export const terminal = (id: string, more: Partial<NodeOf<"terminal">> = {}): NodeOf<"terminal"> => ({
  kind: "terminal",
  ...placed(id),
  host: "local",
  bindingId: `terminal-${id}` as NodeOf<"terminal">["bindingId"],
  onRemove: "detach",
  ...more,
});

export const taskBoard = (id: string, more: Partial<NodeOf<"task">> = {}): NodeOf<"task"> =>
  ({ kind: "task", ...placed(id), ...more });
export const requests = (id: string, more: Partial<NodeOf<"requests">> = {}): NodeOf<"requests"> =>
  ({ kind: "requests", ...placed(id), ...more });
export const artifacts = (id: string, more: Partial<NodeOf<"artifacts">> = {}): NodeOf<"artifacts"> =>
  ({ kind: "artifacts", ...placed(id), ...more });
export const board = (id: string, more: Partial<NodeOf<"board">> = {}): NodeOf<"board"> =>
  ({ kind: "board", ...placed(id), ...more });
export const pad = (id: string, more: Partial<NodeOf<"pad">> = {}): NodeOf<"pad"> =>
  ({ kind: "pad", ...placed(id), ...more });
export const sheet = (id: string, more: Partial<NodeOf<"sheet">> = {}): NodeOf<"sheet"> =>
  ({ kind: "sheet", ...placed(id), ...more });
export const cron = (id: string, more: Partial<NodeOf<"cron">> = {}): NodeOf<"cron"> =>
  ({ kind: "cron", ...placed(id), host: "local", ...more });
export const relay = (id: string, more: Partial<NodeOf<"relay">> = {}): NodeOf<"relay"> =>
  ({ kind: "relay", ...placed(id), host: "local", ...more });
export const watcher = (id: string, more: Partial<NodeOf<"watcher">> = {}): NodeOf<"watcher"> =>
  ({ kind: "watcher", ...placed(id), host: "local", ...more });
export const page = (id: string, more: Partial<NodeOf<"page">> = {}): NodeOf<"page"> => ({
  kind: "page",
  ...placed(id),
  host: "local",
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

/** What the kernel holds of a canvas: the canvas, and the work beside it. */
export const worldOf = (canvas: Canvas, work: Partial<KernelWork> = {}): World => ({
  canvas,
  work: {
    tasks: work.tasks ?? new Map(),
    boards: work.boards ?? new Map(),
    artifacts: work.artifacts ?? new Map(),
  },
});
