/**
 * The pad IR and an Excalidraw scene, both ways (spike, 0.10.3). The pad
 * stays the stored truth: an agent's patch lands as a scene, and the
 * operator's scene becomes patches against the pad it was made from, so
 * every write is still one ruled artifact edit and one version.
 *
 *   box       rectangle, its text bound inside
 *   ellipse   ellipse, its text bound inside
 *   triangle  closed line (first point is the last), customData type
 *   label     free text
 *   edge      arrow bound at both ends to shapes, its label bound on it
 *   image     image, the file keyed by the content's sha256
 *   ink       freedraw
 *   card      a box whose text is one Junto mention href: an embeddable
 *
 * What the pad cannot hold (a diamond, a free line or arrow, a frame) stays
 * in the scene and is named back as unsaved, never written.
 */
import type { ContentRef } from "@shared/content";
import { parseMentionHref } from "@shared/mention";
import {
  asPadElementId,
  type Pad,
  type PadEdge,
  type PadElementId,
  type PadImage,
  type PadInk,
  type PadPatch,
  type PadShape,
  type PadShapeStatus,
  type PadSide,
} from "@shared/pad";
import { edgePoints } from "@shared/pad-geom";
import { padStatusStroke, resolvePadPaint, type PadSvgPalette } from "@shared/pad-project";

/** What a scene element carries back to the pad. */
export type JuntoData = {
  readonly z?: number;
  readonly type?: "triangle";
  readonly status?: PadShapeStatus;
  readonly fromSide?: PadSide;
  readonly toSide?: PadSide;
  readonly ref?: ContentRef;
  /** The stored colors, so a default color is never written back as a literal. */
  readonly fill?: string;
  readonly stroke?: string;
};

/** The slice of an Excalidraw element the mapping reads and writes. */
export type SceneElement = {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly strokeWidth: number;
  readonly isDeleted: boolean;
  readonly boundElements: ReadonlyArray<{ readonly id: string; readonly type: "text" | "arrow" }> | null;
  readonly link: string | null;
  readonly customData?: { readonly junto?: JuntoData };
  readonly text?: string;
  readonly originalText?: string;
  readonly containerId?: string | null;
  readonly points?: ReadonlyArray<readonly [number, number]>;
  readonly startBinding?: { readonly elementId: string; readonly focus?: number; readonly gap?: number } | null;
  readonly endBinding?: { readonly elementId: string; readonly focus?: number; readonly gap?: number } | null;
  readonly fileId?: string | null;
  readonly [key: string]: unknown;
};

/** Cascadia, the mono face Excalidraw ships: our instrument type on the pad. */
export const PAD_FONT_FAMILY = 3;
export const PAD_FONT_SIZE = 16;
const LINE_HEIGHT = 1.25;
/** Strokes read at any zoom in both themes: no hairlines. */
export const PAD_STROKE_WIDTH = 2;

const TEXT_SUFFIX = ":text";

/** A stable seed from the id, so the same element draws the same way every time. */
const seedOf = (id: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return Math.abs(hash) || 1;
};

const base = (id: string, rest: Partial<SceneElement> & Pick<SceneElement, "type" | "x" | "y" | "width" | "height">): SceneElement => ({
  id,
  strokeColor: "transparent",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: PAD_STROKE_WIDTH,
  strokeStyle: "solid",
  roundness: null,
  roughness: 0,
  opacity: 100,
  angle: 0,
  seed: seedOf(id),
  version: 1,
  versionNonce: seedOf(`${id}~`),
  index: null,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 0,
  link: null,
  locked: false,
  ...rest,
});

/** A shape's stroke when the pad stores none: ink, or its status color. */
export const defaultStroke = (status: PadShapeStatus | undefined, pal: PadSvgPalette): string =>
  status === undefined || status === "none" ? pal.text : padStatusStroke(status, pal);

const textWidth = (text: string): number =>
  Math.max(...text.split("\n").map((line) => line.length), 1) * PAD_FONT_SIZE * 0.6;

const textElement = (
  id: string,
  text: string,
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  color: string,
  containerId: string | null,
): SceneElement => {
  const lines = text.split("\n").length;
  const height = lines * PAD_FONT_SIZE * LINE_HEIGHT;
  const width = containerId === null ? Math.max(box.w, textWidth(text)) : Math.min(box.w, textWidth(text));
  return base(id, {
    type: "text",
    x: containerId === null ? box.x : box.x + (box.w - width) / 2,
    y: containerId === null ? box.y : box.y + (box.h - height) / 2,
    width,
    height,
    strokeColor: color,
    text,
    originalText: text,
    fontSize: PAD_FONT_SIZE,
    fontFamily: PAD_FONT_FAMILY,
    textAlign: containerId === null ? "left" : "center",
    verticalAlign: containerId === null ? "top" : "middle",
    containerId,
    autoResize: containerId === null,
    lineHeight: LINE_HEIGHT,
  });
};

