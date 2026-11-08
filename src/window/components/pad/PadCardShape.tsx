import { memo } from "react";
import { mentionRefOf, parseMentionHref, type MentionRef } from "@shared/mention";
import type { PadShape } from "@shared/pad";
import { usePreviewFace } from "../../lib/use-preview-face";
import { nodeAt } from "../../lib/use-model";
import { PreviewCard } from "../embeds/PreviewCard";
import "./pad-card.css";

/** What a card shape names on this canvas now, or undefined when the node is gone or names nothing. */
export const padCardRef = (shape: Pick<PadShape, "href">, canvasName: string): MentionRef | undefined => {
  const target = shape.href === undefined ? undefined : parseMentionHref(shape.href);
  return target === undefined ? undefined : mentionRefOf(target, (id) => nodeAt(canvasName, id)?.kind);
};

/**
 * A card shape on the pad: the shared preview card, live, in the shape's box. It sits in the pad's
 * camera group, so it moves and zooms with the pad, and it takes no pointer: the pad's own hit
 * test selects, moves, resizes and connects it as any shape, and a double-click opens what it
 * names. A card whose thing is gone or out of reach is drawn missing under its label.
 */
export const PadCardShape = memo(function PadCardShape({
  shape,
  canvasName,
  selected,
}: {
  readonly shape: PadShape;
  readonly canvasName: string;
  readonly selected: boolean;
}) {
  const ref = padCardRef(shape, canvasName);
  const face = usePreviewFace(ref, canvasName, shape.label ?? shape.href ?? "");
  return (
    <foreignObject
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      className="pad-card-shape"
      data-testid="pad-card"
      data-shape-id={shape.id}
      data-selected={selected ? "true" : undefined}
    >
      <PreviewCard {...face} size="card" />
    </foreignObject>
  );
});
