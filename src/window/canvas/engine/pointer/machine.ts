/**
 * The pointer machine (section 15): one pure step from a state and an input to
 * the next state, the intents the shell turns into today's writers, and the
 * effects the engine applies itself (live drag offsets, the marquee, the
 * connection preview, edge auto-pan, middle-button pan).
 *
 * The engine owns the clock and the camera. While an effect says `autoPan`, it
 * pans by that much each display frame and then steps the machine with
 * `{ kind: "tick" }`, so whatever the pointer holds follows the board.
 *
 * Nothing here writes: a drag moves cards through `offset` effects every
 * frame, and only the drop says `move`, naming the cards whose rounded
 * position changed (`syncPositions`, lib/geometry.ts:45-47 and
 * lib/model-edits.ts:163-176).
 */

import type { CanvasInput, HandleSide, Hit, Intent, NodeId, Part, Point, Rect, Size } from "../../contract";
import { autoPan } from "./auto-pan";
import {
  CONNECT_SNAP_RADIUS,
  DRAG_THRESHOLD_PX,
  HANDLE_SIDES,
  VERB_ZONE_BLEED,
  around,
  boundsOf,
  contains,
  handleId,
  handlePoint,
  hasHandles,
  overlaps,
  rectBetween,
  resizeRuleFor,
  resizedRect,
  sameIds,
  verbHandleId,
  verbZones,
  type ResizeDirection,
} from "./rules";

// ---------------------------------------------------------------------------
// What the engine supplies
// ---------------------------------------------------------------------------

/** The small read surface the machine asks of the engine. All rectangles are board units. */
export interface PointerWorld {
  /** The hit under a screen point, in paint order (section 15's part table). */
  readonly pick: (screen: Point) => Hit | null;
  /** The one screen to board conversion (must 8). */
  readonly screenToBoard: (screen: Point) => Point;
  /** The canvas element's size in CSS pixels, for edge auto-pan. */
  readonly viewport: () => Size;
  readonly rectOf: (id: NodeId) => Rect | undefined;
  readonly kindOf: (id: NodeId) => string | undefined;
  /** Cards whose rectangle meets `rect`, from the spatial index. Extra candidates are fine: the machine tests each. */
  readonly query: (rect: Rect) => ReadonlyArray<NodeId>;
  /** The selection as the engine was last told it (`SelectionFact.nodeIds`). */
  readonly selection: () => ReadonlyArray<NodeId>;
  /** `canConnect` (lib/edge-mutations.ts:62-69) on the two cards. */
  readonly canConnect: (source: NodeId, target: NodeId) => boolean;
  /** `verbsForDraw(...).verbs` for the pair, in table order. */
  readonly verbsFor: (source: NodeId, target: NodeId) => ReadonlyArray<string>;
  /** `heldBy` (lib/model-edits.ts:196-215): what rides along with a region, empty unless it holds. */
  readonly riders: (regionId: NodeId) => ReadonlyArray<NodeId>;
}

/** What the machine takes: the shell's input, and the engine's frame tick while auto-pan runs. */
export type PointerMachineEvent = CanvasInput | { readonly kind: "tick" };

// ---------------------------------------------------------------------------
// What the engine applies itself
// ---------------------------------------------------------------------------

export type ConnectTarget = {
  readonly nodeId: NodeId;
  /** The handle or landing zone the wire lands on (`t-left`, `s-top`, `verb:feeds`). */
  readonly handle: string;
  /** The zone's verb, when it landed on one. */
  readonly verb?: string;
  /** The board point the preview line ends at. */
  readonly at: Point;
};

export type ConnectPreview = {
  readonly from: NodeId;
  readonly fromHandle: string;
  /** Where the line starts and where the pointer is, board units. */
  readonly start: Point;
  readonly pointer: Point;
  /** The snapped handle or zone, if any; `valid` says whether a drop there connects. */
  readonly target: ConnectTarget | null;
  readonly valid: boolean;
};