/** The href a card shape holds, when its text is exactly one Junto mention href. */
export const cardHref = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed !== undefined && parseMentionHref(trimmed) !== undefined ? trimmed : undefined;
};

const byZ = <T extends { readonly z: number }>(items: ReadonlyArray<T>): T[] => [...items].sort((a, b) => a.z - b.z);

/**
 * The scene a pad draws as: images, then edges, shapes and ink, each layer
 * by z, a bound text right after its container. Colors the pad leaves unset
 * take the palette, so a theme change repaints them.
 */
export const padToScene = (pad: Pad, pal: PadSvgPalette): SceneElement[] => {
  const arrowsOf = new Map<string, string[]>();
  for (const edge of pad.edges) {
    arrowsOf.set(edge.from, [...(arrowsOf.get(edge.from) ?? []), edge.id]);
    arrowsOf.set(edge.to, [...(arrowsOf.get(edge.to) ?? []), edge.id]);
  }
  const out: SceneElement[] = [];
  for (const image of byZ(pad.images)) {
    out.push(
      base(image.id, {
        type: "image",
        x: image.x,
        y: image.y,
        width: image.w,
        height: image.h,
        fileId: image.ref.sha256,
        status: "saved",
        scale: [1, 1],
        crop: null,
        customData: { junto: { z: image.z, ref: image.ref } },
      }),
    );
  }
  for (const edge of pad.edges) {
    const points = edgePoints(pad, edge);
    if (!points || points.length < 2) continue;
    const origin = points[0]!;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const labelId = `${edge.id}${TEXT_SUFFIX}`;
    out.push(
      base(edge.id, {
        type: "arrow",
        x: origin.x,
        y: origin.y,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        strokeColor: pal.dim,
        roundness: { type: 2 },
        points: points.map((p) => [p.x - origin.x, p.y - origin.y] as const),
        lastCommittedPoint: null,
        startBinding: { elementId: edge.from, focus: 0, gap: 4 },
        endBinding: { elementId: edge.to, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
        boundElements: edge.label ? [{ id: labelId, type: "text" }] : null,
        customData: {
          junto: {
            ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
            ...(edge.toSide ? { toSide: edge.toSide } : {}),
          },
        },
      }),
    );
    if (edge.label) {
      const mid = points[Math.floor(points.length / 2)]!;
      out.push(textElement(labelId, edge.label, { x: mid.x - 40, y: mid.y - 10, w: 80, h: 20 }, pal.text, edge.id));
    }
  }
  for (const shape of byZ(pad.shapes)) {
    const stroke = resolvePadPaint(shape.stroke, defaultStroke(shape.status, pal));
    const fill = shape.fill === undefined ? "transparent" : resolvePadPaint(shape.fill, "transparent");
    const junto: JuntoData = {
      z: shape.z,
      ...(shape.status ? { status: shape.status } : {}),
      ...(shape.fill ? { fill: shape.fill } : {}),
      ...(shape.stroke ? { stroke: shape.stroke } : {}),
    };
    const arrows = (arrowsOf.get(shape.id) ?? []).map((id) => ({ id, type: "arrow" as const }));
    if (shape.type === "label") {
      out.push({ ...textElement(shape.id, shape.text ?? " ", shape, stroke, null), customData: { junto } });
      continue;
    }
    const href = shape.type === "box" ? cardHref(shape.text) : undefined;
    if (href !== undefined) {
      out.push(
        base(shape.id, {
          type: "embeddable",
          x: shape.x,
          y: shape.y,
          width: shape.w,
          height: shape.h,
          strokeColor: stroke,
          link: href,
          boundElements: arrows.length > 0 ? arrows : null,
          customData: { junto },
        }),
      );
      continue;
    }
    const textId = `${shape.id}${TEXT_SUFFIX}`;
    const bound = [...arrows, ...(shape.text ? [{ id: textId, type: "text" as const }] : [])];
    const common = {
      x: shape.x,
      y: shape.y,
      width: shape.w,
      height: shape.h,
      strokeColor: stroke,
      backgroundColor: fill,
      boundElements: bound.length > 0 ? bound : null,
    };
    if (shape.type === "triangle") {
      out.push(
        base(shape.id, {
          type: "line",
          ...common,
          points: [
            [shape.w / 2, 0],
            [shape.w, shape.h],
            [0, shape.h],
            [shape.w / 2, 0],
          ],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
          customData: { junto: { ...junto, type: "triangle" } },
        }),
      );
    } else {
      out.push(
        base(shape.id, {
          type: shape.type === "ellipse" ? "ellipse" : "rectangle",
          ...common,
          roundness: shape.type === "box" ? { type: 3 } : { type: 2 },
          customData: { junto },
        }),
      );
    }
    if (shape.text && shape.type !== "triangle") out.push(textElement(textId, shape.text, shape, pal.text, shape.id));
  }
  for (const ink of byZ(pad.inks)) {
    const xs = ink.points.map((p) => p.x);
    const ys = ink.points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    out.push(
      base(ink.id, {
        type: "freedraw",
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
        strokeColor: resolvePadPaint(ink.color, pal.text),
        strokeWidth: ink.width,
        points: ink.points.map((p) => [p.x - x, p.y - y] as const),
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: null,
        customData: { junto: { z: ink.z } },
      }),
    );
  }
  return out;
};

/** A pasted image still in the scene's files only: it needs storing before it can be written. */
export type UnstoredImage = { readonly id: PadElementId; readonly fileId: string };

export type SceneRead = {
  /** The pad the scene holds; its revision is the base's. */
  readonly pad: Pad;
  /** Elements the pad cannot hold: kept on screen, not written. */
  readonly unsaved: ReadonlyArray<string>;
  readonly unstored: ReadonlyArray<UnstoredImage>;
};

const juntoOf = (element: SceneElement): JuntoData => element.customData?.junto ?? {};

const nextZ = (items: ReadonlyArray<{ readonly z: number }>): number => items.reduce((max, item) => Math.max(max, item.z), -1) + 1;

/** A stored color, kept only when the operator picked one the default would not give. */
const storedPaint = (value: string, fallback: string, kept: string | undefined): string | undefined => {
  if (value === "transparent" || value === fallback) return undefined;
  return kept !== undefined && kept.toLowerCase() === value.toLowerCase() ? kept : value;
};

/**
 * Read the pad back out of a scene. Elements keep their z; a new one goes on
 * top of its layer. `base` gives each element's z and the stored colors.
 */
export const sceneToPad = (base: Pad, elements: ReadonlyArray<SceneElement>, pal: PadSvgPalette): SceneRead => {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const textOf = (container: SceneElement): string | undefined => {
    const bound = container.boundElements?.find((b) => b.type === "text");
    const text = bound ? byId.get(bound.id) : undefined;
    const value = (text?.originalText ?? text?.text)?.trim();
    return value && value.length > 0 ? value : undefined;
  };
  const shapes: PadShape[] = [];
  const images: PadImage[] = [];
  const inks: PadInk[] = [];
  const unsaved: string[] = [];
  const unstored: UnstoredImage[] = [];
  const arrows: SceneElement[] = [];

  const shapeZ = (element: SceneElement): number => juntoOf(element).z ?? nextZ([...base.shapes, ...shapes]);

  for (const element of live) {
    const junto = juntoOf(element);
    const id = asPadElementId(element.id);
    const box = { x: element.x, y: element.y, w: Math.max(element.width, 1), h: Math.max(element.height, 1) };
    const status = junto.status !== undefined ? { status: junto.status } : {};
    const strokeDefault = defaultStroke(junto.status, pal);
    const paints = (withFill: boolean) => {
      const stroke = storedPaint(element.strokeColor, strokeDefault, junto.stroke);
      const fill = withFill ? storedPaint(element.backgroundColor, "transparent", junto.fill) : undefined;
      return { ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) };
    };
    switch (element.type) {
      case "rectangle":
      case "ellipse": {
        const text = textOf(element);
        shapes.push({
          id,
          type: element.type === "ellipse" ? "ellipse" : "box",
          ...box,
          z: shapeZ(element),
          ...paints(true),
          ...(text ? { text } : {}),
          ...status,
        });
        break;
      }
      case "line": {
        if (junto.type !== "triangle") {
          unsaved.push(element.id);
          break;
        }
        shapes.push({ id, type: "triangle", ...box, z: shapeZ(element), ...paints(true), ...status });
        break;
      }
      case "embeddable": {
        if (element.link === null || parseMentionHref(element.link) === undefined) {
          unsaved.push(element.id);
          break;
        }
        shapes.push({ id, type: "box", ...box, z: shapeZ(element), text: element.link, ...status });
        break;
      }
      case "text": {
        if (element.containerId) break;
        const text = (element.originalText ?? element.text ?? "").trim();
        if (text.length === 0) break;
        shapes.push({ id, type: "label", ...box, z: shapeZ(element), text, ...paints(false), ...status });
        break;
      }
      case "arrow":
        arrows.push(element);
        break;
      case "image": {
        if (junto.ref === undefined) {
          if (element.fileId) unstored.push({ id, fileId: element.fileId });
          break;
        }
        images.push({ id, ...box, z: junto.z ?? nextZ([...base.images, ...images]), ref: junto.ref });
        break;
      }
      case "freedraw": {
        const points = (element.points ?? []).map(([px, py]) => ({ x: element.x + px, y: element.y + py }));
        if (points.length < 2) break;
        inks.push({
          id,
          z: junto.z ?? nextZ([...base.inks, ...inks]),
          color: element.strokeColor,
          width: Math.max(element.strokeWidth, 0.5),
          points,
        });
        break;
      }
      default:
        unsaved.push(element.id);
    }
  }

  const shapeIds = new Set(shapes.map((shape) => shape.id));
  const edges: PadEdge[] = [];
  for (const arrow of arrows) {
    const from = arrow.startBinding?.elementId;
    const to = arrow.endBinding?.elementId;
    if (from === undefined || to === undefined || from === to || !shapeIds.has(asPadElementId(from)) || !shapeIds.has(asPadElementId(to))) {
      unsaved.push(arrow.id);
      continue;
    }
    const junto = juntoOf(arrow);
    const was = base.edges.find((edge) => edge.id === arrow.id);
    // Sides hold only while the arrow joins what it joined.
    const sides = was && was.from === from && was.to === to
      ? { ...(junto.fromSide ? { fromSide: junto.fromSide } : {}), ...(junto.toSide ? { toSide: junto.toSide } : {}) }
      : {};
    const label = textOf(arrow);
    edges.push({
      id: asPadElementId(arrow.id),
      from: asPadElementId(from),
      to: asPadElementId(to),
      ...sides,
      ...(label ? { label } : {}),
    });
  }

  return { pad: { revision: base.revision, images, shapes, edges, inks }, unsaved, unstored };
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const keyed = <T extends { readonly id: string }>(items: ReadonlyArray<T>): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

/**
 * The patches that turn `from` into `to`, in an order applyPatch takes:
 * edge deletes, then shapes and images and ink, then edges. A shape's
 * delete drops its edges, so those edges are not deleted again.
 */
export const padDiff = (from: Pad, to: Pad): PadPatch[] => {
  const patches: PadPatch[] = [];
  const toShapes = keyed(to.shapes);
  const goneShapes = new Set(from.shapes.filter((shape) => !toShapes.has(shape.id)).map((shape) => shape.id));
  const toEdges = keyed(to.edges);
  for (const edge of from.edges) {
    if (toEdges.has(edge.id) || goneShapes.has(edge.from) || goneShapes.has(edge.to)) continue;
    patches.push({ op: "delete", id: edge.id });
  }
  const layer = <T extends { readonly id: PadElementId }>(
    before: ReadonlyArray<T>,
    after: ReadonlyArray<T>,
    upsert: (item: T) => PadPatch,
  ): void => {
    const now = keyed(after);
    for (const item of before) if (!now.has(item.id)) patches.push({ op: "delete", id: item.id });
    const was = keyed(before);
    for (const item of after) if (!same(was.get(item.id), item)) patches.push(upsert(item));
  };
  layer(from.shapes, to.shapes, (shape) => ({ op: "upsert", layer: "shape", shape }));
  layer(from.images, to.images, (image) => ({ op: "upsert", layer: "image", image }));
  layer(from.inks, to.inks, (ink) => ({ op: "upsert", layer: "ink", ink }));
  const wasEdges = keyed(from.edges);
  for (const edge of to.edges) {
    if (!same(wasEdges.get(edge.id), edge)) patches.push({ op: "upsert", layer: "edge", edge });
  }
  return patches;
};

/**
 * Keep the base's item wherever the operator changed nothing: Excalidraw
 * measures and routes on its own (a label's box, an arrow's path), and that
 * must not become a write. `changed` holds the ids whose scene element moved
 * on since the last sync; a bound text counts for its container.
 */
export const settle = (base: Pad, read: Pad, changed: ReadonlySet<string>): Pad => {
  const keep = <T extends { readonly id: string }>(before: ReadonlyArray<T>, after: ReadonlyArray<T>): T[] => {
    const was = keyed(before);
    return after.map((item) => (changed.has(item.id) ? item : (was.get(item.id) ?? item)));
  };
  return {
    ...read,
    shapes: keep(base.shapes, read.shapes),
    edges: keep(base.edges, read.edges),
    images: keep(base.images, read.images),
    inks: keep(base.inks, read.inks),
  };
};
