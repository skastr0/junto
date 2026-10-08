import { productNodeKindEnabled, productVerbEnabled } from "@shared/features";
import { validateFlowDag } from "@shared/flow-graph";
import {
  asWireId,
  type Color,
  type Command,
  type Node,
  type NodeEdit,
  type NodeEditOf,
  type NodeKind,
  type NodeMove,
  type SheetGrid,
  type Wire,
} from "@shared/model";
import { nodeOf, wiresAt, type Canvas } from "@shared/model/canvas";
import { defaultVerbForPair, verbsForPair, type Port, type Verb } from "@shared/physics";
import { physicsKind } from "./model-kind";

// Everything the operator can do to what is on a canvas, as the commands that
// do it. Each function reads the canvas as the window holds it and returns the
// commands to send: none when the act would change nothing, so a caller never
// sends, or notes for undo, an edit that is not one. Nothing here sends, and
// nothing here holds a canvas.

type Commands = ReadonlyArray<Command>;
const NONE: Commands = [];

type Side = NonNullable<Wire["fromSide"]>;
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Fields of one node ──────────────────────────────────────────────────────

/** The fields an edit may name for a kind: every key but `kind`, a `null` clearing one. */
export type FieldsOf<K extends NodeKind> = Omit<NodeEditOf<K>, "kind">;

/**
 * Change fields of one node. A field already at the value asked for is left
 * out, as is clearing one that is absent; nothing is sent when none remain or
 * the node is not of this kind.
 */
export const edited = <K extends NodeKind>(canvas: Canvas, id: string, kind: K, fields: FieldsOf<K>): Commands => {
  const node = nodeOf(canvas, id as Node["id"], kind);
  if (node === undefined) return NONE;
  const now = node as Record<string, unknown>;
  const change: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null ? now[key] === undefined : same(now[key], value)) continue;
    change[key] = value;
  }
  if (Object.keys(change).length === 0) return NONE;
  return [{ _tag: "Edit", canvas: canvas.name, id: node.id, change: { kind, ...change } as NodeEdit }];
};

/** One line, as a name is held: trimmed, with any further lines dropped. */
const oneLine = (text: string): string => (text.split(/\r?\n/, 1)[0] ?? "").trim();

/**
 * Rename a node. Each kind keeps its name in its own field; a seat always has
 * one, so an empty name leaves a seat as it is, and clears the name of
 * anything else. Notes and bare labels have text, not a name (see `retexted`),
 * and a file, a link and a page are named by what they point at.
 */
export const renamed = (canvas: Canvas, id: string, name: string): Commands => {
  const node = canvas.nodes.get(id as Node["id"]);
  if (node === undefined) return NONE;
  const line = oneLine(name);
  const value = line === "" ? null : line;
  switch (node.kind) {
    case "agent":
      return line === "" ? NONE : edited(canvas, id, "agent", { label: line });
    case "task":
    case "requests":
      return edited(canvas, id, node.kind, { name: value });
    case "terminal":
    case "artifacts":
    case "board":
    case "pad":
    case "sheet":
    case "cron":
    case "relay":
    case "watcher":
    case "git":
    case "region":
      return edited(canvas, id, node.kind, { label: value });
    case "note":
    case "label":
    case "file":
    case "link":
    case "page":
      return NONE;
  }
};

/** Replace the text of a note or a bare label. */
export const retexted = (canvas: Canvas, id: string, text: string): Commands => {
  const node = canvas.nodes.get(id as Node["id"]);
  if (node === undefined || (node.kind !== "note" && node.kind !== "label")) return NONE;
  return edited(canvas, id, node.kind, { text });
};

/** Change a page's URL, browser binding or removal choice. */
export const pageEdited = (canvas: Canvas, id: string, fields: FieldsOf<"page">): Commands =>
  edited(canvas, id, "page", fields);

/** Change a git card's repository or label. */
export const gitEdited = (canvas: Canvas, id: string, fields: FieldsOf<"git">): Commands =>
  edited(canvas, id, "git", fields);

/** Change a cron's schedule, host or label. */
export const cronEdited = (canvas: Canvas, id: string, fields: FieldsOf<"cron">): Commands =>
  edited(canvas, id, "cron", fields);

/** Change a gauge's threshold, host or label. */
export const watcherEdited = (canvas: Canvas, id: string, fields: FieldsOf<"watcher">): Commands =>
  edited(canvas, id, "watcher", fields);