export type PointerEffect =
  /** Cards drawn moved by `by` board units (null: the gesture let go of them). */
  | { readonly kind: "offset"; readonly ids: ReadonlyArray<NodeId>; readonly by: Point | null }
  /** A card drawn at this rectangle while it is resized (null: let go). */
  | { readonly kind: "resizing"; readonly id: NodeId; readonly rect: Rect | null }
  /** The marquee rectangle, board units (null: gone). */
  | { readonly kind: "marquee"; readonly rect: Rect | null }
  | { readonly kind: "connecting"; readonly preview: ConnectPreview | null }
  /** Pan by this many screen pixels every display frame, then tick (null: stop). */
  | { readonly kind: "autoPan"; readonly perFrame: Point | null }
  /** Pan once by this many screen pixels (middle-button drag). */
  | { readonly kind: "pan"; readonly by: Point }
  /** A cluster badge was clicked: the camera moves to it (260 ms, SeatClusterLayer.tsx:172-173). */
  | { readonly kind: "cluster"; readonly memberIds: ReadonlyArray<NodeId>; readonly at: Point };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Pending = {
  readonly kind: "press";
  readonly pointerId: number;
  readonly hit: Hit | null;
  readonly screen: Point;
  readonly board: Point;
  readonly clicks: number;
  /** The pressed card was selected before the press (an image opens on a click when it was). */
  readonly wasSelected: boolean;
};

type Drag = {
  readonly kind: "drag";
  readonly pointerId: number;
  readonly ids: ReadonlyArray<NodeId>;
  readonly origins: ReadonlyArray<{ readonly id: NodeId } & Point>;
  readonly startBoard: Point;
  readonly screen: Point;
  readonly by: Point;
  readonly autoPan: Point | null;
  /** A region drag: from its title bar or frame, no threshold, no auto-pan, selects it on release. */
  readonly region?: { readonly id: NodeId; readonly part: Part; readonly clicks: number; readonly moved: boolean };
};

type Resize = {
  readonly kind: "resize";
  readonly pointerId: number;
  readonly id: NodeId;
  readonly direction: ResizeDirection;
  readonly start: Rect;
  readonly startBoard: Point;
  readonly min: Size;
  readonly rect: Rect;
};

type Connect = {
  readonly kind: "connect";
  readonly pointerId: number;
  readonly from: NodeId;
  readonly fromHandle: { readonly id: string; readonly side: HandleSide; readonly role: "source" | "target" };
  readonly screen: Point;
  readonly autoPan: Point | null;
  readonly target: ConnectTarget | null;
  readonly valid: boolean;
};

type Marquee = {
  readonly kind: "marquee";
  readonly pointerId: number;
  readonly startBoard: Point;
  readonly screen: Point;
  readonly autoPan: Point | null;
  readonly picked: ReadonlyArray<NodeId>;
  /** The selection as last said, so a marquee move that changes nothing says nothing. */
  readonly said: ReadonlyArray<NodeId>;
};

type Gesture =
  | { readonly kind: "idle" }
  | Pending
  | Drag
  | Resize
  | Connect
  | Marquee
  | { readonly kind: "pan"; readonly pointerId: number; readonly screen: Point }
  /** A press already answered (a Shift toggle, a right click): nothing more until it lifts. */
  | { readonly kind: "consumed"; readonly pointerId: number };

export type PointerState = {
  readonly gesture: Gesture;
  /** Identity of the hit under a resting pointer, so hover is said once per change. */
  readonly hover: string | null;
};

export const POINTER_IDLE: PointerState = { gesture: { kind: "idle" }, hover: null };

export type PointerStep = {
  readonly state: PointerState;
  readonly intents: ReadonlyArray<Intent>;
  readonly effects: ReadonlyArray<PointerEffect>;
};

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

type Out = { intents: Array<Intent>; effects: Array<PointerEffect> };

type PointerInput = Extract<CanvasInput, { readonly kind: "pointer" }>;

const LEFT = 0;
const MIDDLE = 1;
const RIGHT = 2;

const ZERO: Point = { x: 0, y: 0 };

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

const samePoint = (a: Point | null, b: Point | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y);

const hoverKey = (hit: Hit | null): string | null => {
  if (hit === null) return null;
  const part = hit.part;
  const detail =
    part.kind === "handle"
      ? `${part.side}:${part.role}`
      : part.kind === "resize"
        ? part.corner
        : part.kind === "resizeEdge"
          ? part.edge
          : part.kind === "verbZone"
            ? part.verb
            : "";
  return `${hit.nodeId ?? ""}|${hit.wireId ?? ""}|${part.kind}|${detail}`;
};

