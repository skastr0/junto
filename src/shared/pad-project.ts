/**
 * Vellum Command pad projections. Deterministic, no DOM.
 */
import { Result, Schema } from "effect";
import {
  PadError,
  asPadElementId,
  type Pad,
  type PadElementId,
  type PadImage,
  type PadPin,
  type PadShape,
  type PadShapeStatus,
} from "./pad";
import {
  GeomRect,
  boundsOf,
  contentBounds,
  edgePoints,
  lookHereBounds,
  rectsOverlap,
  strokePath,
  trianglePoints,
  type GeomRect as GeomRectValue,
} from "./pad-geom";
import { themeRuntime, type ThemeMode } from "./theme";

const VIEW_PAD = 80;
const EMPTY_VIEW = { x: 0, y: 0, w: 800, h: 600 } as const;
export const LOOK_HERE_MARGIN = 80;

const SHA_PREFIX = 8;

const padFocusedType = Schema.Literals([
  "box",
  "ellipse",
  "triangle",
  "label",
  "image",
  "edge",
  "ink",
  "pin",
]);
export type PadFocusedType = typeof padFocusedType.Type;

export const PadFocusedItem = Schema.Struct({
  id: Schema.String,
  type: padFocusedType,
  bounds: GeomRect,
  text: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["none", "active", "done", "blocked"])),
});
export type PadFocusedItem = typeof PadFocusedItem.Type;

export const PadLookHere = Schema.Struct({
  bounds: GeomRect,
  digest: Schema.String,
  svg: Schema.String,
});
export type PadLookHere = typeof PadLookHere.Type;

export type PadSvgOptions = {
  readonly hrefs?: Readonly<Record<string, string>>;
  readonly viewBox?: GeomRectValue;
};

