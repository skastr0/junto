/**
 * Junto pad projections. Deterministic, no DOM.
 */
import { Schema } from "effect";
import {
  type Pad,
  type PadElementId,
  type PadImage,
  type PadShape,
  type PadShapeStatus,
} from "./pad";
import {
  GeomRect,
  boundsOf,
  contentBounds,
  cylinderPaths,
  diamondPoints,
  edgePoints,
  strokePath,
  trianglePoints,
  type GeomRect as GeomRectValue,
} from "./pad-geom";
import { themeRuntime, type ThemeMode } from "./theme";

const VIEW_PAD = 80;
const EMPTY_VIEW = { x: 0, y: 0, w: 800, h: 600 } as const;

const SHA_PREFIX = 8;

const padFocusedType = Schema.Literals([
  "box",
  "ellipse",
  "triangle",
  "label",
  "diamond",
  "cylinder",
  "card",
  "image",
  "edge",
  "ink",
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

export type PadSvgOptions = {
  readonly hrefs?: Readonly<Record<string, string>>;
  readonly viewBox?: GeomRectValue;
  /** Omit explicit pixel size so CSS can frame the SVG (factory card thumb). */
  readonly framed?: boolean;
  readonly padding?: number;
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
export type PadSvgPalette = ReturnType<typeof svgPalette>;
export const padSvgPalette = svgPalette;

/**
 * Render-only paint. Persisted fill/stroke/ink color remain arbitrary
 * strings in Pad IR; this schema never decodes storage or PadPatch.
 * Exact `none` or #RGB / #RGBA / #RRGGBB / #RRGGBBAA. No named colors,
 * functions, variables, urls, whitespace, or suffixes.
 */
export const PadPaintLiteral = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) =>
        value === "none" ||
        /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(
          value,
        ),
      { message: "must be none or an exact hex color" },
    ),
  ),
);
export type PadPaintLiteral = typeof PadPaintLiteral.Type;
export const isPadPaintLiteral = Schema.is(PadPaintLiteral);

/** `trustedFallback` must be an application-owned color, never another Pad field. */
export const resolvePadPaint = (
  value: string | undefined,
  trustedFallback: string,
): string =>
  value !== undefined && isPadPaintLiteral(value) ? value : trustedFallback;

export const padSvgViewRect = (
  pad: Pad,
  override?: GeomRectValue,
  padding = VIEW_PAD,
): GeomRectValue => {
  if (override) return override;
  const content = contentBounds(pad);
  if (content.w <= 0 || content.h <= 0) return EMPTY_VIEW;
  return {
    x: content.x - padding,
    y: content.y - padding,
    w: content.w + padding * 2,
    h: content.h + padding * 2,
  };
};

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

export const padStatusStroke = (
  status: PadShapeStatus | undefined,
  pal: PadSvgPalette,
): string => {
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

export const padShapeFill = (
  shape: PadShape,
  pal: PadSvgPalette,
): string => resolvePadPaint(shape.fill, pal.fill);

export const padShapeStroke = (
  shape: PadShape,
  pal: PadSvgPalette,
): string => resolvePadPaint(shape.stroke, padStatusStroke(shape.status, pal));

export const padInkStroke = (
  color: string,
  pal: PadSvgPalette,
): string => resolvePadPaint(color, pal.text);

/** The words a shape shows: its text, or for a card the name its writer saw, else its link. */
export const padShapeText = (shape: PadShape): string | undefined =>
  shape.type === "card" ? shape.label ?? shape.href : shape.text;

export const padImageLabel = (image: PadImage): string =>
  `${image.ref.displayName ?? "image"} ${image.ref.sha256.slice(0, SHA_PREFIX)}`;

export const padClipText = (text: string): string =>
  text.length > 160 ? `${text.slice(0, 159)}…` : text;

export const padElementsByZ = <T extends { readonly z: number }>(
  items: ReadonlyArray<T>,
): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.z - b.item.z || a.index - b.index)
    .map((entry) => entry.item);