/** Parts that are their own buttons: a press on them clicks and never drags (`nodrag` controls). */
const isButton = (part: Part): boolean =>
  part.kind === "ringFlag" ||
  part.kind === "taskEnqueue" ||
  part.kind === "bubbleClose" ||
  part.kind === "noteLink" ||
  part.kind === "image";

const sameTarget = (a: Hit | null, b: Hit | null): boolean =>
  a !== null && b !== null && a.nodeId === b.nodeId && a.wireId === b.wireId && a.part.kind === b.part.kind;

export const stepPointer = (state: PointerState, event: PointerMachineEvent, world: PointerWorld): PointerStep => {
  const out: Out = { intents: [], effects: [] };
  const next = route(state, event, world, out);
  return { state: next, intents: out.intents, effects: out.effects };
};

const route = (state: PointerState, event: PointerMachineEvent, world: PointerWorld, out: Out): PointerState => {
  switch (event.kind) {
    case "tick":
      return { ...state, gesture: tick(state.gesture, world, out) };
    case "visibility":
      return event.visible ? state : { gesture: cancel(state.gesture, world, out), hover: null };
    case "pointer":
      return pointer(state, event, world, out);
    default:
      return state;
  }
};

const pointer = (state: PointerState, event: PointerInput, world: PointerWorld, out: Out): PointerState => {
  const gesture = state.gesture;
  if (event.phase === "down") {
    if (gesture.kind !== "idle") {
      // A second button or a second pointer while a gesture runs is not ours.
      if (gesture.pointerId !== event.pointerId) return state;
      // A down for a pointer we still hold means its up was lost: let the old gesture go first.
      return down({ ...state, gesture: cancel(gesture, world, out) }, event, world, out);
    }
    return down(state, event, world, out);
  }
  if (gesture.kind === "idle") {
    if (event.phase === "move") return hover(state, world.pick(event.at), out);
    if (event.phase === "leave" || event.phase === "cancel") return hover(state, null, out);
    return state;
  }
  if (gesture.pointerId !== event.pointerId) return state;
  switch (event.phase) {
    case "move":
      return { ...state, gesture: move(gesture, event.at, world, out) };
    case "up":
      return { ...state, gesture: up(gesture, event, world, out) };
    case "cancel":
      return { ...state, gesture: cancel(gesture, world, out) };
    default:
      // `leave` mid-gesture: the shell holds pointer capture, so the gesture goes on.
      return state;
  }
};

const hover = (state: PointerState, hit: Hit | null, out: Out): PointerState => {
  const key = hoverKey(hit);
  if (key === state.hover) return state;
  out.intents.push({ kind: "hover", hit });
  return { ...state, hover: key };
};

// --- down ---------------------------------------------------------------------

