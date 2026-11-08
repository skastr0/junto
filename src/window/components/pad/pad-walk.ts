/**
 * The pad by keyboard: shapes walked in reading order, the words the status
 * line says for each, and the targets a keyboard connector walks. Pure; the
 * editor owns the keys.
 */
import type { Pad, PadShape, PadShapeType } from "@shared/pad";
import { padShapeText } from "@shared/pad-project";

const KIND_NAMES: Readonly<Record<PadShapeType, string>> = {
  box: "Box",
  ellipse: "Ellipse",
  triangle: "Triangle",
  label: "Label",
  diamond: "Diamond",
  cylinder: "Cylinder",
  card: "Card",
};

/** Rows this close in pad units read as one line. */
const ROW_SLOP = 24;

/** Shapes as a reader meets them: top to bottom, then left to right along a row. */
export const readingOrder = (shapes: ReadonlyArray<PadShape>): PadShape[] =>
  [...shapes].sort((a, b) => (Math.abs(a.y - b.y) <= ROW_SLOP ? a.x - b.x : a.y - b.y) || a.z - b.z);

/**
 * The shape a walk lands on next, or undefined when it walks off either end:
 * the keys then leave the canvas. Without a current shape it starts at the first.
 */
export const walkShapes = (
  shapes: ReadonlyArray<PadShape>,
  current: string | undefined,
  step: 1 | -1,
): PadShape | undefined => {
  const order = readingOrder(shapes);
  if (order.length === 0) return undefined;
  const at = current === undefined ? -1 : order.findIndex((shape) => shape.id === current);
  if (at < 0) return step === 1 ? order[0] : order[order.length - 1];
  return order[at + step];
};

/** What the status line calls a shape: its kind, then its words. */
export const shapeName = (shape: PadShape): string => {
  const text = padShapeText(shape)?.replace(/\s+/gu, " ").trim();
  return text ? `${KIND_NAMES[shape.type]}, ${text}` : KIND_NAMES[shape.type];
};

/** The status line for a selection made by keyboard. */
export const selectedWords = (pad: Pad, shape: PadShape): string => {
  const order = readingOrder(pad.shapes);
  const at = order.findIndex((item) => item.id === shape.id);
  return `Selected ${shapeName(shape)}, ${at + 1} of ${order.length}`;
};

/** The status line once an edge is written by keyboard. */
export const connectedWords = (from: PadShape, to: PadShape): string =>
  `Connected ${shapeName(from)} to ${shapeName(to)}`;

/** The shapes a keyboard connector from `from` can land on, in reading order. */
export const connectTargets = (pad: Pad, from: string): PadShape[] =>
  readingOrder(pad.shapes.filter((shape) => shape.id !== from));
