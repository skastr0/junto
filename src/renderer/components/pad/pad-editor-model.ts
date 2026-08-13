/**
 * Pure pad editor view-model. Pad mutation stays applyPatch; this file
 * only proposes PadPatch values and camera/hit helpers.
 */
import { Result } from "effect";
import {
  asPadElementId,
  asPadPostId,
  applyPatches,
  type Pad,
  type PadEdge,
  type PadElementId,
  type PadError,
  type PadImage,
  type PadInk,
  type PadPatch,
  type PadPin,
  type PadPoint,
  type PadPostId,
  type PadShape,
  type PadShapeType,
  type PadSide,
} from "@shared/pad";

import {
  identityCamera,
  viewToScene,
  type Camera,
  type GeomRect,
} from "@shared/pad-geom";
import { themeRuntime, type ThemeMode } from "@shared/theme";

export const PAD_SHAPE_TOOLS = ["box", "ellipse", "triangle", "label"] as const;
export type PadShapeTool = (typeof PAD_SHAPE_TOOLS)[number];

export const PAD_TOOLS = ["select", ...PAD_SHAPE_TOOLS, "pin", "image", "ink"] as const;
export type PadTool = (typeof PAD_TOOLS)[number];

export const PAD_TOOL_KEYS: Readonly<Record<string, PadTool>> = {
  v: "select",
  r: "box",
  o: "ellipse",
  t: "triangle",
  l: "label",
  p: "pin",
  i: "image",
  d: "ink",
};

export const isShapeTool = (tool: PadTool): tool is PadShapeTool =>
  (PAD_SHAPE_TOOLS as readonly string[]).includes(tool);

export const DEFAULT_IMAGE_SIZE = { w: 160, h: 120 } as const;
export const DEFAULT_INK_WIDTH = 2;

export const defaultInkColor = (mode: ThemeMode = "dark"): string =>
  themeRuntime(mode).ink ?? "#d8d2c4";

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

export const MIN_SHAPE_SIZE = 8;
export const CAMERA_ZOOM_MIN = 0.15;
export const CAMERA_ZOOM_MAX = 8;
export const HANDLE_VIEW_PX = 7;
export const SIDE_VIEW_PX = 8;
export const HIT_VIEW_PX = 6;

export type EditorKeyAction =
  | { readonly type: "tool"; readonly tool: PadTool }
  | { readonly type: "delete" }
  | { readonly type: "undo" }
  | { readonly type: "z"; readonly delta: 1 | -1 }
  | { readonly type: "nudge"; readonly dx: number; readonly dy: number }
  | { readonly type: "cycle"; readonly dir: 1 | -1 }
  | { readonly type: "edit-label" }
  | { readonly type: "cancel" };

const snap = (n: number): number => Math.round(n);

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

export const toolFromKey = (key: string): PadTool | undefined =>
  PAD_TOOL_KEYS[key.toLowerCase()];

export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  Boolean(target.closest("input, textarea, [contenteditable='true']"));

export const editorKeyAction = (
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">,
  options: { readonly typing: boolean },
): EditorKeyAction | undefined => {
  if (options.typing) {
    return event.key === "Escape" ? { type: "cancel" } : undefined;
  }
  if (event.altKey) return undefined;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
    return { type: "undo" };
  }
  if (event.metaKey || event.ctrlKey) return undefined;
  const tool = toolFromKey(event.key);
  if (tool) return { type: "tool", tool };
  if (event.key === "Delete" || event.key === "Backspace") return { type: "delete" };
  if (event.key === "[") return { type: "z", delta: -1 };
  if (event.key === "]") return { type: "z", delta: 1 };
  if (event.key === "Escape") return { type: "cancel" };
  if (event.key === "Enter") return { type: "edit-label" };
  if (event.key === "Tab") return { type: "cycle", dir: event.shiftKey ? -1 : 1 };
  const step = event.shiftKey ? 10 : 1;
  if (event.key === "ArrowLeft") return { type: "nudge", dx: -step, dy: 0 };
  if (event.key === "ArrowRight") return { type: "nudge", dx: step, dy: 0 };
  if (event.key === "ArrowUp") return { type: "nudge", dx: 0, dy: -step };
  if (event.key === "ArrowDown") return { type: "nudge", dx: 0, dy: step };
  return undefined;
};

export const clientToView = (
  client: PadPoint,
  origin: PadPoint,
): PadPoint => ({
  x: client.x - origin.x,
  y: client.y - origin.y,
});

export const clientToScene = (
  camera: Camera,
  client: PadPoint,
  origin: PadPoint,
): PadPoint => viewToScene(camera, clientToView(client, origin));

