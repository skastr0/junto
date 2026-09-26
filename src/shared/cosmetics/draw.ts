import { parseCosmeticPath, type PathCommand } from "./path";
import type { BodyDeform, CosmeticLayer, CosmeticPart, CosmeticShape, CosmeticSpecies, PaletteRole } from "./pack-schema";

// The interpreter: turns cosmetic data into SVG markup. Every number it
// emits is its own (formatted here); every color is a palette role resolved
// by the caller; nothing from a pack is copied into the output as text.

type Point = readonly [number, number];

const f = (value: number): string => (Math.round(value * 10) / 10).toString();

/** Where the critter is: what anchors resolve against. */
export interface CritterGeometry {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly top: number;
  readonly halfWidthAt: (y: number) => number;
  readonly faceX: number;
  readonly eyeY: number;
  readonly eyeGap: number;
  readonly mouthY: number;
  readonly neckY: number;
}

export interface DrawStyle {
  /** Ink outline width at this detail tier; card is 3. */
  readonly outline: number;
  /** Riso misregistration offset. */
  readonly offset: number;
  readonly ink: string;
  readonly color: (role: PaletteRole) => string;
}

// --- bodies ----------------------------------------------------------------

export interface BodyShape {
  readonly path: string;
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly top: number;
  readonly halfWidthAt: (y: number) => number;
}