const down = (state: PointerState, event: PointerInput, world: PointerWorld, out: Out): PointerState => {
  const at = event.at;
  if (event.button === MIDDLE) {
    // `panOnDrag={[1]}`, over cards and wires too (Canvas.tsx:1848; rf-system:2843-2847).
    return { ...state, gesture: { kind: "pan", pointerId: event.pointerId, screen: at } };
  }
  const hit = world.pick(at);
  if (event.button === RIGHT) {
    menu(hit, at, event.modifiers.shift, world, out);
    return { ...state, gesture: { kind: "consumed", pointerId: event.pointerId } };
  }
  if (event.button !== LEFT) return state;
  const board = world.screenToBoard(at);
  const id = hit?.nodeId;
  const part = hit?.part;

  // Shift + press on a card or region chrome toggles it, and does nothing else:
  // it never drags, opens, renames or edits (Canvas.tsx:1784-1813; GroupNode.tsx:289-305).
  if (event.modifiers.shift && id !== undefined && part !== undefined && part.kind !== "wire" && part.kind !== "cluster") {
    out.intents.push({ kind: "select", nodeIds: [id], mode: "toggle" });
    return { ...state, gesture: { kind: "consumed", pointerId: event.pointerId } };
  }

  if (id !== undefined && part !== undefined && (part.kind === "resize" || part.kind === "resizeEdge")) {
    const rule = resizeRuleFor(world.kindOf(id));
    const start = world.rectOf(id);
    if (rule.kind === "free" && start !== undefined) {
      out.intents.push({ kind: "gesture", gesture: "resize", nodeIds: [id] });
      return {
        ...state,
        gesture: {
          kind: "resize",
          pointerId: event.pointerId,
          id,
          direction: part.kind === "resize" ? part.corner : part.edge,
          start,
          startBoard: board,
          min: rule.min,
          rect: start,
        },
      };
    }
  }

  if (id !== undefined && part !== undefined && (part.kind === "regionTitle" || part.kind === "regionFrame")) {
    // The region's own handler: left button, no threshold (GroupNode.tsx:232-283).
    const ids = [id, ...world.riders(id).filter((rider) => rider !== id)];
    const origins = originsOf(ids, world);
    // The reach preview follows a region across a boundary as it follows a
    // card: the frame says which rectangles the pointer owns from here on.
    out.intents.push({ kind: "gesture", gesture: "drag", nodeIds: [id, ...origins.map((o) => o.id).filter((member) => member !== id)] });
    return {
      ...state,
      gesture: {
        kind: "drag",
        pointerId: event.pointerId,
        ids: origins.map((o) => o.id),
        origins,
        startBoard: board,
        screen: at,
        by: ZERO,
        autoPan: null,
        region: { id, part, clicks: event.clicks, moved: false },
      },
    };
  }

  const wasSelected = id !== undefined && world.selection().includes(id);
  return {
    ...state,
    gesture: { kind: "press", pointerId: event.pointerId, hit, screen: at, board, clicks: event.clicks, wasSelected },
  };
};

const originsOf = (ids: ReadonlyArray<NodeId>, world: PointerWorld): ReadonlyArray<{ readonly id: NodeId } & Point> => {
  const origins: Array<{ readonly id: NodeId } & Point> = [];
  for (const id of ids) {
    const rect = world.rectOf(id);
    if (rect !== undefined) origins.push({ id, x: rect.x, y: rect.y });
  }
  return origins;
};

// --- right click --------------------------------------------------------------

const menu = (hit: Hit | null, screen: Point, shift: boolean, world: PointerWorld, out: Out): void => {
  const at = hit?.at ?? world.screenToBoard(screen);
  if (hit === null || hit.part.kind === "pane") {
    out.intents.push({ kind: "menu", target: "pane", at, screen });
    return;
  }
  if (hit.part.kind === "wire" && hit.wireId !== undefined) {
    out.intents.push({ kind: "menu", target: "wire", wireId: hit.wireId, at, screen });
    return;
  }
  const id = hit.nodeId;
  if (id === undefined) return;
  // The order of Canvas.tsx:1665-1688.
  const selection = world.selection();
  const selected = selection.includes(id);
  const region = world.kindOf(id) === "region";
  if (selection.length >= 1 && !selected && !region) {
    // connectableSourceIds (Canvas.tsx:1314-1323): selected, not the target, not a region, not a label.
    const sourceIds = selection.filter((source) => {
      if (source === id) return false;
      const kind = world.kindOf(source);
      return kind !== "region" && kind !== "label";
    });
    if (sourceIds.length > 0) {
      out.intents.push(
        shift ? { kind: "connectAll", targetId: id, sourceIds } : { kind: "connectMenu", targetId: id, sourceIds, at, screen },
      );
      return;
    }
  }
  if (selection.length > 1 && selected) {
    out.intents.push({ kind: "menu", target: "selection", at, screen });
    return;
  }
  if (region) {
    // A region's chrome opens the add menu, as empty space does.
    out.intents.push({ kind: "menu", target: "pane", nodeId: id, at, screen });
    return;
  }
  // The shell picks the seat menu for an agent and nothing for the rest.
  out.intents.push({ kind: "menu", target: "card", nodeId: id, at, screen });
};

// --- move ---------------------------------------------------------------------

const move = (gesture: Exclude<Gesture, { kind: "idle" }>, at: Point, world: PointerWorld, out: Out): Gesture => {
  switch (gesture.kind) {
    case "press":
      return pressMove(gesture, at, world, out);
    case "drag":
      return dragTo(gesture, at, world, out);
    case "resize":
      return resizeTo(gesture, at, world, out);
    case "connect":
      return connectTo(gesture, at, world, out);
    case "marquee":
      return marqueeTo(gesture, at, world, out);
    case "pan": {
      const by = sub(at, gesture.screen);
      if (by.x !== 0 || by.y !== 0) out.effects.push({ kind: "pan", by });
      return { ...gesture, screen: at };
    }
    case "consumed":
      return gesture;
  }
};

