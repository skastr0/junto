/**
 * `canvas.open`: a canvas as the desktop draws it, for the phone's native
 * canvas. A whitelist built field by field, never a node spread: each node's
 * kind, rectangle, paint order, title and colour, and each wire's ends and
 * the route the desktop draws for it. A region's environment, instruction and
 * contract, and a seat's agent key, host, binding and launch, never cross;
 * nor does any title the desktop would fall back to one of them.
 *
 * Pure: main and the demo both project their own canvas through it.
 */

import { COMPANION_CANVAS_NODE_KINDS, COMPANION_WIRE_POINTS_MAX, type CompanionCanvasNode, type CompanionCanvasNodeKind, type CompanionCanvasWire } from "./companion-protocol";
import type { CompanionCanvasDrawn } from "./companion-core";
import { wirePath } from "./canvas-wire-path";
import type { Canvas, Node } from "./model";
import { titleOf } from "./model/title";

const KINDS: ReadonlySet<string> = new Set(COMPANION_CANVAS_NODE_KINDS);
const LABEL_MAX = 256;

const explicit = (value: string | undefined): string | undefined => {
  const text = value?.replace(/\s+/gu, " ").trim();
  return text ? text : undefined;
};

/** A URL's host alone, never its user or password; an address that does not parse says nothing. */
const hostOnly = (url: string): string | undefined => {
  try {
    return explicit(new URL(url).host);
  } catch {
    return undefined;
  }
};

/**
 * The card's title, unless the desktop would make it from a field that never
 * crosses: a seat's agent key, a peer's host, a repository's folder, a task
 * board's contract. Those carry their own name or nothing.
 */
const titleFor = (node: Node): string | undefined => {
  switch (node.kind) {
    case "agent":
    case "peer":
    case "git":
      return explicit(node.label);
    case "task":
      return explicit(node.name);
    case "file":
      return explicit(node.path.split("/").filter((part) => part.trim() !== "").pop());
    case "link":
    case "page":
      return hostOnly(node.url);
    default:
      return explicit(titleOf(node));
  }
};

/** At most LABEL_MAX UTF-16 units, cut between code points so no surrogate pair is split. */
const labelOf = (node: Node): string | undefined => {
  const title = titleFor(node);
  if (title === undefined || title.length <= LABEL_MAX) return title;
  let cut = "";
  for (const point of title) {
    if (cut.length + point.length > LABEL_MAX - 1) break;
    cut += point;
  }
  return `${cut}…`;
};

export const companionCanvasNodes = (canvas: Canvas): ReadonlyArray<CompanionCanvasNode> => {
  const nodes: CompanionCanvasNode[] = [];
  for (const node of canvas.nodes.values()) {
    if (!KINDS.has(node.kind)) continue;
    const label = labelOf(node);
    nodes.push({
      nodeId: node.id,
      kind: node.kind as CompanionCanvasNodeKind,
      frame: { x: node.x, y: node.y, width: node.width, height: node.height },
      z: node.z,
      ...(label === undefined ? {} : { label }),
      ...(node.color === undefined ? {} : { color: node.color }),
    });
  }
  return nodes;
};

/**
 * Each wire whose two ends are drawn, routed as the desktop routes one wire:
 * its authored sides or the sides that face, past every card but a region.
 */
export const companionCanvasWires = (
  canvas: Canvas,
  nodes: ReadonlyArray<CompanionCanvasNode>,
): ReadonlyArray<CompanionCanvasWire> => {
  const frames = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const cards = nodes.filter((node) => node.kind !== "region");
  const wires: CompanionCanvasWire[] = [];
  for (const wire of canvas.wires.values()) {
    const from = frames.get(wire.from);
    const to = frames.get(wire.to);
    if (from === undefined || to === undefined) continue;
    const route = wirePath({
      from: from.frame,
      to: to.frame,
      ...(wire.fromSide === undefined ? {} : { fromSide: wire.fromSide }),
      ...(wire.toSide === undefined ? {} : { toSide: wire.toSide }),
      obstacles: cards.filter((card) => card.nodeId !== wire.from && card.nodeId !== wire.to).map((card) => card.frame),
    });
    if (route.points.length < 2 || route.points.length > COMPANION_WIRE_POINTS_MAX) continue;
    wires.push({
      wireId: wire.id,
      from: wire.from,
      to: wire.to,
      path: route.points.map((point) => ({ x: point.x, y: point.y })),
      radius: route.radius,
    });
  }
  return wires;
};

export const companionCanvasDrawn = (canvas: Canvas): CompanionCanvasDrawn => {
  const nodes = companionCanvasNodes(canvas);
  return { nodes, wires: companionCanvasWires(canvas, nodes) };
};