export const viewSlop = (camera: Camera, viewPx: number): number =>
  viewPx / Math.max(camera.zoom, 0.0001);

export const zoomAt = (camera: Camera, viewPt: PadPoint, factor: number): Camera => {
  const scene = viewToScene(camera, viewPt);
  const zoom = clamp(camera.zoom * factor, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX);
  return {
    x: scene.x - viewPt.x / zoom,
    y: scene.y - viewPt.y / zoom,
    zoom,
  };
};

export const panBy = (camera: Camera, viewDx: number, viewDy: number): Camera => ({
  ...camera,
  x: camera.x - viewDx / camera.zoom,
  y: camera.y - viewDy / camera.zoom,
});

export const fitCamera = (
  content: GeomRect,
  viewport: { readonly w: number; readonly h: number },
  padding = 48,
): Camera => {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return identityCamera;
  }
  const availW = Math.max(1, viewport.w - padding * 2);
  const availH = Math.max(1, viewport.h - padding * 2);
  const zoom = clamp(Math.min(availW / content.w, availH / content.h), CAMERA_ZOOM_MIN, 2);
  const viewW = viewport.w / zoom;
  const viewH = viewport.h / zoom;
  return {
    x: content.x - (viewW - content.w) / 2,
    y: content.y - (viewH - content.h) / 2,
    zoom,
  };
};

export const normalizeRect = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minSize = MIN_SHAPE_SIZE,
): GeomRect => {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const w = Math.max(minSize, Math.abs(x1 - x0));
  const h = Math.max(minSize, Math.abs(y1 - y0));
  return { x: snap(left), y: snap(top), w: snap(w), h: snap(h) };
};

export const draftShapeFromDrag = (
  type: PadShapeTool,
  start: PadPoint,
  current: PadPoint,
  id: PadElementId,
  z: number,
): PadShape => {
  const box = normalizeRect(start.x, start.y, current.x, current.y);
  const shapeType: PadShapeType = type === "label" ? "label" : type;
  return {
    id,
    type: shapeType,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    z,
    ...(type === "label" ? { text: "Label" } : {}),
  };
};

export const nextLayerZ = (items: ReadonlyArray<{ readonly z: number }>): number => {
  let max = -1;
  for (const item of items) max = Math.max(max, item.z);
  return max + 1;
};

export const moveShape = (shape: PadShape, dx: number, dy: number): PadShape => ({
  ...shape,
  x: snap(shape.x + dx),
  y: snap(shape.y + dy),
});

export const moveImage = (image: PadImage, dx: number, dy: number): PadImage => ({
  ...image,
  x: snap(image.x + dx),
  y: snap(image.y + dy),
});

export const resizeAabb = (
  item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  handle: ResizeHandle,
  point: PadPoint,
): GeomRect => {
  const right = item.x + item.w;
  const bottom = item.y + item.h;
  switch (handle) {
    case "nw":
      return normalizeRect(point.x, point.y, right, bottom);
    case "ne":
      return normalizeRect(item.x, point.y, point.x, bottom);
    case "sw":
      return normalizeRect(point.x, item.y, right, point.y);
    case "se":
      return normalizeRect(item.x, item.y, point.x, point.y);
  }
};

export const resizeShape = (
  shape: PadShape,
  handle: ResizeHandle,
  point: PadPoint,
): PadShape => {
  const box = resizeAabb(shape, handle, point);
  return { ...shape, x: box.x, y: box.y, w: box.w, h: box.h };
};

export const resizeImage = (
  image: PadImage,
  handle: ResizeHandle,
  point: PadPoint,
): PadImage => {
  const box = resizeAabb(image, handle, point);
  return { ...image, x: box.x, y: box.y, w: box.w, h: box.h };
};

const handleCenters = (
  item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): Record<ResizeHandle, PadPoint> => ({
  nw: { x: item.x, y: item.y },
  ne: { x: item.x + item.w, y: item.y },
  sw: { x: item.x, y: item.y + item.h },
  se: { x: item.x + item.w, y: item.y + item.h },
});

export const handleHit = (
  item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  point: PadPoint,
  slop: number,
): ResizeHandle | undefined => {
  const centers = handleCenters(item);
  let best: ResizeHandle | undefined;
  let bestDist = slop;
  for (const handle of ["nw", "ne", "sw", "se"] as const) {
    const c = centers[handle];
    const d = Math.hypot(point.x - c.x, point.y - c.y);
    if (d <= bestDist) {
      best = handle;
      bestDist = d;
    }
  }
  return best;
};