const pastThreshold = (from: Point, to: Point): boolean => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
};

const pressMove = (press: Pending, at: Point, world: PointerWorld, out: Out): Gesture => {
  if (!pastThreshold(press.screen, at)) return press;
  const hit = press.hit;
  const id = hit?.nodeId;
  const part = hit?.part;

  if (hit === null || part === undefined || part.kind === "pane") {
    out.intents.push({ kind: "gesture", gesture: "marquee", nodeIds: [] });
    const marquee: Marquee = {
      kind: "marquee",
      pointerId: press.pointerId,
      startBoard: press.board,
      screen: at,
      autoPan: null,
      picked: [],
      said: world.selection(),
    };
    return marqueeTo(marquee, at, world, out);
  }
  if (id === undefined || isButton(part) || part.kind === "wire" || part.kind === "cluster") return press;

  if (part.kind === "handle" && id !== undefined && hasHandles(world.kindOf(id))) {
    out.intents.push({ kind: "gesture", gesture: "connect", nodeIds: [id] });
    const connect: Connect = {
      kind: "connect",
      pointerId: press.pointerId,
      from: id,
      fromHandle: { id: part.id, side: part.side, role: part.role },
      screen: at,
      autoPan: null,
      target: null,
      valid: false,
    };
    return connectTo(connect, at, world, out);
  }

  // A card drag: the whole selection when the card is in it, else the card,
  // selected first (`selectNodesOnDrag`, rf-react:3285-3349). Regions never
  // ride a card drag (`draggable: !region`, lib/flow-nodes.ts:241).
  const selection = world.selection();
  let ids: ReadonlyArray<NodeId>;
  if (selection.includes(id)) {
    ids = selection.filter((member) => world.kindOf(member) !== "region");
  } else {
    out.intents.push({ kind: "select", nodeIds: [id], mode: "replace" });
    ids = [id];
  }
  const origins = originsOf(ids, world);
  // The grabbed card leads the gesture's ids: its card carries the reach
  // preview's words, however the selection is ordered.
  out.intents.push({ kind: "gesture", gesture: "drag", nodeIds: [id, ...origins.map((o) => o.id).filter((member) => member !== id)] });
  const drag: Drag = {
    kind: "drag",
    pointerId: press.pointerId,
    ids: origins.map((o) => o.id),
    origins,
    startBoard: press.board,
    screen: at,
    by: ZERO,
    autoPan: null,
  };
  return dragTo(drag, at, world, out);
};

/** Edge auto-pan for gestures that have it: said when it changes. */
const panFor = (current: Point | null, at: Point, world: PointerWorld, out: Out): Point | null => {
  const next = autoPan(at, world.viewport());
  if (!samePoint(current, next)) out.effects.push({ kind: "autoPan", perFrame: next });
  return next;
};

const dragTo = (drag: Drag, at: Point, world: PointerWorld, out: Out): Drag => {
  const by = sub(world.screenToBoard(at), drag.startBoard);
  out.effects.push({ kind: "offset", ids: drag.ids, by });
  if (drag.region !== undefined) {
    // GroupNode's handler has no auto-pan (interaction inventory, "Auto-pan at edges").
    return { ...drag, screen: at, by, region: { ...drag.region, moved: drag.region.moved || by.x !== 0 || by.y !== 0 } };
  }
  return { ...drag, screen: at, by, autoPan: panFor(drag.autoPan, at, world, out) };
};

const resizeTo = (resize: Resize, at: Point, world: PointerWorld, out: Out): Resize => {
  const travel = sub(world.screenToBoard(at), resize.startBoard);
  const rect = resizedRect(resize.start, resize.direction, travel, resize.min);
  out.effects.push({ kind: "resizing", id: resize.id, rect });
  return { ...resize, rect };
};