// ── Place, size, colour, order ──────────────────────────────────────────────

/**
 * Move nodes to new positions, as a drag ends. Positions are held whole, so a
 * node that lands where it was is left out.
 */
export const moved = (
  canvas: Canvas,
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
): Commands => {
  const moves: Array<NodeMove> = [];
  for (const [id, position] of positions) {
    const node = canvas.nodes.get(id as Node["id"]);
    if (node === undefined) continue;
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    if (x !== node.x || y !== node.y) moves.push({ id: node.id, x, y });
  }
  return moves.length === 0 ? NONE : [{ _tag: "Move", canvas: canvas.name, moves }];
};

/** Resize one node; a resize from the top or left also moves it. */
export const resized = (canvas: Canvas, id: string, frame: Rect): Commands => {
  const node = canvas.nodes.get(id as Node["id"]);
  if (node === undefined) return NONE;
  const x = Math.round(frame.x);
  const y = Math.round(frame.y);
  const width = Math.round(frame.width);
  const height = Math.round(frame.height);
  if (width <= 0 || height <= 0) return NONE;
  if (x === node.x && y === node.y && width === node.width && height === node.height) return NONE;
  const sized = width !== node.width || height !== node.height;
  return [{
    _tag: "Move",
    canvas: canvas.name,
    moves: [{ id: node.id, x, y, ...(sized ? { size: { width, height } } : {}) }],
  }];
};

/**
 * What rides along when a region that holds its contents is dragged: every
 * node, nested regions included, whose centre lies in it. Deliberately looser
 * than membership (whole rectangle inside), so a card straddling the edge
 * still travels. Empty for a region that does not hold.
 */
export const heldBy = (canvas: Canvas, regionId: string): ReadonlyArray<string> => {
  const region = nodeOf(canvas, regionId as Node["id"], "region");
  if (region === undefined || !region.hold) return [];
  const riders: Array<string> = [];
  for (const node of canvas.nodes.values()) {
    if (node.id === region.id) continue;
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    if (cx >= region.x && cx <= region.x + region.width && cy >= region.y && cy <= region.y + region.height) {
      riders.push(node.id);
    }
  }
  return riders;
};

/** Drag a region by its label: the region, and what it holds, by the same distance. One command. */
export const regionDragged = (
  canvas: Canvas,
  regionId: string,
  to: { readonly x: number; readonly y: number },
): Commands => {
  const region = nodeOf(canvas, regionId as Node["id"], "region");
  if (region === undefined) return NONE;
  const dx = Math.round(to.x) - region.x;
  const dy = Math.round(to.y) - region.y;
  const positions = new Map<string, { x: number; y: number }>([[region.id, { x: region.x + dx, y: region.y + dy }]]);
  for (const id of heldBy(canvas, regionId)) {
    const node = canvas.nodes.get(id as Node["id"]);
    if (node !== undefined) positions.set(id, { x: node.x + dx, y: node.y + dy });
  }
  return moved(canvas, positions);
};

/** Colour nodes, or clear their colour. Nodes already that colour are left out. */
export const recolored = (canvas: Canvas, ids: ReadonlyArray<string>, color: Color | undefined): Commands => {
  const nodes = [...new Set(ids)].flatMap((id) => {
    const node = canvas.nodes.get(id as Node["id"]);
    return node === undefined || node.color === color ? [] : [node.id];
  });
  return nodes.length === 0 ? NONE : [{ _tag: "Recolor", canvas: canvas.name, nodes, color: color ?? null }];
};

/** Bring nodes to the front or send them to the back, in the order they already stack. */
export const restacked = (canvas: Canvas, ids: ReadonlyArray<string>, to: "front" | "back"): Commands => {
  const wanted = new Set(ids);
  const stack = [...canvas.nodes.values()].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  const nodes = stack.filter((node) => wanted.has(node.id)).map((node) => node.id);
  if (nodes.length === 0) return NONE;
  // Already there: the named nodes are the whole of that end of the stack.
  const end = to === "front" ? stack.slice(-nodes.length) : stack.slice(0, nodes.length);
  if (end.every((node, index) => node.id === nodes[index])) return NONE;
  return [{ _tag: "Restack", canvas: canvas.name, nodes, to }];
};

// ── Adding and removing ─────────────────────────────────────────────────────