const svgPalette = (mode: ThemeMode) => {
  const tokens = themeRuntime(mode);
  return {
    ground: tokens.ground!,
    text: tokens.ink!,
    dim: tokens.dim!,
    stroke: tokens.stroke!,
    fill: tokens["overlay-1"]!,
    amber: tokens.amber!,
    crimson: tokens.crimson!,
    cyan: tokens.cyan!,
    green: tokens.green!,
    steel: tokens.steel!,
  };
};
type SvgPalette = ReturnType<typeof svgPalette>;

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmt = (n: number): string => {
  const rounded = Math.round(n * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const byZ = <T extends { readonly z: number }>(
  items: ReadonlyArray<T>,
): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.z - b.item.z || a.index - b.index)
    .map((entry) => entry.item);

const statusStroke = (status: PadShapeStatus | undefined, pal: SvgPalette): string => {
  switch (status) {
    case "active":
      return pal.cyan;
    case "done":
      return pal.green;
    case "blocked":
      return pal.crimson;
    default:
      return pal.stroke;
  }
};

const shaPrefix = (sha: string): string => sha.slice(0, SHA_PREFIX);

const imageLabel = (image: PadImage): string =>
  `${image.ref.displayName ?? "image"} ${shaPrefix(image.ref.sha256)}`;

const clipText = (text: string): string =>
  text.length > 160 ? `${text.slice(0, 159)}…` : text;

const firstTextPart = (pin: PadPin): string | undefined => {
  for (const post of pin.posts) {
    for (const part of post.parts) {
      if (part.kind === "text" && part.text.length > 0) return part.text;
    }
  }
  return undefined;
};

const viewRect = (pad: Pad, override?: GeomRectValue): GeomRectValue => {
  if (override) return override;
  const content = contentBounds(pad);
  if (content.w <= 0 || content.h <= 0) return EMPTY_VIEW;
  return {
    x: content.x - VIEW_PAD,
    y: content.y - VIEW_PAD,
    w: content.w + VIEW_PAD * 2,
    h: content.h + VIEW_PAD * 2,
  };
};

const emitShape = (shape: PadShape, pal: SvgPalette): string[] => {
  const fill = shape.fill ?? pal.fill;
  const stroke = shape.stroke ?? statusStroke(shape.status, pal);
  const parts: string[] = [];
  if (shape.type === "ellipse") {
    parts.push(
      `<ellipse cx="${fmt(shape.x + shape.w / 2)}" cy="${fmt(shape.y + shape.h / 2)}" rx="${fmt(shape.w / 2)}" ry="${fmt(shape.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
  } else if (shape.type === "triangle") {
    const [a, b, c] = trianglePoints(shape);
    parts.push(
      `<polygon points="${fmt(a.x)},${fmt(a.y)} ${fmt(b.x)},${fmt(b.y)} ${fmt(c.x)},${fmt(c.y)}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
  } else {
    parts.push(
      `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }
  if (shape.text) {
    parts.push(
      `<text x="${fmt(shape.x + 8)}" y="${fmt(shape.y + 16)}" fill="${pal.text}" font-size="12">${esc(clipText(shape.text))}</text>`,
    );
  }
  return parts;
};

export const padToSvg = (
  pad: Pad,
  theme: ThemeMode = "dark",
  options?: PadSvgOptions,
): string => {
  const pal = svgPalette(theme);
  const box = viewRect(pad, options?.viewBox);
  const hrefs = options?.hrefs;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}" width="${fmt(box.w)}" height="${fmt(box.h)}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
    `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" fill="${pal.ground}"/>`,
  ];

  for (const image of byZ(pad.images)) {
    const href = hrefs?.[image.id];
    if (href) {
      parts.push(
        `<image href="${esc(href)}" x="${fmt(image.x)}" y="${fmt(image.y)}" width="${fmt(image.w)}" height="${fmt(image.h)}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else {
      parts.push(
        `<rect x="${fmt(image.x)}" y="${fmt(image.y)}" width="${fmt(image.w)}" height="${fmt(image.h)}" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1"/>`,
        `<text x="${fmt(image.x + 8)}" y="${fmt(image.y + 16)}" fill="${pal.dim}" font-size="10">${esc(clipText(imageLabel(image)))}</text>`,
      );
    }
  }

  for (const edge of pad.edges) {
    const points = edgePoints(pad, edge);
    if (!points) continue;
    parts.push(
      `<path d="${strokePath(points, 1.5)}" fill="none" stroke="${pal.steel}" stroke-width="1.5"/>`,
    );
    if (edge.label) {
      const mid = points[Math.floor(points.length / 2)] ?? points[0]!;
      parts.push(
        `<text x="${fmt(mid.x)}" y="${fmt(mid.y)}" fill="${pal.dim}" font-size="10" text-anchor="middle">${esc(edge.label)}</text>`,
      );
    }
  }

  for (const shape of byZ(pad.shapes)) {
    parts.push(...emitShape(shape, pal));
  }

  for (const ink of byZ(pad.inks)) {
    parts.push(
      `<path d="${strokePath(ink.points, ink.width)}" fill="none" stroke="${esc(ink.color)}" stroke-width="${fmt(ink.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  for (const pin of pad.pins) {
    if (pin.bounds) {
      const crop = lookHereBounds(pin, LOOK_HERE_MARGIN);
      parts.push(
        `<rect x="${fmt(crop.x)}" y="${fmt(crop.y)}" width="${fmt(crop.w)}" height="${fmt(crop.h)}" fill="none" stroke="${pal.dim}" stroke-dasharray="4 3" opacity="0.6"/>`,
      );
    }
    parts.push(
      `<circle cx="${fmt(pin.x)}" cy="${fmt(pin.y)}" r="5" fill="${pal.amber}"/>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
};

const xy = (x: number, y: number): string => `${fmt(x)},${fmt(y)}`;
const wh = (w: number, h: number): string => `${fmt(w)}x${fmt(h)}`;

const field = (key: string, value: string | undefined): string =>
  value === undefined ? "" : ` ${key}=${value}`;

export const padToDigest = (pad: Pad): string => {
  const lines: string[] = [
    `pad :: revision=${pad.revision}`,
    `images :: ${pad.images.length}`,
  ];
  for (const image of pad.images) {
    const name = image.ref.displayName;
    lines.push(
      `  ${image.id} :: ${xy(image.x, image.y)} ${wh(image.w, image.h)} sha=${shaPrefix(image.ref.sha256)}${field("name", name ? JSON.stringify(name) : undefined)} ${image.ref.mediaType}`,
    );
  }
  lines.push(`shapes :: ${pad.shapes.length}`);
  for (const shape of pad.shapes) {
    lines.push(
      `  ${shape.id} :: ${shape.type} ${xy(shape.x, shape.y)} ${wh(shape.w, shape.h)}${field("text", shape.text === undefined ? undefined : JSON.stringify(shape.text))}${field("status", shape.status)}`,
    );
  }
  lines.push(`edges :: ${pad.edges.length}`);
  for (const edge of pad.edges) {
    const from = edge.fromSide ? `${edge.from}/${edge.fromSide}` : edge.from;
    const to = edge.toSide ? `${edge.to}/${edge.toSide}` : edge.to;
    lines.push(
      `  ${edge.id} :: ${from} -> ${to}${field("label", edge.label === undefined ? undefined : JSON.stringify(edge.label))}`,
    );
  }
  lines.push(`inks :: ${pad.inks.length}`);
  for (const ink of pad.inks) {
    lines.push(
      `  ${ink.id} :: width=${fmt(ink.width)} color=${ink.color} points=${ink.points.length}`,
    );
  }
  lines.push(`pins :: ${pad.pins.length}`);
  for (const pin of pad.pins) {
    const mentions = pin.mentions.join(",");
    const crop = pin.bounds ? ` bounds=${wh(pin.bounds.w, pin.bounds.h)}` : "";
    lines.push(
      `  ${pin.id} :: ${xy(pin.x, pin.y)}${crop} mentions=${mentions} posts=${pin.posts.length}`,
    );
  }
  return lines.join("\n");
};

const focused = (
  id: PadElementId | string,
  type: PadFocusedType,
  bounds: GeomRectValue,
  text?: string,
  status?: PadShapeStatus,
): PadFocusedItem => ({
  id,
  type,
  bounds,
  ...(text !== undefined ? { text } : {}),
  ...(status !== undefined ? { status } : {}),
});

export const padToFocused = (pad: Pad): PadFocusedItem[] => {
  const items: PadFocusedItem[] = [];
  for (const image of pad.images) {
    items.push(focused(image.id, "image", boundsOf(image), imageLabel(image)));
  }
  for (const shape of pad.shapes) {
    items.push(focused(shape.id, shape.type, boundsOf(shape), shape.text, shape.status));
  }
  for (const edge of pad.edges) {
    const bounds = boundsOf(pad, edge.id);
    if (!bounds) continue;
    items.push(focused(edge.id, "edge", bounds, edge.label));
  }
  for (const ink of pad.inks) {
    items.push(focused(ink.id, "ink", boundsOf(ink)));
  }
  for (const pin of pad.pins) {
    items.push(focused(pin.id, "pin", boundsOf(pin), firstTextPart(pin)));
  }
  return items;
};

const cropPad = (pad: Pad, crop: GeomRectValue): Pad => {
  const keep = (rect: GeomRectValue): boolean => rectsOverlap(rect, crop);
  const images = pad.images.filter((image) => keep(boundsOf(image)));
  const shapes = pad.shapes.filter((shape) => keep(boundsOf(shape)));
  const inks = pad.inks.filter((ink) => keep(boundsOf(ink)));
  const pins = pad.pins.filter((pin) => keep(boundsOf(pin)));
  const edges = pad.edges.filter((edge) => {
    const bounds = boundsOf(pad, edge.id);
    return bounds !== undefined && keep(bounds);
  });
  return { revision: pad.revision, images, shapes, edges, inks, pins };
};

export const padLookHere = (
  pad: Pad,
  pinId: string,
  theme: ThemeMode = "dark",
): Result.Result<PadLookHere, PadError> => {
  const pin = pad.pins.find((candidate) => candidate.id === pinId);
  if (!pin) {
    return Result.fail(
      PadError.make({
        code: "missing",
        message: "pin does not exist",
        id: asPadElementId(pinId),
      }),
    );
  }
  const bounds = lookHereBounds(pin, LOOK_HERE_MARGIN);
  const cropped = cropPad(pad, bounds);
  const digest = [`look-here :: ${pin.id}`, `bounds :: ${xy(bounds.x, bounds.y)} ${wh(bounds.w, bounds.h)}`, padToDigest(cropped)].join("\n");
  return Result.succeed({
    bounds,
    digest,
    svg: padToSvg(pad, theme, { viewBox: bounds }),
  });
};