const marqueeTo = (marquee: Marquee, at: Point, world: PointerWorld, out: Out): Marquee => {
  const rect = rectBetween(marquee.startBoard, world.screenToBoard(at));
  out.effects.push({ kind: "marquee", rect });
  // Partly inside counts; regions are never taken (`selectable: !region`).
  const picked = world.query(rect).filter((id) => {
    if (world.kindOf(id) === "region") return false;
    const card = world.rectOf(id);
    return card !== undefined && overlaps(card, rect);
  });
  let said = marquee.said;
  if (!sameIds(picked, said)) {
    out.intents.push(picked.length === 0 ? { kind: "clearSelection" } : { kind: "select", nodeIds: picked, mode: "replace" });
    said = picked;
  }
  return { ...marquee, screen: at, picked, said, autoPan: panFor(marquee.autoPan, at, world, out) };
};

// --- connect ------------------------------------------------------------------

type Candidate = { readonly nodeId: NodeId; readonly handle: string; readonly role: "source" | "target"; readonly verb?: string; readonly at: Point };

/** The pair a landing on `onto` makes, in loose mode (rf-system:2588-2593): from a target handle the wire runs the other way. */
const pairOf = (connect: Connect, onto: NodeId, handle: string) =>
  connect.fromHandle.role === "source"
    ? { source: connect.from, target: onto, sourceHandle: connect.fromHandle.id, targetHandle: handle }
    : { source: onto, target: connect.from, sourceHandle: handle, targetHandle: connect.fromHandle.id };

const connectTo = (connect: Connect, at: Point, world: PointerWorld, out: Out): Connect => {
  const board = world.screenToBoard(at);
  const target = resolveTarget(connect, at, board, world);
  const valid =
    target !== null &&
    target.nodeId !== connect.from &&
    (() => {
      const pair = pairOf(connect, target.nodeId, target.handle);
      return world.canConnect(pair.source, pair.target);
    })();
  const fromRect = world.rectOf(connect.from);
  const start = fromRect === undefined ? board : handlePoint(fromRect, connect.fromHandle.side, connect.fromHandle.role);
  out.effects.push({
    kind: "connecting",
    preview: { from: connect.from, fromHandle: connect.fromHandle.id, start, pointer: board, target, valid },
  });
  return { ...connect, screen: at, target, valid, autoPan: panFor(connect.autoPan, at, world, out) };
};

/**
 * Where a connection would land, by React Flow's order (rf-system:2569-2574):
 * the handle under the pointer first (a landing zone sits on top of the side
 * dots, z-index 20), else the closest handle within the snap radius.
 */
const resolveTarget = (connect: Connect, screen: Point, board: Point, world: PointerWorld): ConnectTarget | null => {
  const near = world.query(around(board, CONNECT_SNAP_RADIUS + VERB_ZONE_BLEED + 4));
  const candidates: Array<Candidate> = [];
  for (const id of near) {
    if (!hasHandles(world.kindOf(id))) continue;
    const rect = world.rectOf(id);
    if (rect === undefined) continue;
    if (id !== connect.from) {
      for (const zone of verbZones(rect, world.verbsFor(connect.from, id))) {
        if (contains(zone.area, board)) return { nodeId: id, handle: verbHandleId(zone.verb), verb: zone.verb, at: zone.snap };
        candidates.push({ nodeId: id, handle: verbHandleId(zone.verb), role: "target", verb: zone.verb, at: zone.snap });
      }
    }
    for (const side of HANDLE_SIDES) {
      for (const role of ["source", "target"] as const) {
        const handle = handleId(role, side);
        if (id === connect.from && handle === connect.fromHandle.id) continue;
        candidates.push({ nodeId: id, handle, role, at: handlePoint(rect, side, role) });
      }
    }
  }
  const under = world.pick(screen);
  if (under?.nodeId !== undefined && under.part.kind === "handle" && hasHandles(world.kindOf(under.nodeId))) {
    const rect = world.rectOf(under.nodeId);
    const at = rect === undefined ? board : handlePoint(rect, under.part.side, under.part.role);
    return { nodeId: under.nodeId, handle: under.part.id, at };
  }
  let best: Array<Candidate> = [];
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.at.x - board.x, candidate.at.y - board.y);
    if (distance > CONNECT_SNAP_RADIUS) continue;
    if (distance < bestDistance) {
      best = [candidate];
      bestDistance = distance;
    } else if (distance === bestDistance) {
      best.push(candidate);
    }
  }
  // Handles at one distance: the one of the opposite role wins (rf-system:2361-2365).
  const opposite = connect.fromHandle.role === "source" ? "target" : "source";
  const chosen = best.find((candidate) => candidate.role === opposite) ?? best[0];
  if (chosen === undefined) return null;
  return chosen.verb === undefined
    ? { nodeId: chosen.nodeId, handle: chosen.handle, at: chosen.at }
    : { nodeId: chosen.nodeId, handle: chosen.handle, verb: chosen.verb, at: chosen.at };
};