/** Put new nodes, and wires between them or to what is there, on the canvas. */
export const added = (canvas: Canvas, nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): Commands =>
  nodes.length === 0 && wires.length === 0 ? NONE : [{ _tag: "Add", canvas: canvas.name, nodes, wires }];

/** Where a new node stacks: above everything on the canvas. */
export const topZ = (canvas: Canvas): number => {
  let top = -1;
  for (const node of canvas.nodes.values()) if (node.z > top) top = node.z;
  return top + 1;
};

/**
 * Remove nodes and wires. Every wire with an end on a removed node is named
 * too, so the command says all it takes and undo can put all of it back.
 */
export const removed = (canvas: Canvas, nodeIds: ReadonlyArray<string>, wireIds: ReadonlyArray<string> = []): Commands => {
  const nodes = [...new Set(nodeIds)].flatMap((id) => {
    const node = canvas.nodes.get(id as Node["id"]);
    return node === undefined ? [] : [node.id];
  });
  const wires = new Set<Wire["id"]>();
  for (const id of wireIds) {
    const wire = canvas.wires.get(asWireId(id));
    if (wire !== undefined) wires.add(wire.id);
  }
  for (const id of nodes) for (const wire of wiresAt(canvas, id)) wires.add(wire.id);
  return nodes.length === 0 && wires.size === 0
    ? NONE
    : [{ _tag: "Remove", canvas: canvas.name, nodes, wires: [...wires] }];
};

// ── Wires ───────────────────────────────────────────────────────────────────

/** The kind word the verb table knows a node by; nothing for a card that only sits there. */
const verbKind = (node: Node): string | undefined => physicsKind(node.kind);

export type DrawVerbs = {
  /** Verbs the pair admits, in table order. Empty means the two cannot be joined. */
  readonly verbs: ReadonlyArray<Verb>;
  /** True when the verb's subject is the card the wire was drawn to. */
  readonly reversed: boolean;
};

const NO_VERBS: DrawVerbs = { verbs: [], reversed: false };

/** A region, a bare label and a git card take no wire, nor does a kind this build has off. */
const wireable = (node: Node): boolean =>
  node.kind !== "region" && node.kind !== "label" && node.kind !== "git" && productNodeKindEnabled(verbKind(node));

/**
 * The verbs a wire drawn from one node to another may carry. Drawn order wins
 * where the grammar admits it; otherwise the reverse is tried, and the wire is
 * kept the other way round, because a verb reads in one direction.
 */
export const verbsForDraw = (from: Node | undefined, to: Node | undefined): DrawVerbs => {
  if (from === undefined || to === undefined || !wireable(from) || !wireable(to)) return NO_VERBS;
  const drawn = verbsForPair(verbKind(from), verbKind(to)).filter(productVerbEnabled);
  if (drawn.length > 0) return { verbs: drawn, reversed: false };
  const flipped = verbsForPair(verbKind(to), verbKind(from)).filter(productVerbEnabled);
  return flipped.length > 0 ? { verbs: flipped, reversed: true } : NO_VERBS;
};

export type ConnectRefusal = "self" | "missing" | "label" | "git" | "disabled" | "no-verb" | "duplicate" | "cycle";

export type Connected =
  | { readonly ok: true; readonly commands: Commands; readonly wire: Wire }
  | { readonly ok: false; readonly why: ConnectRefusal; readonly cycle?: ReadonlyArray<string> };

/**
 * Join two nodes. The verb is the one the operator dropped on when the pair
 * admits it, else the pair's default. `id` is minted by the caller. A wire
 * that feeds work may not close a loop.
 */