export const nearestSide = (shape: PadShape, point: PadPoint): PadSide => {
  const midX = shape.x + shape.w / 2;
  const midY = shape.y + shape.h / 2;
  const distances: Record<PadSide, number> = {
    top: Math.abs(point.y - shape.y),
    bottom: Math.abs(point.y - (shape.y + shape.h)),
    left: Math.abs(point.x - shape.x),
    right: Math.abs(point.x - (shape.x + shape.w)),
  };
  const inward: Record<PadSide, number> = {
    top: Math.abs(point.x - midX),
    bottom: Math.abs(point.x - midX),
    left: Math.abs(point.y - midY),
    right: Math.abs(point.y - midY),
  };
  let best: PadSide = "top";
  let score = Infinity;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const s = distances[side] + inward[side] * 0.01;
    if (s < score) {
      score = s;
      best = side;
    }
  }
  return best;
};

export const sideHit = (
  shape: PadShape,
  point: PadPoint,
  slop: number,
): PadSide | undefined => {
  const side = nearestSide(shape, point);
  const onTop = Math.abs(point.y - shape.y) <= slop;
  const onBottom = Math.abs(point.y - (shape.y + shape.h)) <= slop;
  const onLeft = Math.abs(point.x - shape.x) <= slop;
  const onRight = Math.abs(point.x - (shape.x + shape.w)) <= slop;
  const inX = point.x >= shape.x - slop && point.x <= shape.x + shape.w + slop;
  const inY = point.y >= shape.y - slop && point.y <= shape.y + shape.h + slop;
  if (side === "top" && onTop && inX) return "top";
  if (side === "bottom" && onBottom && inX) return "bottom";
  if (side === "left" && onLeft && inY) return "left";
  if (side === "right" && onRight && inY) return "right";
  return undefined;
};

export const upsertShapePatch = (shape: PadShape): PadPatch => ({
  op: "upsert",
  layer: "shape",
  shape,
});

export const upsertEdgePatch = (edge: PadEdge): PadPatch => ({
  op: "upsert",
  layer: "edge",
  edge,
});

export const upsertImagePatch = (image: PadImage): PadPatch => ({
  op: "upsert",
  layer: "image",
  image,
});

export const upsertInkPatch = (ink: PadInk): PadPatch => ({
  op: "upsert",
  layer: "ink",
  ink,
});

export const upsertPinPatch = (pin: Omit<PadPin, "posts">): PadPatch => ({
  op: "pin.upsert",
  pin,
});

export const pinReplyPatch = (
  pinId: PadElementId,
  text: string,
  postId: PadPostId,
): PadPatch => ({
  op: "pin.reply",
  pinId,
  post: {
    postId,
    author: { kind: "operator", label: "operator" },
    parts: [{ kind: "text", text }],
  },
});

export const newPadPostId = (mint: () => string = () => crypto.randomUUID()): PadPostId =>
  asPadPostId(`post-${mint()}`);

export const toggleMention = (
  mentions: ReadonlyArray<string>,
  nodeId: string,
): string[] =>
  mentions.includes(nodeId)
    ? mentions.filter((id) => id !== nodeId)
    : [...mentions, nodeId];

export type MentionQuery = {
  readonly start: number;
  readonly query: string;
};

export const mentionQueryAt = (
  text: string,
  cursor: number,
): MentionQuery | undefined => {
  const before = text.slice(0, Math.max(0, cursor));
  const match = /@([^\s@]*)$/.exec(before);
  if (!match || match.index === undefined) return undefined;
  return { start: match.index, query: match[1] ?? "" };
};

export const filterMentionActors = <
  T extends { readonly nodeId: string; readonly label: string; readonly agentKey?: string },
>(
  actors: ReadonlyArray<T>,
  query: string,
): T[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...actors];
  return actors.filter(
    (actor) =>
      actor.nodeId.toLowerCase().includes(needle) ||
      actor.label.toLowerCase().includes(needle) ||
      (actor.agentKey?.toLowerCase().includes(needle) ?? false),
  );
};

export const applyMentionPick = (
  text: string,
  cursor: number,
  label: string,
): { readonly text: string; readonly cursor: number } | undefined => {
  const mention = mentionQueryAt(text, cursor);
  if (!mention) return undefined;
  const inserted = `@${label.replace(/\s+/g, "-")}`;
  const next = `${text.slice(0, mention.start)}${inserted} ${text.slice(cursor)}`;
  const nextCursor = mention.start + inserted.length + 1;
  return { text: next, cursor: nextCursor };
};

export const padIsEmpty = (pad: Pad): boolean =>
  pad.shapes.length === 0 &&
  pad.edges.length === 0 &&
  pad.images.length === 0 &&
  pad.inks.length === 0 &&
  pad.pins.length === 0;