/** Closed Catmull-Rom spline through the points, as cubic Beziers. */
function smoothClosedPath(points: ReadonlyArray<Point>): string {
  const count = points.length;
  const at = (index: number): Point => points[((index % count) + count) % count] as Point;
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let index = 0; index < count; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Deform one unit-superellipse sample. Returns x, y, and a radial scale. */
function deformPoint(deform: BodyDeform, t: number, x: number, y: number): readonly [number, number, number] {
  const sin = Math.sin(t);
  switch (deform.kind) {
    case "pinchTop":
      return sin < 0 ? [x * (1 - deform.amount * (-sin) ** deform.power), y, 1] : [x, y, 1];
    case "pear":
      return [x * (1 + deform.amount * sin), y, 1];
    case "scallopTop":
      return [x, y, sin < 0 ? 1 + deform.depth * Math.abs(Math.cos(deform.lobes * t)) : 1];
    case "flattenBase":
      return sin > 0 ? [Math.sign(x) * Math.abs(x) ** deform.exponent, y, 1] : [x, y, 1];
    case "taper":
      return [x * (1 - deform.amount + (deform.amount * (y + 1)) / 2) * deform.scale, y, 1];
    case "hem":
      return sin > deform.from ? [x, y + deform.depth * Math.sin(deform.waves * t), 1] : [x, y, 1];
    case "cleft":
      return [x, y + (sin < 0 ? deform.depth * Math.exp(-((x / deform.width) ** 2)) : 0), 1];
  }
}

/** Half-width change at a normalized height v in [-1, 1], for placing parts. */
function deformWidth(deform: BodyDeform, v: number): number {
  switch (deform.kind) {
    case "pinchTop":
      return v < 0 ? 1 - deform.amount * (-v) ** deform.power : 1;
    case "pear":
      return 1 + deform.amount * v;
    case "taper":
      return (1 - deform.amount + (deform.amount * (v + 1)) / 2) * deform.scale;
    default:
      return 1;
  }
}

/**
 * A species' outline for one seat: the superellipse with its deformations and
 * the seat's own hand wobble. `width` (0..1) and `wobble` come from the seat.
 */
export function speciesBody(
  species: CosmeticSpecies,
  width: number,
  wobble: readonly [number, number, number, number],
): BodyShape {
  const [phaseA, phaseB, ampA, ampB] = wobble;
  const { n, h, cy } = species.body;
  const w = species.body.w * (0.93 + width * 0.14);
  const deforms = species.body.deform ?? [];
  const cx = 50;
  const steps = species.body.steps ?? 30;
  const exponent = 2 / n;
  const points: Point[] = [];
  for (let step = 0; step < steps; step += 1) {
    const t = (step / steps) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    let x = Math.sign(cos) * Math.abs(cos) ** exponent;
    let y = Math.sign(sin) * Math.abs(sin) ** exponent;
    let lobe = 1;
    for (const deform of deforms) {
      const [dx, dy, dl] = deformPoint(deform, t, x, y);
      x = dx;
      y = dy;
      lobe *= dl;
    }
    const hand = (1 + 0.028 * ampA * Math.sin(2 * t + phaseA) + 0.022 * ampB * Math.sin(3 * t + phaseB)) * lobe;
    points.push([cx + x * w * hand, cy + y * h * hand]);
  }
  const top = Math.min(...points.map((point) => point[1]));
  return {
    path: smoothClosedPath(points),
    cx,
    cy,
    w,
    h,
    top,
    halfWidthAt: (y) => {
      const v = Math.min(1, Math.max(-1, (y - cy) / h));
      let half = w * (1 - Math.abs(v) ** n) ** (1 / n);
      for (const deform of deforms) half *= deformWidth(deform, v);
      return half;
    },
  };
}

// --- parts -------------------------------------------------------------------

interface Frame {
  readonly ax: number;
  readonly ay: number;
  readonly flip: number;
  readonly sx: number;
  readonly sy: number;
}

const anchorY = (part: CosmeticPart, g: CritterGeometry): number => {
  const base = { top: g.top, eye: g.eyeY, mouth: g.mouthY, neck: g.neckY, center: g.cy, bottom: g.cy + g.h }[part.anchor.y];
  return base + (part.anchor.dy ?? 0);
};

function frameFor(part: CosmeticPart, g: CritterGeometry, dir: number, flip: number): Frame {
  const a = part.anchor;
  const ay = anchorY(part, g);
  const measureY = a.edgeAt !== undefined ? g.top + a.edgeAt : ay;
  const span = g.halfWidthAt(measureY) * (a.edgeScale ?? 1) + (a.edgePad ?? 0);
  const base =
    a.x === "center"
      ? g.cx
      : a.x === "face"
        ? g.faceX
        : a.x === "eye"
          ? g.faceX + dir * g.eyeGap
          : a.x === "ear"
            ? g.cx + dir * Math.max(10, g.halfWidthAt(g.top + 7) - 5)
            : g.cx + dir * span;
  const units = part.units ?? "px";
  return {
    ax: base + dir * (a.dx ?? 0),
    ay,
    flip,
    sx: units === "body" || units === "bodyX" ? g.w : units === "span" ? span : units === "eyes" ? g.eyeGap : 1,
    sy: units === "body" ? g.h : 1,
  };
}

const at = (fr: Frame, [x, y]: Point): string => `${f(fr.ax + fr.flip * x * fr.sx)} ${f(fr.ay + y * fr.sy)}`;

function pathData(commands: ReadonlyArray<PathCommand>, fr: Frame): string {
  return commands
    .map((command) => (command.op === "Z" ? "Z" : `${command.op}${command.points.map((point) => at(fr, point)).join(" ")}`))
    .join("");
}

function shapeData(shape: CosmeticShape, fr: Frame): string | undefined {
  switch (shape.kind) {
    case "path": {
      const commands = parseCosmeticPath(shape.d);
      return commands ? pathData(commands, fr) : undefined;
    }
    case "circle": {
      const [x, y] = [fr.ax + fr.flip * shape.cx * fr.sx, fr.ay + shape.cy * fr.sy];
      return `M${f(x - shape.r)} ${f(y)}a${f(shape.r)} ${f(shape.r)} 0 1 0 ${f(shape.r * 2)} 0a${f(shape.r)} ${f(shape.r)} 0 1 0 ${f(-shape.r * 2)} 0Z`;
    }
    case "ellipse": {
      const [x, y] = [fr.ax + fr.flip * shape.cx * fr.sx, fr.ay + shape.cy * fr.sy];
      const rx = shape.rx * (fr.sx === 1 ? 1 : fr.sx);
      const ry = shape.ry * (fr.sy === 1 ? 1 : fr.sy);
      return `M${f(x - rx)} ${f(y)}a${f(rx)} ${f(ry)} 0 1 0 ${f(rx * 2)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-rx * 2)} 0Z`;
    }
  }
}

function paint(shape: CosmeticShape, d: string, style: DrawStyle): string {
  const k = style.outline / 3;
  const opacity = shape.opacity !== undefined ? ` opacity="${shape.opacity}"` : "";
  const color = style.color(shape.color ?? (shape.paint === "stroke" ? "ink" : "body"));
  switch (shape.paint) {
    case "inked":
      return style.offset > 0
        ? `<path d="${d}" fill="${color}" transform="translate(${style.offset} ${style.offset * 0.7})"${opacity}/><path d="${d}" fill="none" stroke="${style.ink}" stroke-width="${style.outline}" stroke-linejoin="round"/>`
        : `<path d="${d}" fill="${color}" stroke="${style.ink}" stroke-width="${style.outline}" stroke-linejoin="round"${opacity}/>`;
    case "fill":
      return `<path d="${d}" fill="${color}"${opacity}/>`;
    case "line": {
      const width = (shape.width ?? 3) * k;
      return `<path d="${d}" stroke="${style.ink}" stroke-width="${f(width + style.outline * 1.4)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="${d}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round" fill="none"${opacity}/>`;
    }
    case "stroke": {
      const width = shape.width !== undefined ? shape.width * k : style.outline;
      return `<path d="${d}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round" fill="none"${opacity}/>`;
    }
  }
}

function drawPart(part: CosmeticPart, g: CritterGeometry, style: DrawStyle): string {
  const side = part.side === "left" ? -1 : 1;
  const copies: ReadonlyArray<readonly [dir: number, flip: number]> =
    part.mirror === "sides" ? [[-1, -1], [1, 1]] : part.mirror === "local" ? [[side, -1], [side, 1]] : [[side, side]];
  return copies
    .map(([dir, flip]) => {
      const fr = frameFor(part, g, dir, flip);
      const body = part.shapes
        .map((shape) => {
          const d = shapeData(shape, fr);
          return d ? paint(shape, d, style) : "";
        })
        .join("");
      if (!part.rotate) return body;
      const [px, py] = part.pivot ?? [0, 0];
      return `<g transform="rotate(${f(part.rotate * flip)} ${at(fr, [px, py])})">${body}</g>`;
    })
    .join("");
}

/** Draw every part of the given layer, in order. */
export function drawLayer(
  layer: CosmeticLayer,
  parts: ReadonlyArray<CosmeticPart>,
  g: CritterGeometry,
  style: DrawStyle,
): string {
  return parts
    .filter((part) => part.layer === layer)
    .map((part) => drawPart(part, g, style))
    .join("");
}
