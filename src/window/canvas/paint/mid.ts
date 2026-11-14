/**
 * The mid tier's compact seat pill: at 0.46 to 0.62 a full 216 board shell is
 * mostly empty black bar around 13px words (5 to 8px on screen). The pill hugs
 * the name, and a fresh 16px name reads at 7.5 to 10px. The ring stays where
 * it always is; only the shell and its text column move.
 */

import type { CardView, PaintEnv, QuadStyle, Rect, TextRun } from "../contract";
import { at, tok } from "./refs";
import { SEAT, SEAT_BOX, SEAT_RING_CENTRE, SEAT_TEXT } from "./card-spec";

/** The mid name: larger than the near 13 board so it stays legible when held. */
export const MID_NAME_SIZE = 16;
export const MID_NAME_HEIGHT = MID_NAME_SIZE * SEAT.snug;
/** The narrowest pill that still holds the 52 ring and a short name. */
export const MID_MIN_WIDTH = 108;
/** The enqueue plus and the gap before it, when a task board carries one. */
export const MID_ENQUEUE = 20;
export const MID_ENQUEUE_GAP = 4;

export const midNameRun = (name: string, width: number): TextRun => ({
  text: name,
  font: "mono",
  size: MID_NAME_SIZE,
  weight: 600,
  leading: SEAT.snug,
  truncate: "end",
  width,
});

/** The compact pill is a real surface: a quiet raise fill and a hairline border. */
export const midShellStyle = (view: CardView): QuadStyle => {
  if (view.selected) return { fill: { kind: "flat", color: tok("raise", 0.94) }, stroke: { color: tok("main", 0.55), width: 1 } };
  if (view.hovered) return { fill: { kind: "flat", color: tok("raise", 0.9) }, stroke: { color: tok("stroke"), width: 1 } };
  return { fill: { kind: "flat", color: tok("raise", 0.88) }, stroke: { color: tok("stroke", 0.55), width: 1 } };
};

export type MidSeatLayout = {
  /** The compact shell, in the card's own board units. */
  readonly shell: Rect;
  /** The name's box, centred on the ring. */
  readonly name: Rect;
  /** Where the enqueue pill begins, when the card carries one. */
  readonly enqueueX: number;
};

/** The mid pill's geometry: content width, measured name and enqueue end. */
export const midSeatLayout = (name: string, enqueue: boolean, env: PaintEnv): MidSeatLayout => {
  const full = env.measure(midNameRun(name, SEAT_BOX.width));
  const enqueueWidth = enqueue ? MID_ENQUEUE_GAP + MID_ENQUEUE : 0;
  const maxName = Math.max(0, SEAT_BOX.width - SEAT_TEXT.x - SEAT.rowRight - enqueueWidth);
  // Two spare board units of transparent gutter: the last glyph is never
  // clipped and never samples the atlas cell next door.
  const nameWidth = Math.min(Math.ceil(full) + 2, maxName);
  const width = Math.min(
    SEAT_BOX.width,
    Math.max(MID_MIN_WIDTH, Math.ceil(SEAT_TEXT.x + nameWidth + enqueueWidth + SEAT.rowRight)),
  );
  return {
    shell: at(0, 0, width, SEAT_BOX.height),
    name: at(SEAT_TEXT.x, SEAT_RING_CENTRE.y - MID_NAME_HEIGHT / 2, nameWidth, MID_NAME_HEIGHT),
    enqueueX: SEAT_TEXT.x + nameWidth + MID_ENQUEUE_GAP,
  };
};