export const connected = (
  canvas: Canvas,
  draw: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly verb?: Verb | undefined;
    readonly fromSide?: Side | undefined;
    readonly toSide?: Side | undefined;
  },
): Connected => {
  if (draw.from === draw.to) return { ok: false, why: "self" };
  const drawnFrom = canvas.nodes.get(draw.from as Node["id"]);
  const drawnTo = canvas.nodes.get(draw.to as Node["id"]);
  if (drawnFrom === undefined || drawnTo === undefined) return { ok: false, why: "missing" };
  for (const node of [drawnFrom, drawnTo]) {
    if (node.kind === "label") return { ok: false, why: "label" };
    if (node.kind === "git") return { ok: false, why: "git" };
    if (!productNodeKindEnabled(verbKind(node))) return { ok: false, why: "disabled" };
  }
  const admits = verbsForDraw(drawnFrom, drawnTo);
  const from = admits.reversed ? drawnTo : drawnFrom;
  const to = admits.reversed ? drawnFrom : drawnTo;
  const verb =
    (draw.verb !== undefined && admits.verbs.includes(draw.verb) ? draw.verb : undefined) ??
    (admits.verbs.length > 0 ? defaultVerbForPair(verbKind(from), verbKind(to)) : undefined);
  if (verb === undefined) return { ok: false, why: "no-verb" };
  for (const wire of canvas.wires.values()) {
    if (wire.from === from.id && wire.to === to.id) return { ok: false, why: "duplicate" };
  }
  // Sides follow the stored ends, so a reversed draw keeps its anchors.
  const fromSide = admits.reversed ? draw.toSide : draw.fromSide;
  const toSide = admits.reversed ? draw.fromSide : draw.toSide;
  const wire: Wire = {
    id: asWireId(draw.id),
    from: from.id,
    to: to.id,
    verb,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
  };
  if (verb === "feeds") {
    const wires = new Map(canvas.wires);
    wires.set(wire.id, wire);
    const cycle = validateFlowDag({ wires });
    if (cycle !== undefined) return { ok: false, why: "cycle", cycle: cycle.cycle };
  }
  return { ok: true, commands: [{ _tag: "Add", canvas: canvas.name, nodes: [], wires: [wire] }], wire };
};

type WireChange = Extract<Command, { readonly _tag: "Rewire" }>["change"];

const rewired = (canvas: Canvas, id: string, fields: WireChange): Commands => {
  const wire = canvas.wires.get(asWireId(id));
  if (wire === undefined) return NONE;
  const now = wire as Record<string, unknown>;
  const change: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null ? now[key] === undefined : same(now[key], value)) continue;
    change[key] = value;
  }
  if (Object.keys(change).length === 0) return NONE;
  return [{ _tag: "Rewire", canvas: canvas.name, id: wire.id, change: change as WireChange }];
};

/**
 * Change the verb of a wire. Only a verb the two ends admit in the direction
 * the wire already runs; ports the operator had taken away are given back,
 * since a mask belongs to the verb it was made under.
 */
export const reverbed = (canvas: Canvas, id: string, verb: Verb): Commands => {
  const wire = canvas.wires.get(asWireId(id));
  if (wire === undefined || wire.verb === verb) return NONE;
  const from = canvas.nodes.get(wire.from);
  const to = canvas.nodes.get(wire.to);
  if (from === undefined || to === undefined) return NONE;
  if (!verbsForPair(verbKind(from), verbKind(to)).filter(productVerbEnabled).includes(verb)) return NONE;
  return rewired(canvas, id, { verb, mask: null });
};

/** Take ports away from what a wire's verb grants, or give them all back with `undefined`. */
export const masked = (canvas: Canvas, id: string, mask: ReadonlyArray<Port> | undefined): Commands =>
  rewired(canvas, id, { mask: mask === undefined ? null : mask });

/** Pin where a wire attaches at either end, or let an end find the nearest side with `null`. */
export const reanchored = (
  canvas: Canvas,
  id: string,
  sides: { readonly fromSide?: Side | null; readonly toSide?: Side | null },
): Commands => rewired(canvas, id, sides);

// ── Regions, task boards, sheets ────────────────────────────────────────────

/**
 * Change what a region says and gives to what is inside it: its hold, the
 * briefing agents read, its defaults, its contract and its environment. A
 * `null` clears the field.
 */
export const regionEdited = (canvas: Canvas, id: string, fields: FieldsOf<"region">): Commands =>
  edited(canvas, id, "region", fields);

/** Change a task board's name or the contract agents work under. */
export const taskBoardEdited = (canvas: Canvas, id: string, fields: FieldsOf<"task">): Commands =>
  edited(canvas, id, "task", fields);

/** Replace what a sheet holds. `now` is its grid today, when the caller has it, to skip a write that changes nothing. */
export const sheetWritten = (canvas: Canvas, id: string, grid: SheetGrid, now?: SheetGrid): Commands => {
  const sheet = nodeOf(canvas, id as Node["id"], "sheet");
  if (sheet === undefined || (now !== undefined && same(now, grid))) return NONE;
  return [{ _tag: "WriteSheet", canvas: canvas.name, id: sheet.id, grid }];
};
