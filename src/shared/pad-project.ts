/**
 * Junto pad projections. Deterministic, no DOM.
 */
import { Schema } from "effect";
import {
  type Pad,
  type PadElementId,
  type PadImage,
  type PadPoint,
  type PadShape,
  type PadShapeStatus,
  formatPadNumber,
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
import { artifactLinkTitle } from "./artifact-link";
import { mentionLinksOf, type MentionTarget } from "./mention";
import { FONT_MONO, themeRuntime, type ThemeMode } from "./theme";

/** The pad as text: the wire's (`./wire/pad.ts`), for every existing import. */
export { padToDigest } from "./pad";

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
    /** A shape's outline when it names no stroke and no status. */
    outline: tokens["ink-2"]!,
    fill: tokens["overlay-2"]!,
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

const fmt = formatPadNumber;

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
      return pal.outline;
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

/**
 * How the pad draws, in pad units, one look for the editor, the read-only
 * view and the export: outlines heavy enough to read at a glance, text
 * inside its shape, an arrowhead where an edge lands.
 */
export const PAD_LOOK = {
  stroke: 2,
  selectedStroke: 2.5,
  edge: 2,
  arrow: 10,
  text: 14,
  labelText: 16,
  edgeText: 14,
  leading: 1.3,
  inset: 8,
  /** Advance of one character of the pad's mono face, in ems. */
  advance: 0.6,
} as const;

export type PadTextLayout = {
  readonly lines: ReadonlyArray<string>;
  readonly x: number;
  /** Baseline of the first line. */
  readonly y: number;
  readonly anchor: "start" | "middle";
  readonly size: number;
  /** Baseline to baseline. */
  readonly step: number;
};

const wrapWords = (text: string, perLine: number): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter((part) => part.length > 0)) {
      let rest = word;
      while (rest.length > perLine) {
        if (line.length > 0) {
          lines.push(line);
          line = "";
        }
        lines.push(rest.slice(0, perLine));
        rest = rest.slice(perLine);
      }
      if (line.length === 0) line = rest;
      else if (line.length + 1 + rest.length <= perLine) line = `${line} ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
};

/**
 * A shape's words laid out inside it: wrapped to its width, cut with an
 * ellipsis where its height ends, centred in an outline and read from the
 * top left in a label.
 */
export const padTextLayout = (shape: PadShape, text: string): PadTextLayout => {
  const label = shape.type === "label";
  const size = label ? PAD_LOOK.labelText : PAD_LOOK.text;
  const step = size * PAD_LOOK.leading;
  const inset = label ? 0 : PAD_LOOK.inset;
  const perLine = Math.max(1, Math.floor((shape.w - inset * 2) / (size * PAD_LOOK.advance)));
  const room = label ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor((shape.h - inset * 2) / step));
  const wrapped = wrapWords(text, perLine);
  const lines =
    wrapped.length <= room
      ? wrapped
      : [...wrapped.slice(0, room - 1), `${wrapped[room - 1]!.slice(0, Math.max(0, perLine - 1))}…`];
  if (label) return { lines, x: shape.x, y: shape.y + size * 0.85, anchor: "start", size, step };
  // A triangle's room is low and wide; a cylinder's starts under its rim.
  const middle =
    shape.type === "triangle"
      ? shape.y + shape.h * 0.64
      : shape.type === "cylinder"
        ? shape.y + shape.h * 0.56
        : shape.y + shape.h / 2;
  const block = lines.length * step;
  return {
    lines,
    x: shape.x + shape.w / 2,
    y: middle - block / 2 + step / 2 + size * 0.35,
    anchor: "middle",
    size,
    step,
  };
};

/** The arrowhead where an edge lands: tip, then the two barbs, or undefined for a route too short to aim. */
export const padArrowHead = (
  points: ReadonlyArray<PadPoint>,
  size: number = PAD_LOOK.arrow,
): readonly [PadPoint, PadPoint, PadPoint] | undefined => {
  const tip = points[points.length - 1];
  if (!tip) return undefined;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const from = points[i]!;
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) continue;
    const ux = dx / length;
    const uy = dy / length;
    const baseX = tip.x - ux * size;
    const baseY = tip.y - uy * size;
    const half = size * 0.5;
    return [
      tip,
      { x: baseX - uy * half, y: baseY + ux * half },
      { x: baseX + uy * half, y: baseY - ux * half },
    ];
  }
  return undefined;
};

/** Where an edge's label sits: the middle of its route. */
export const padEdgeMid = (points: ReadonlyArray<PadPoint>): PadPoint => {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (points.length % 2 === 1) return points[(points.length - 1) / 2]!;
  const a = points[points.length / 2 - 1] ?? first;
  const b = points[points.length / 2] ?? last;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

/** A link's words now, when the reader knows them (`written` is its label as written); undefined keeps the written words. */
export type PadLinkTitleOf = (target: MentionTarget, written: string) => string | undefined;


/**
 * Text as the pad shows it: each mention link drawn as its words, never its
 * address. An artifact link takes the words the reader knows now (its
 * title, archived, or missing), else the title it was written with.
 */
export const padLinkWords = (text: string, titleOf?: PadLinkTitleOf): string => {
  const links = mentionLinksOf(text);
  if (links.length === 0) return text;
  let words = "";
  let at = 0;
  for (const link of links) {
    words += text.slice(at, link.start) + (titleOf?.(link.target, link.label) ?? artifactLinkTitle(link.label) ?? link.label);
    at = link.end;
  }
  return words + text.slice(at);
};

/** The words a shape shows: its text, links as their titles, or for a card the name its writer saw, else its link. */
export const padShapeText = (shape: PadShape, titleOf?: PadLinkTitleOf): string | undefined =>
  shape.type === "card" ? shape.label ?? shape.href : shape.text === undefined ? undefined : padLinkWords(shape.text, titleOf);

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
      `<ellipse cx="${fmt(shape.x + shape.w / 2)}" cy="${fmt(shape.y + shape.h / 2)}" rx="${fmt(shape.w / 2)}" ry="${fmt(shape.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`,
    );
  } else if (shape.type === "triangle") {
    const [a, b, c] = trianglePoints(shape);
    parts.push(
      `<polygon points="${fmt(a.x)},${fmt(a.y)} ${fmt(b.x)},${fmt(b.y)} ${fmt(c.x)},${fmt(c.y)}" fill="${fill}" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`,
    );
  } else if (shape.type === "diamond") {
    const points = diamondPoints(shape).map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
    parts.push(`<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`);
  } else if (shape.type === "cylinder") {
    const { outline, rim } = cylinderPaths(shape);
    parts.push(
      `<path d="${esc(outline)}" fill="${fill}" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`,
      `<path d="${esc(rim)}" fill="none" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`,
    );
  } else {
    parts.push(
      `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" fill="${fill}" stroke="${stroke}" stroke-width="${PAD_LOOK.stroke}"/>`,
    );
  }
  const text = padShapeText(shape);
  if (text) {
    const layout = padTextLayout(shape, padClipText(text));
    const lines = layout.lines
      .map((line, index) => `<tspan x="${fmt(layout.x)}" y="${fmt(layout.y + index * layout.step)}">${esc(line)}</tspan>`)
      .join("");
    parts.push(
      `<text fill="${esc(pal.text)}" font-size="${layout.size}" text-anchor="${layout.anchor}"${shape.type === "label" ? ` stroke="${esc(pal.ground)}" stroke-width="4" paint-order="stroke"` : ""}>${lines}</text>`,
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}" ${sizeAttrs} font-family="${esc(FONT_MONO)}">`,
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
      `<path d="${esc(strokePath(points, PAD_LOOK.edge))}" fill="none" stroke="${esc(pal.steel)}" stroke-width="${PAD_LOOK.edge}"/>`,
    );
    const head = padArrowHead(points);
    if (head) {
      parts.push(
        `<polygon points="${head.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ")}" fill="${esc(pal.steel)}"/>`,
      );
    }
    if (edge.label) {
      const mid = padEdgeMid(points);
      parts.push(
        `<text x="${fmt(mid.x)}" y="${fmt(mid.y + PAD_LOOK.edgeText * 0.35)}" fill="${esc(pal.text)}" font-size="${PAD_LOOK.edgeText}" text-anchor="middle" stroke="${esc(pal.ground)}" stroke-width="4" paint-order="stroke">${esc(padLinkWords(edge.label))}</text>`,
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
    items.push(focused(edge.id, "edge", bounds, edge.label === undefined ? undefined : padLinkWords(edge.label)));
  }
  for (const ink of pad.inks) {
    items.push(focused(ink.id, "ink", boundsOf(ink)));
  }
  return items;
};

