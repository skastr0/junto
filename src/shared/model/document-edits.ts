import type { CanvasDoc, CanvasEdge, CanvasNode } from "../canvas";
import {
  asCanvasName,
  type Command,
  type Node,
  type NodeEdit,
  type NodeMove,
  type SheetGrid,
  type Wire,
} from "./index";
import { nodeOfDocument, wireOfDocument } from "./from-document";

// The difference between two documents, as the commands that make it. This is
// how a writer that still works on a document changes the canvas: it says what
// the document should become, and what is sent is only what differs. No
// document is saved.
//
// TEMPORARY, and on its way out. It has two callers. The window: each writer
// that is rewritten as a direct edit (model-edits.ts, through authoring.act)
// stops calling commitDoc. The overseer (main/junto/overseer/portfolio.ts): its
// wire still speaks documents, and it goes when that wire speaks model kinds.
// This file is deleted with the last of them.
//
// It runs once per commit, never per mouse move, and it skips by identity: a
// writer replaces only the node and edge objects it changes, so an object both
// documents share costs one pointer comparison and is never read or decoded.
//
// A grant of overseer authority and a recorded session are never part of a
// difference: a document cannot give or take either.

type Commands = ReadonlyArray<Command>;

/** Fields of a node that an Edit never carries. */
const NOT_EDITED: ReadonlySet<string> = new Set([
  "id", "kind", "x", "y", "width", "height", "z", "color",
  "agentKey", "bindingId", "overseer", "sessionId",
]);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The objects of one list that the other does not share, by identity. */
const unshared = <T extends object>(list: ReadonlyArray<T>, other: ReadonlyArray<T>): ReadonlyArray<T> => {
  const shared = new Set<T>(other);
  return list.filter((item) => !shared.has(item));
};

const rowsOf = (canvas: string, nodes: ReadonlyArray<CanvasNode>): Map<string, Node> => {
  const rows = new Map<string, Node>();
  nodes.forEach((node, z) => {
    // The place in the stack is not compared, so any index will do.
    const row = nodeOfDocument(canvas, node, z);
    if (row !== undefined && !rows.has(row.id)) rows.set(row.id, row);
  });
  return rows;
};

const wiresOf = (edges: ReadonlyArray<CanvasEdge>): Map<string, Wire> => {
  const wires = new Map<string, Wire>();
  for (const edge of edges) {
    const wire = wireOfDocument(edge);
    if (wire !== undefined && !wires.has(wire.id)) wires.set(wire.id, wire);
  }
  return wires;
};

const sheetOf = (node: CanvasNode | undefined): unknown => node?.ether?.sheet;

/**
 * The commands that take a canvas from one document to another. `top` is the
 * place in the stack a new node takes (the first of them; the rest follow),
 * since a document only knows the order of its nodes, not where they stack.
 */