export const draftImageRect = (start: PadPoint, current: PadPoint): GeomRect => {
  const dx = Math.abs(current.x - start.x);
  const dy = Math.abs(current.y - start.y);
  if (dx < MIN_SHAPE_SIZE && dy < MIN_SHAPE_SIZE) {
    return { x: snap(start.x), y: snap(start.y), w: DEFAULT_IMAGE_SIZE.w, h: DEFAULT_IMAGE_SIZE.h };
  }
  return normalizeRect(start.x, start.y, current.x, current.y);
};

export const draftPinFromDrag = (
  id: PadElementId,
  start: PadPoint,
  current: PadPoint,
): Omit<PadPin, "posts"> => {
  const w = Math.abs(current.x - start.x);
  const h = Math.abs(current.y - start.y);
  if (w < MIN_SHAPE_SIZE || h < MIN_SHAPE_SIZE) {
    return { id, x: snap(start.x), y: snap(start.y), mentions: [] };
  }
  return {
    id,
    x: snap((start.x + current.x) / 2),
    y: snap((start.y + current.y) / 2),
    bounds: { w: snap(Math.max(MIN_SHAPE_SIZE, w)), h: snap(Math.max(MIN_SHAPE_SIZE, h)) },
    mentions: [],
  };
};

export const appendInkPoint = (
  points: ReadonlyArray<PadPoint>,
  next: PadPoint,
  minDist = 1,
): PadPoint[] => {
  const last = points[points.length - 1];
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < minDist) {
    return [...points];
  }
  return [...points, { x: snap(next.x), y: snap(next.y) }];
};

export const draftInkFromPoints = (
  id: PadElementId,
  points: readonly [PadPoint, PadPoint, ...PadPoint[]],
  z: number,
  color: string,
  width = DEFAULT_INK_WIDTH,
): PadInk => ({
  id,
  z,
  color,
  width,
  points: [...points],
});

export const movePin = (pin: PadPin, dx: number, dy: number): Omit<PadPin, "posts"> => ({
  id: pin.id,
  x: snap(pin.x + dx),
  y: snap(pin.y + dy),
  mentions: pin.mentions,
  ...(pin.bounds ? { bounds: pin.bounds } : {}),
});

export const deletePatch = (id: PadElementId): PadPatch => ({
  op: "delete",
  id,
});

export const zPatch = (id: PadElementId, z: number): PadPatch => ({
  op: "z",
  id,
  z,
});

export const newPadElementId = (prefix: string, mint: () => string = () => crypto.randomUUID()): PadElementId =>
  asPadElementId(`${prefix}-${mint()}`);

type ElementSnap =
  | { readonly layer: "shape"; readonly shape: PadShape }
  | { readonly layer: "edge"; readonly edge: PadEdge }
  | { readonly layer: "image"; readonly image: PadImage }
  | { readonly layer: "ink"; readonly ink: PadInk }
  | { readonly layer: "pin"; readonly pin: PadPin };

const snapOf = (pad: Pad, id: string): ElementSnap | undefined => {
  const shape = pad.shapes.find((item) => item.id === id);
  if (shape) return { layer: "shape", shape };
  const edge = pad.edges.find((item) => item.id === id);
  if (edge) return { layer: "edge", edge };
  const image = pad.images.find((item) => item.id === id);
  if (image) return { layer: "image", image };
  const ink = pad.inks.find((item) => item.id === id);
  if (ink) return { layer: "ink", ink };
  const pin = pad.pins.find((item) => item.id === id);
  if (pin) return { layer: "pin", pin };
  return undefined;
};

const upsertFromSnap = (snap: ElementSnap): PadPatch => {
  switch (snap.layer) {
    case "shape":
      return { op: "upsert", layer: "shape", shape: snap.shape };
    case "edge":
      return { op: "upsert", layer: "edge", edge: snap.edge };
    case "image":
      return { op: "upsert", layer: "image", image: snap.image };
    case "ink":
      return { op: "upsert", layer: "ink", ink: snap.ink };
    case "pin": {
      const { posts: _posts, ...pin } = snap.pin;
      return { op: "pin.upsert", pin };
    }
  }
};

