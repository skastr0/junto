/**
 * Pad stencils and the selection's paint swatches. A stencil is a ready
 * group of today's shape kinds, inserted as one patch batch so it is one
 * write, one version and one undo frame.
 */
import type {
  PadEdge,
  PadElementId,
  PadPatch,
  PadPoint,
  PadShape,
  PadShapeStatus,
} from "@shared/pad";
import { themeRuntime } from "@shared/theme";
import { newPadElementId, upsertEdgePatch, upsertShapePatch } from "./pad-editor-model";

const SWATCH_HUES = [
  { id: "amber", name: "Amber" },
  { id: "cyan", name: "Cyan" },
  { id: "green", name: "Green" },
  { id: "crimson", name: "Crimson" },
  { id: "steel", name: "Steel" },
] as const;
type SwatchHue = (typeof SWATCH_HUES)[number]["id"];

const hexChannels = (hex: string): number[] =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

const hexOf = (channels: ReadonlyArray<number>): string =>
  `#${channels.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;

/** The hue's token, halfway between the dark and the bright theme. */
const midHue = (hue: SwatchHue): string => {
  const dark = hexChannels(themeRuntime("dark")[hue]!);
  const light = hexChannels(themeRuntime("bright")[hue]!);
  return hexOf(dark.map((n, index) => (n + light[index]!) / 2));
};

/** 18 percent alpha, as the two hex digits paint carries after the color. */
const FILL_ALPHA = "2e";

/**
 * Stored paint is theme-free, so swatches are exact hex taken from the
 * theme tokens that reads on the dark and the bright ground: fills are the
 * dark token at 18 percent alpha, strokes the midpoint of the two themes.
 */
export const PAD_FILL_SWATCHES: ReadonlyArray<{ readonly id: SwatchHue; readonly name: string; readonly value: string }> =
  SWATCH_HUES.map((hue) => ({ ...hue, value: `${themeRuntime("dark")[hue.id]!}${FILL_ALPHA}` }));

export const PAD_STROKE_SWATCHES: ReadonlyArray<{ readonly id: SwatchHue; readonly name: string; readonly value: string }> =
  SWATCH_HUES.map((hue) => ({ ...hue, value: midHue(hue.id) }));

export const PAD_STATUSES: ReadonlyArray<{ readonly value: PadShapeStatus; readonly name: string }> = [
  { value: "none", name: "No status" },
  { value: "active", name: "Active" },
  { value: "done", name: "Done" },
  { value: "blocked", name: "Blocked" },
];

export type PadShapeStyle = {
  readonly fill?: string | undefined;
  readonly stroke?: string | undefined;
  readonly status?: PadShapeStatus | undefined;
  readonly text?: string | undefined;
};

/**
 * The shape with each named field set, or removed when the value is
 * undefined or empty. Optional keys are absent, never undefined, so the
 * strict pad decode accepts the result. "none" status is stored as absent.
 */
export const restyleShape = (shape: PadShape, style: PadShapeStyle): PadShape => {
  const next: Record<string, unknown> = { ...shape };
  for (const key of ["fill", "stroke", "status", "text"] as const) {
    if (!(key in style)) continue;
    const value = key === "text" ? style.text?.trim() : style[key];
    if (value === undefined || value === "" || (key === "status" && value === "none")) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as PadShape;
};

export const PAD_STENCIL_IDS = ["sticky", "process", "decision", "store", "flow"] as const;
export type PadStencilId = (typeof PAD_STENCIL_IDS)[number];

type StencilPart = Omit<PadShape, "id" | "z" | "x" | "y"> & {
  readonly dx: number;
  readonly dy: number;
};

type StencilSpec = {
  readonly id: PadStencilId;
  readonly name: string;
  readonly parts: ReadonlyArray<StencilPart>;
  /** Edges by part index, drawn from the first's right to the second's left. */
  readonly links?: ReadonlyArray<readonly [number, number]>;
};

const fill = (id: SwatchHue): string =>
  PAD_FILL_SWATCHES.find((swatch) => swatch.id === id)!.value;

export const PAD_STENCILS: ReadonlyArray<StencilSpec> = [
  {
    id: "sticky",
    name: "Sticky note",
    parts: [{ type: "box", dx: 0, dy: 0, w: 160, h: 120, fill: fill("amber"), text: "Note" }],
  },
  {
    id: "process",
    name: "Step with status",
    parts: [{ type: "box", dx: 0, dy: 0, w: 160, h: 64, status: "active", text: "Step" }],
  },
  {
    id: "decision",
    name: "Decision",
    parts: [{ type: "diamond", dx: 0, dy: 0, w: 140, h: 96, fill: fill("cyan"), text: "Decide?" }],
  },
  {
    id: "store",
    name: "Store",
    parts: [{ type: "cylinder", dx: 0, dy: 0, w: 120, h: 96, fill: fill("steel"), text: "Store" }],
  },
  {
    id: "flow",
    name: "Two steps joined",
    parts: [
      { type: "box", dx: 0, dy: 0, w: 140, h: 64, text: "First" },
      { type: "box", dx: 220, dy: 0, w: 140, h: 64, text: "Then" },
    ],
    links: [[0, 1]],
  },
];

export const stencilById = (id: PadStencilId): StencilSpec =>
  PAD_STENCILS.find((stencil) => stencil.id === id)!;

const partsBounds = (parts: ReadonlyArray<StencilPart>) => {
  const right = Math.max(...parts.map((part) => part.dx + part.w));
  const bottom = Math.max(...parts.map((part) => part.dy + part.h));
  return { w: right, h: bottom };
};

/**
 * The stencil's patches, centered on `center`, shapes stacked from `z`.
 * Shapes come before edges so every edge's ends exist when it applies.
 */
export const stencilPatches = (
  id: PadStencilId,
  center: PadPoint,
  z: number,
  mint: (prefix: string) => PadElementId = newPadElementId,
): { readonly patches: ReadonlyArray<PadPatch>; readonly ids: ReadonlyArray<PadElementId> } => {
  const stencil = stencilById(id);
  const size = partsBounds(stencil.parts);
  const left = Math.round(center.x - size.w / 2);
  const top = Math.round(center.y - size.h / 2);
  const shapes: PadShape[] = stencil.parts.map(({ dx, dy, ...part }, index) => ({
    ...part,
    id: mint("shape"),
    x: left + dx,
    y: top + dy,
    z: z + index,
  }));
  const edges: PadEdge[] = (stencil.links ?? []).map(([from, to]) => ({
    id: mint("edge"),
    from: shapes[from]!.id,
    to: shapes[to]!.id,
    fromSide: "right",
    toSide: "left",
  }));
  return {
    patches: [...shapes.map(upsertShapePatch), ...edges.map(upsertEdgePatch)],
    ids: [...shapes.map((shape) => shape.id), ...edges.map((edge) => edge.id)],
  };
};

/**
 * Where several dropped or pasted images land: a row centered on the
 * point, each at `size`, with a gap between them.
 */
export const imageRow = (
  count: number,
  center: PadPoint,
  size: { readonly w: number; readonly h: number },
  gap = 16,
): ReadonlyArray<{ readonly x: number; readonly y: number; readonly w: number; readonly h: number }> => {
  const total = count * size.w + Math.max(0, count - 1) * gap;
  const left = Math.round(center.x - total / 2);
  const top = Math.round(center.y - size.h / 2);
  return Array.from({ length: count }, (_, index) => ({
    x: left + index * (size.w + gap),
    y: top,
    w: size.w,
    h: size.h,
  }));
};