const firstVerb = (world: PointerWorld, source: NodeId, target: NodeId): string | undefined => world.verbsFor(source, target)[0];

const finishConnect = (connect: Connect, at: Point, world: PointerWorld, out: Out): void => {
  if (connect.valid && connect.target !== null) {
    const pair = pairOf(connect, connect.target.nodeId, connect.target.handle);
    const verb = connect.target.verb ?? firstVerb(world, pair.source, pair.target);
    out.intents.push({ kind: "connect", ...pair, ...(verb === undefined ? {} : { verb }) });
    return;
  }
  // A drop on a card body counts (Canvas.tsx:556-583): not the card it began
  // on, not a region. The wire runs from the card it began on, and the writer
  // refuses what the grammar does not allow, in its own words.
  const under = world.pick(at);
  const target = under?.nodeId;
  if (target === undefined || target === connect.from || world.kindOf(target) === "region") return;
  const verb = firstVerb(world, connect.from, target);
  out.intents.push({
    kind: "connect",
    source: connect.from,
    target,
    sourceHandle: connect.fromHandle.id,
    ...(verb === undefined ? {} : { verb }),
  });
};

// --- up -----------------------------------------------------------------------

const up = (gesture: Exclude<Gesture, { kind: "idle" }>, event: PointerInput, world: PointerWorld, out: Out): Gesture => {
  switch (gesture.kind) {
    case "press":
      click(gesture, event, world, out);
      break;
    case "drag":
      finishDrag(gesture, out);
      if (gesture.region !== undefined) {
        // The chrome's click is exclusive (GroupNode.tsx:285-305); a double click names it.
        out.intents.push({ kind: "select", nodeIds: [gesture.region.id], mode: "replace" });
        if (!gesture.region.moved && Math.max(gesture.region.clicks, event.clicks) >= 2) {
          out.intents.push({ kind: "open", nodeId: gesture.region.id, part: gesture.region.part });
        }
      }
      break;
    case "resize":
      finishResize(gesture, out);
      break;
    case "connect":
      finishConnect(gesture, event.at, world, out);
      endConnect(gesture, out);
      break;
    case "marquee":
      endMarquee(gesture, world, out, true);
      break;
    case "pan":
    case "consumed":
      break;
  }
  return { kind: "idle" };
};

const click = (press: Pending, event: PointerInput, world: PointerWorld, out: Out): void => {
  const double = Math.max(press.clicks, event.clicks) >= 2;
  const hit = press.hit;
  if (hit === null || hit.part.kind === "pane") {
    // The code means it (Canvas.tsx:733-742): a click deselects, a double click adds a note.
    out.intents.push(double ? { kind: "addNote", at: press.board } : { kind: "clearSelection" });
    return;
  }
  const part = hit.part;
  if (part.kind === "wire") {
    if (hit.wireId !== undefined) out.intents.push({ kind: "selectWire", wireId: hit.wireId });
    return;
  }
  if (part.kind === "cluster") {
    out.effects.push({ kind: "cluster", memberIds: part.memberIds, at: hit.at });
    return;
  }
  const id = hit.nodeId;
  if (id === undefined) return;
  if (isButton(part)) {
    // A control clicks when it lifts over itself, as the DOM's click does.
    if (!sameTarget(hit, world.pick(event.at))) return;
    switch (part.kind) {
      case "taskEnqueue":
        out.intents.push({ kind: "enqueueTask", nodeId: id });
        return;
      case "bubbleClose":
        out.intents.push({ kind: "closeBubble", nodeId: id });
        return;
      case "image":
        // A click selects; on a selected card, or a double click, the image opens in focus (FileNode.tsx:49-62).
        out.intents.push(double || press.wasSelected ? { kind: "open", nodeId: id, part } : { kind: "select", nodeIds: [id], mode: "replace" });
        return;
      default:
        out.intents.push({ kind: "open", nodeId: id, part });
        return;
    }
  }
  // Card body, a handle without a drag (no click-to-connect), a resize grip without travel.
  out.intents.push({ kind: "select", nodeIds: [id], mode: "replace" });
  if (double) out.intents.push({ kind: "open", nodeId: id, part: { kind: "body" } });
};

