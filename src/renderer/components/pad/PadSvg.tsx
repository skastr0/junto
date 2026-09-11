/**
 * Structural pad SVG for the privileged renderer. Pad strings never become
 * markup here — paint is resolved to hex/`none` or a trusted theme default.
 * Serialized `padToSvg` remains for pad.read / CLI / look-here export only.
 */
import type { Pad, PadImage, PadInk, PadPin, PadShape } from "@shared/pad";
import {
  edgePoints,
  lookHereBounds,
  strokePath,
  trianglePoints,
} from "@shared/pad-geom";
import {
  LOOK_HERE_MARGIN,
  padClipText,
  padElementsByZ,
  padImageLabel,
  padInkStroke,
  padShapeFill,
  padShapeStroke,
  padSvgPalette,
  padSvgViewRect,
  type PadSvgOptions,
  type PadSvgPalette,
} from "@shared/pad-project";
import type { ThemeMode } from "@shared/theme";

const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

const ShapeEl = ({
  shape,
  pal,
}: {
  readonly shape: PadShape;
  readonly pal: PadSvgPalette;
}) => {
  const fill = padShapeFill(shape, pal);
  const stroke = padShapeStroke(shape, pal);
  const common = { fill, stroke, strokeWidth: 1 };
  if (shape.type === "ellipse") {
    return (
      <ellipse
        cx={shape.x + shape.w / 2}
        cy={shape.y + shape.h / 2}
        rx={shape.w / 2}
        ry={shape.h / 2}
        {...common}
      />
    );
  }
  if (shape.type === "triangle") {
    const [a, b, c] = trianglePoints(shape);
    return (
      <polygon points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`} {...common} />
    );
  }
  return (
    <rect
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      {...common}
    />
  );
};

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

const PinEl = ({ pin, pal }: { readonly pin: PadPin; readonly pal: PadSvgPalette }) => (
  <g>
    {pin.bounds ? (
      (() => {
        const crop = lookHereBounds(pin, LOOK_HERE_MARGIN);
        return (
          <rect
            x={crop.x}
            y={crop.y}
            width={crop.w}
            height={crop.h}
            fill="none"
            stroke={pal.dim}
            strokeDasharray="4 3"
            opacity={0.6}
          />
        );
      })()
    ) : null}
    <circle cx={pin.x} cy={pin.y} r={5} fill={pal.amber} />
  </g>
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
        if (!points) return null;
        const mid = points[Math.floor(points.length / 2)] ?? points[0]!;
        return (
          <g key={edge.id}>
            <path
              d={strokePath(points, 1.5)}
              fill="none"
              stroke={pal.steel}
              strokeWidth={1.5}
            />
            {edge.label ? (
              <text
                x={mid.x}
                y={mid.y}
                fill={pal.dim}
                fontSize={10}
                textAnchor="middle"
                fontFamily={FONT}
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
      {padElementsByZ(pad.shapes).map((shape) => (
        <g key={shape.id}>
          <ShapeEl shape={shape} pal={pal} />
          {shape.text ? (
            <text
              x={shape.x + 8}
              y={shape.y + 16}
              fill={pal.text}
              fontSize={12}
              fontFamily={FONT}
            >
              {padClipText(shape.text)}
            </text>
          ) : null}
        </g>
      ))}
      {padElementsByZ(pad.inks).map((ink) => (
        <InkEl key={ink.id} ink={ink} pal={pal} />
      ))}
      {pad.pins.map((pin) => (
        <PinEl key={pin.id} pin={pin} pal={pal} />
      ))}
    </svg>
  );
}