export const documentEdits = (canvasName: string, before: CanvasDoc, after: CanvasDoc, top: number): Commands => {
  const canvas = asCanvasName(canvasName);
  // Only what the two documents do not share is read at all.
  const nodesWas = unshared(before.nodes, after.nodes);
  const nodesNow = unshared(after.nodes, before.nodes);
  const was = rowsOf(canvasName, nodesWas);
  const now = rowsOf(canvasName, nodesNow);
  const wiresWas = wiresOf(unshared(before.edges, after.edges));
  const wiresNow = wiresOf(unshared(after.edges, before.edges));

  // A node that became another kind, or a terminal on another session, is a
  // different thing under the same id: it goes and comes back.
  const replaced = new Set<string>();
  for (const [id, next] of now) {
    const old = was.get(id);
    if (old === undefined) continue;
    if (old.kind !== next.kind) replaced.add(id);
    else if (old.kind === "terminal" && next.kind === "terminal" && old.bindingId !== next.bindingId) replaced.add(id);
  }

  const removedNodes = [...was.keys()].filter((id) => !now.has(id) || replaced.has(id)) as Array<Node["id"]>;
  const gone = new Set<string>(removedNodes);
  const removedWires = [...wiresWas.values()]
    .filter((wire) => {
      const next = wiresNow.get(wire.id);
      return next === undefined || next.from !== wire.from || next.to !== wire.to || gone.has(wire.from) || gone.has(wire.to);
    })
    .map((wire) => wire.id);
  const goneWires = new Set<string>(removedWires);

  let place = top;
  const addedNodes = [...now.values()]
    .filter((node) => !was.has(node.id) || replaced.has(node.id))
    .map((node): Node => ({ ...node, z: place++, ...(node.kind === "agent" ? { overseer: false } : {}) }) as Node);
  const addedWires = [...wiresNow.values()].filter((wire) => !wiresWas.has(wire.id) || goneWires.has(wire.id));

  const reseats: Array<Command> = [];
  const moves: Array<NodeMove> = [];
  const recolours = new Map<string | null, Array<Node["id"]>>();
  const edits: Array<Command> = [];
  for (const [id, next] of now) {
    const old = was.get(id);
    if (old === undefined || replaced.has(id)) continue;
    const sized = old.width !== next.width || old.height !== next.height;
    if (old.x !== next.x || old.y !== next.y || sized) {
      moves.push({ id: next.id, x: next.x, y: next.y, ...(sized ? { size: { width: next.width, height: next.height } } : {}) });
    }
    if (old.color !== next.color) {
      const color = next.color ?? null;
      recolours.set(color, [...(recolours.get(color) ?? []), next.id]);
    }
    // Another agent, or a new session, in the same seat.
    const reseated =
      old.kind === "agent" && next.kind === "agent" &&
      (old.agentKey !== next.agentKey || old.bindingId !== next.bindingId);
    if (reseated && next.kind === "agent") {
      reseats.push({
        _tag: "Reseat", canvas, id: next.id, agentKey: next.agentKey, bindingId: next.bindingId,
        harness: next.harness, host: next.host, launch: next.launch ?? null,
      });
    }
    const change: Record<string, unknown> = {};
    const a = old as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (NOT_EDITED.has(key)) continue;
      // A reseat already says the harness, the host and the launch.
      if (reseated && (key === "harness" || key === "host" || key === "launch")) continue;
      if (!same(a[key], b[key])) change[key] = b[key] ?? null;
    }
    if (Object.keys(change).length > 0) {
      edits.push({ _tag: "Edit", canvas, id: next.id, change: { kind: next.kind, ...change } as NodeEdit });
    }
  }

  // A sheet's grid is content of its own, written by its own command.
  const sheets: Array<Command> = [];
  const beforeById = new Map(nodesWas.map((node) => [node.id, node]));
  for (const node of nodesNow) {
    const row = now.get(node.id);
    if (row?.kind !== "sheet") continue;
    const grid = sheetOf(node);
    if (grid !== undefined && !same(grid, sheetOf(beforeById.get(node.id)))) {
      sheets.push({ _tag: "WriteSheet", canvas, id: row.id, grid: grid as SheetGrid });
    }
  }

  const rewires: Array<Command> = [];
  for (const [id, next] of wiresNow) {
    const old = wiresWas.get(id);
    if (old === undefined || goneWires.has(id)) continue;
    const change: Record<string, unknown> = {};
    if (old.verb !== next.verb) change.verb = next.verb;
    for (const key of ["mask", "fromSide", "toSide"] as const) {
      if (!same(old[key], next[key])) change[key] = next[key] ?? null;
    }
    if (Object.keys(change).length > 0) {
      rewires.push({ _tag: "Rewire", canvas, id: next.id, change } as Command);
    }
  }

  // The order of the nodes both documents hold, when it changed. Ids alone
  // are read, and only when the two lists are not the same list.
  let restack: Array<Command> = [];
  if (before.nodes !== after.nodes) {
    const idsWas = new Set(before.nodes.map((node) => node.id));
    const idsNow = new Set(after.nodes.map((node) => node.id));
    const lost = new Set<string>([...removedNodes, ...replaced]);
    const kept = (nodes: ReadonlyArray<CanvasNode>, other: ReadonlySet<string>): Array<string> =>
      nodes.map((node) => node.id).filter((id) => other.has(id) && !lost.has(id));
    const order = kept(after.nodes, idsWas);
    const orderWas = kept(before.nodes, idsNow);
    if (order.length !== orderWas.length || order.some((id, index) => id !== orderWas[index])) {
      restack = [{ _tag: "Restack", canvas, nodes: order as Array<Node["id"]>, to: "front" }];
    }
  }

  return [
    ...(removedNodes.length > 0 || removedWires.length > 0
      ? [{ _tag: "Remove", canvas, nodes: removedNodes, wires: removedWires } as Command]
      : []),
    ...(addedNodes.length > 0 || addedWires.length > 0
      ? [{ _tag: "Add", canvas, nodes: addedNodes, wires: addedWires } as Command]
      : []),
    ...reseats,
    ...(moves.length > 0 ? [{ _tag: "Move", canvas, moves } as Command] : []),
    ...[...recolours].map(([color, nodes]): Command => ({ _tag: "Recolor", canvas, nodes, color })),
    ...edits,
    ...sheets,
    ...rewires,
    ...restack,
  ];
};