const sameSnap = (a: ElementSnap | undefined, b: ElementSnap | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const layerRank = (snap: ElementSnap): number => {
  switch (snap.layer) {
    case "image":
      return 0;
    case "shape":
      return 1;
    case "ink":
      return 2;
    case "pin":
      return 3;
    case "edge":
      return 4;
  }
};

/** Inverse patches that restore `before` after `patches` have been applied. */
export const inversePatches = (
  before: Pad,
  patches: ReadonlyArray<PadPatch>,
): Result.Result<PadPatch[], PadError> => {
  const after = applyPatches(before, patches);
  if (Result.isFailure(after)) return Result.fail(after.failure);
  const ids = new Set<string>();
  for (const patch of patches) {
    if (patch.op === "upsert") {
      if (patch.layer === "shape") ids.add(patch.shape.id);
      else if (patch.layer === "edge") ids.add(patch.edge.id);
      else if (patch.layer === "image") ids.add(patch.image.id);
      else ids.add(patch.ink.id);
    } else if (patch.op === "pin.upsert") ids.add(patch.pin.id);
    else if (patch.op === "pin.reply") ids.add(patch.pinId);
    else ids.add(patch.id);
  }
  for (const edge of before.edges) {
    if (!after.success.edges.some((item) => item.id === edge.id)) ids.add(edge.id);
  }
  const creates: PadPatch[] = [];
  const updates: PadPatch[] = [];
  const deletes: PadPatch[] = [];
  for (const id of ids) {
    const was = snapOf(before, id);
    const now = snapOf(after.success, id);
    if (sameSnap(was, now)) continue;
    if (!was && now) deletes.push({ op: "delete", id: asPadElementId(id) });
    else if (was && !now) creates.push(upsertFromSnap(was));
    else if (was) updates.push(upsertFromSnap(was));
  }
  creates.sort((a, b) => {
    const as = a.op === "upsert" || a.op === "pin.upsert"
      ? snapOf(before, a.op === "upsert"
        ? a.layer === "shape"
          ? a.shape.id
          : a.layer === "edge"
            ? a.edge.id
            : a.layer === "image"
              ? a.image.id
              : a.ink.id
        : a.pin.id)
      : undefined;
    const bs = b.op === "upsert" || b.op === "pin.upsert"
      ? snapOf(before, b.op === "upsert"
        ? b.layer === "shape"
          ? b.shape.id
          : b.layer === "edge"
            ? b.edge.id
            : b.layer === "image"
              ? b.image.id
              : b.ink.id
        : b.pin.id)
      : undefined;
    return (as ? layerRank(as) : 9) - (bs ? layerRank(bs) : 9);
  });
  return Result.succeed([...creates, ...updates, ...deletes]);
};

export const editableLayer = (
  pad: Pad,
  id: string,
): "shape" | "edge" | "image" | "ink" | "pin" | undefined =>
  snapOf(pad, id)?.layer;

export const canMove = (layer: ReturnType<typeof editableLayer>): boolean =>
  layer === "shape" || layer === "image" || layer === "pin";

export const canResize = (layer: ReturnType<typeof editableLayer>): boolean =>
  layer === "shape" || layer === "image";

export const canZ = (layer: ReturnType<typeof editableLayer>): boolean =>
  layer === "shape" || layer === "image" || layer === "ink";

export const canDelete = (layer: ReturnType<typeof editableLayer>): boolean =>
  layer === "shape" || layer === "edge" || layer === "image" || layer === "ink" || layer === "pin";

export const cycleSelection = (
  pad: Pad,
  selectedId: string | undefined,
  dir: 1 | -1,
): string | undefined => {
  const ids = [
    ...[...pad.shapes]
      .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
      .map((item) => item.id),
    ...[...pad.images]
      .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
      .map((item) => item.id),
    ...[...pad.inks]
      .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
      .map((item) => item.id),
    ...pad.edges.map((item) => item.id),
    ...pad.pins.map((item) => item.id),
  ];
  if (ids.length === 0) return undefined;
  if (!selectedId) return dir === 1 ? ids[0] : ids[ids.length - 1];
  const index = ids.findIndex((id) => id === selectedId);
  if (index < 0) return ids[0];
  return ids[(index + dir + ids.length) % ids.length];
};

export const zOf = (pad: Pad, id: string): number | undefined => {
  const snap = snapOf(pad, id);
  if (!snap) return undefined;
  if (snap.layer === "shape") return snap.shape.z;
  if (snap.layer === "image") return snap.image.z;
  if (snap.layer === "ink") return snap.ink.z;
  return undefined;
};

export const shapeById = (pad: Pad, id: string): PadShape | undefined =>
  pad.shapes.find((shape) => shape.id === id);

export const imageById = (pad: Pad, id: string): PadImage | undefined =>
  pad.images.find((image) => image.id === id);

export const inkById = (pad: Pad, id: string): PadInk | undefined =>
  pad.inks.find((ink) => ink.id === id);

export const pinById = (pad: Pad, id: string): PadPin | undefined =>
  pad.pins.find((pin) => pin.id === id);