const emitShape = (shape: PadShape, pal: PadSvgPalette): string[] => {
  const fill = esc(padShapeFill(shape, pal));
  const stroke = esc(padShapeStroke(shape, pal));
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
  } else if (shape.type === "diamond") {
    const points = diamondPoints(shape).map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
    parts.push(`<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
  } else if (shape.type === "cylinder") {
    const { outline, rim } = cylinderPaths(shape);
    parts.push(
      `<path d="${esc(outline)}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
      `<path d="${esc(rim)}" fill="none" stroke="${stroke}" stroke-width="1"/>`,
    );
  } else {
    parts.push(
      `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }
  const text = padShapeText(shape);
  if (text) {
    parts.push(
      `<text x="${fmt(shape.x + 8)}" y="${fmt(shape.y + 16)}" fill="${esc(pal.text)}" font-size="12">${esc(padClipText(text))}</text>`,
    );
  }
  return parts;
};

export const padToSvg = (
  pad: Pad,
  theme: ThemeMode = "dark",
  options?: PadSvgOptions,
): string => {
  const pal = padSvgPalette(theme);
  const box = padSvgViewRect(pad, options?.viewBox, options?.padding);
  const hrefs = options?.hrefs;
  const sizeAttrs = options?.framed
    ? `preserveAspectRatio="xMidYMid meet"`
    : `width="${fmt(box.w)}" height="${fmt(box.h)}"`;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}" ${sizeAttrs} font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`,
    `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" fill="${esc(pal.ground)}"/>`,
  ];

  for (const image of padElementsByZ(pad.images)) {
    const href = hrefs?.[image.id];
    if (href) {
      parts.push(
        `<image href="${esc(href)}" x="${fmt(image.x)}" y="${fmt(image.y)}" width="${fmt(image.w)}" height="${fmt(image.h)}" preserveAspectRatio="xMidYMid meet"/>`,
      );
    } else {
      parts.push(
        `<rect x="${fmt(image.x)}" y="${fmt(image.y)}" width="${fmt(image.w)}" height="${fmt(image.h)}" fill="${esc(pal.fill)}" stroke="${esc(pal.stroke)}" stroke-width="1"/>`,
        `<text x="${fmt(image.x + 8)}" y="${fmt(image.y + 16)}" fill="${esc(pal.dim)}" font-size="10">${esc(padClipText(padImageLabel(image)))}</text>`,
      );
    }
  }

  for (const edge of pad.edges) {
    const points = edgePoints(pad, edge);
    if (!points) continue;
    parts.push(
      `<path d="${esc(strokePath(points, 1.5))}" fill="none" stroke="${esc(pal.steel)}" stroke-width="1.5"/>`,
    );
    if (edge.label) {
      const mid = points[Math.floor(points.length / 2)] ?? points[0]!;
      parts.push(
        `<text x="${fmt(mid.x)}" y="${fmt(mid.y)}" fill="${esc(pal.dim)}" font-size="10" text-anchor="middle">${esc(edge.label)}</text>`,
      );
    }
  }

  for (const shape of padElementsByZ(pad.shapes)) {
    parts.push(...emitShape(shape, pal));
  }

  for (const ink of padElementsByZ(pad.inks)) {
    parts.push(
      `<path d="${esc(strokePath(ink.points, ink.width))}" fill="none" stroke="${esc(padInkStroke(ink.color, pal))}" stroke-width="${fmt(ink.width)}" stroke-linecap="round" stroke-linejoin="round"/>`,
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
      `  ${image.id} :: ${xy(image.x, image.y)} ${wh(image.w, image.h)} sha=${image.ref.sha256.slice(0, SHA_PREFIX)}${field("name", name ? JSON.stringify(name) : undefined)} ${image.ref.mediaType}`,
    );
  }
  lines.push(`shapes :: ${pad.shapes.length}`);
  for (const shape of pad.shapes) {
    lines.push(
      `  ${shape.id} :: ${shape.type} ${xy(shape.x, shape.y)} ${wh(shape.w, shape.h)}${field("text", shape.text === undefined ? undefined : JSON.stringify(shape.text))}${field("status", shape.status)}${field("href", shape.href)}${field("label", shape.label === undefined ? undefined : JSON.stringify(shape.label))}`,
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
    items.push(focused(image.id, "image", boundsOf(image), padImageLabel(image)));
  }
  for (const shape of pad.shapes) {
    items.push(focused(shape.id, shape.type, boundsOf(shape), padShapeText(shape), shape.status));
  }
  for (const edge of pad.edges) {
    const bounds = boundsOf(pad, edge.id);
    if (!bounds) continue;
    items.push(focused(edge.id, "edge", bounds, edge.label));
  }
  for (const ink of pad.inks) {
    items.push(focused(ink.id, "ink", boundsOf(ink)));
  }
  return items;
};

