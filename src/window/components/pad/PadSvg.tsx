/**
 * Structural pad SVG for the privileged renderer. Pad strings never become
 * markup here — paint is resolved to hex/`none` or a trusted theme default.
 * Serialized `padToSvg` is for export only.
 */
import type { Pad, PadImage, PadInk, PadShape } from "@shared/pad";
import { edgePoints, strokePath } from "@shared/pad-geom";
import {
  padClipText,
  padElementsByZ,
  padImageLabel,
  padInkStroke,
  padShapeFill,
  padShapeStroke,
  padShapeText,
  padSvgPalette,
  padSvgViewRect,
  type PadSvgOptions,
  type PadSvgPalette,
} from "@shared/pad-project";
import type { ThemeMode } from "@shared/theme";

import { PAD_FONT as FONT, PadEdgeMark, PadShapeOutline, PadShapeWords } from "./PadMarks";

const ImageEl = ({
  image,
  pal,
  href,
}: {
  readonly image: PadImage;
  readonly pal: PadSvgPalette;
  readonly href: string | undefined;
}) =>
  href ? (
    <image
      href={href}
      x={image.x}
      y={image.y}
      width={image.w}
      height={image.h}
      preserveAspectRatio="xMidYMid meet"
    />
  ) : (
    <g>
      <rect
        x={image.x}
        y={image.y}
        width={image.w}
        height={image.h}
        fill={pal.fill}
        stroke={pal.stroke}
        strokeWidth={1}
      />
      <text
        x={image.x + 8}
        y={image.y + 16}
        fill={pal.dim}
        fontSize={10}
        fontFamily={FONT}
      >
        {padClipText(padImageLabel(image))}
      </text>
    </g>
  );

const InkEl = ({
  ink,
  pal,
}: {
  readonly ink: PadInk;
  readonly pal: PadSvgPalette;
}) => (
  <path
    d={strokePath(ink.points, ink.width)}
    fill="none"
    stroke={padInkStroke(ink.color, pal)}
    strokeWidth={ink.width}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

export function PadSvg({
  pad,
  theme = "dark",
  options,
}: {
  readonly pad: Pad;
  readonly theme?: ThemeMode;
  readonly options?: PadSvgOptions;
}) {
  const pal = padSvgPalette(theme);
  const box = padSvgViewRect(pad, options?.viewBox, options?.padding);
  const hrefs = options?.hrefs;
  const size = options?.framed
    ? { preserveAspectRatio: "xMidYMid meet" as const }
    : { width: box.w, height: box.h };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      fontFamily={FONT}
      {...size}
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill={pal.ground}
      />
      {padElementsByZ(pad.images).map((image) => (
        <ImageEl
          key={image.id}
          image={image}
          pal={pal}
          href={hrefs?.[image.id]}
        />
      ))}
      {pad.edges.map((edge) => {
        const points = edgePoints(pad, edge);
        return points ? <PadEdgeMark key={edge.id} edge={edge} points={points} pal={pal} /> : null;
      })}
      {padElementsByZ(pad.shapes).map((shape) => (
        <g key={shape.id}>
          <PadShapeOutline shape={shape} pal={pal} />
          <PadShapeWords shape={shape} pal={pal} />
        </g>
      ))}
      {padElementsByZ(pad.inks).map((ink) => (
        <InkEl key={ink.id} ink={ink} pal={pal} />
      ))}
    </svg>
  );
}
