/**
 * The pad's marks, one look for the editor and the read-only view: a shape's
 * outline, its words inside it, and an edge with its arrowhead and label.
 * Paint is resolved to hex, `none` or a theme default; pad strings never
 * become markup.
 */
import type { PadEdge, PadPoint, PadShape } from "@shared/pad";
import { cylinderPaths, diamondPoints, strokePath, trianglePoints } from "@shared/pad-geom";
import {
  PAD_LOOK,
  padArrowHead,
  padClipText,
  padLinkWords,
  padEdgeMid,
  padShapeFill,
  padShapeStroke,
  padShapeText,
  padTextLayout,
  type PadSvgPalette,
} from "@shared/pad-project";
import { FONT_MONO } from "@shared/theme";
import { usePadLinkTitleOf } from "./pad-link-titles";

/** The app's mono face: the pad's wrapping assumes its 0.6 em advance. */
export const PAD_FONT = FONT_MONO;

const pointsAttr = (points: ReadonlyArray<PadPoint>): string => points.map((p) => `${p.x},${p.y}`).join(" ");

/** A shape's outline; a label has none until it is selected. */
export function PadShapeOutline({
  shape,
  pal,
  selected = false,
}: {
  readonly shape: PadShape;
  readonly pal: PadSvgPalette;
  readonly selected?: boolean;
}) {
  const stroke = selected ? pal.amber : padShapeStroke(shape, pal);
  const common = {
    fill: padShapeFill(shape, pal),
    stroke,
    strokeWidth: selected ? PAD_LOOK.selectedStroke : PAD_LOOK.stroke,
    strokeLinejoin: "round" as const,
  };
  switch (shape.type) {
    case "label":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          fill={shape.fill === undefined ? "transparent" : common.fill}
          stroke={selected ? pal.amber : "none"}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      );
    case "ellipse":
      return (
        <ellipse
          cx={shape.x + shape.w / 2}
          cy={shape.y + shape.h / 2}
          rx={shape.w / 2}
          ry={shape.h / 2}
          {...common}
        />
      );
    case "triangle":
      return <polygon points={pointsAttr(trianglePoints(shape))} {...common} />;
    case "diamond":
      return <polygon points={pointsAttr(diamondPoints(shape))} {...common} />;
    case "cylinder": {
      const { outline, rim } = cylinderPaths(shape);
      return (
        <g>
          <path d={outline} {...common} />
          <path d={rim} fill="none" stroke={stroke} strokeWidth={common.strokeWidth} />
        </g>
      );
    }
    default:
      return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={6} {...common} />;
  }
}

/** A shape's words, wrapped inside it; a free label is ringed in the ground so it reads over a line. */
export function PadShapeWords({ shape, pal }: { readonly shape: PadShape; readonly pal: PadSvgPalette }) {
  const text = padShapeText(shape, usePadLinkTitleOf());
  if (!text) return null;
  const layout = padTextLayout(shape, padClipText(text));
  return (
    <text
      fill={pal.text}
      fontSize={layout.size}
      fontFamily={PAD_FONT}
      textAnchor={layout.anchor}
      {...(shape.type === "label" ? { stroke: pal.ground, strokeWidth: 4, paintOrder: "stroke" } : {})}
      style={{ pointerEvents: "none" }}
    >
      {layout.lines.map((line, index) => (
        <tspan key={index} x={layout.x} y={layout.y + index * layout.step}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** An edge's label as words: its links as their current titles. */
function PadEdgeWords({ label }: { readonly label: string }) {
  return <>{padClipText(padLinkWords(label, usePadLinkTitleOf()))}</>;
}

/** An edge: its route, an arrowhead where it lands, and its label ringed in the ground so it reads over the line. */
export function PadEdgeMark({
  edge,
  points,
  pal,
  selected = false,
}: {
  readonly edge: PadEdge;
  readonly points: ReadonlyArray<PadPoint>;
  readonly pal: PadSvgPalette;
  readonly selected?: boolean;
}) {
  const color = selected ? pal.amber : pal.steel;
  const width = selected ? PAD_LOOK.selectedStroke : PAD_LOOK.edge;
  const head = padArrowHead(points);
  const mid = edge.label ? padEdgeMid(points) : undefined;
  return (
    <g data-testid="pad-edge" data-edge-id={edge.id}>
      <path d={strokePath(points, width)} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" />
      {head ? <polygon points={pointsAttr(head)} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" /> : null}
      {mid && edge.label ? (
        <text
          x={mid.x}
          y={mid.y + PAD_LOOK.edgeText * 0.35}
          fill={pal.text}
          fontSize={PAD_LOOK.edgeText}
          fontFamily={PAD_FONT}
          textAnchor="middle"
          stroke={pal.ground}
          strokeWidth={4}
          paintOrder="stroke"
          style={{ pointerEvents: "none" }}
        >
          <PadEdgeWords label={edge.label} />
        </text>
      ) : null}
    </g>
  );
}