/** The drop: one `move`, naming only the cards whose rounded position changed. */
const finishDrag = (drag: Drag, out: Out): void => {
  const positions: Array<{ readonly id: NodeId } & Point> = [];
  for (const origin of drag.origins) {
    const x = Math.round(origin.x + drag.by.x);
    const y = Math.round(origin.y + drag.by.y);
    if (x !== origin.x || y !== origin.y) positions.push({ id: origin.id, x, y });
  }
  if (positions.length > 0) out.intents.push({ kind: "move", positions });
  out.effects.push({ kind: "offset", ids: drag.ids, by: null });
  if (drag.autoPan !== null) out.effects.push({ kind: "autoPan", perFrame: null });
  out.intents.push({ kind: "gesture", gesture: null, nodeIds: [] });
};

/** The release: one `resize` with the final rectangle, nothing when it did not change. */
const finishResize = (resize: Resize, out: Out): void => {
  const rect = {
    x: Math.round(resize.rect.x),
    y: Math.round(resize.rect.y),
    width: Math.round(resize.rect.width),
    height: Math.round(resize.rect.height),
  };
  const start = resize.start;
  if (rect.x !== start.x || rect.y !== start.y || rect.width !== start.width || rect.height !== start.height) {
    out.intents.push({ kind: "resize", id: resize.id, rect });
  }
  out.effects.push({ kind: "resizing", id: resize.id, rect: null });
  out.intents.push({ kind: "gesture", gesture: null, nodeIds: [] });
};

const endConnect = (connect: Connect, out: Out): void => {
  out.effects.push({ kind: "connecting", preview: null });
  if (connect.autoPan !== null) out.effects.push({ kind: "autoPan", perFrame: null });
  out.intents.push({ kind: "gesture", gesture: null, nodeIds: [] });
};

const endMarquee = (marquee: Marquee, world: PointerWorld, out: Out, finished: boolean): void => {
  out.effects.push({ kind: "marquee", rect: null });
  if (marquee.autoPan !== null) out.effects.push({ kind: "autoPan", perFrame: null });
  out.intents.push({ kind: "gesture", gesture: null, nodeIds: [] });
  if (!finished || marquee.picked.length < 2) return;
  const bounds = boundsOf(marquee.picked.flatMap((id) => {
    const rect = world.rectOf(id);
    return rect === undefined ? [] : [rect];
  }));
  if (bounds !== undefined) out.intents.push({ kind: "marqueeMenu", nodeIds: marquee.picked, bounds });
};

// --- cancel and tick -----------------------------------------------------------

/**
 * A lost pointer. A drag, a region drag and a resize keep where they got to,
 * as today's `pointercancel` fallback commits the drag (Canvas.tsx:618-636;
 * GroupNode.tsx:262-283); a connect, a marquee's menu and a pending click are
 * dropped.
 */
const cancel = (gesture: Gesture, world: PointerWorld, out: Out): Gesture => {
  switch (gesture.kind) {
    case "drag":
      finishDrag(gesture, out);
      break;
    case "resize":
      finishResize(gesture, out);
      break;
    case "connect":
      endConnect(gesture, out);
      break;
    case "marquee":
      endMarquee(gesture, world, out, false);
      break;
    default:
      break;
  }
  return { kind: "idle" };
};

/** The camera auto-panned a frame: what the pointer holds follows the board. */
const tick = (gesture: Gesture, world: PointerWorld, out: Out): Gesture => {
  switch (gesture.kind) {
    case "drag":
      return gesture.autoPan === null ? gesture : dragTo(gesture, gesture.screen, world, out);
    case "connect":
      return gesture.autoPan === null ? gesture : connectTo(gesture, gesture.screen, world, out);
    case "marquee":
      return gesture.autoPan === null ? gesture : marqueeTo(gesture, gesture.screen, world, out);
    default:
      return gesture;
  }
};
