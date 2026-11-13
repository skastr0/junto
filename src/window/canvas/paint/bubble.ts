/**
 * The preamble bubble (`preamble-bubble.css`, `PreambleBubbleView.tsx`): above
 * a seat at near, in the lifted band, tail on the portrait ring.
 */

import type { Quad, Rect, SeatLive, TextRun, PaintEnv } from "../contract";
import { TIER_BIT } from "../contract";
import { BUBBLE, SEAT_RING_CENTRE } from "./card-spec";
import { at, mixOf, shadow, shape, sprite, text, tok } from "./refs";

type Preamble = NonNullable<SeatLive["preamble"]>;

const GLYPH = 15;
const GAP = 6;
const CLOSE = 15;
const NOW_LEADING = 15;
const BEFORE_LEADING = 14;

const nowRun = (value: string, width: number): TextRun => ({ text: value, font: "mono", size: 11, weight: 400, leading: NOW_LEADING / 11, truncate: "clamp2", width });
const beforeRun = (value: string, width: number): TextRun => ({ text: value, font: "mono", size: 10, weight: 400, leading: BEFORE_LEADING / 10, truncate: "end", width });

export const bubbleQuads = (p: Preamble, seat: Rect, env: PaintEnv): ReadonlyArray<Quad> => {
  const { padding, radius } = BUBBLE;
  const border = 1;
  const textMax = BUBBLE.maxWidth - border * 2 - padding.left - padding.right - GLYPH - GAP - 2 - CLOSE;
  const who = p.speaker === undefined ? "" : `${p.speaker} `;
  const nowFull = who + p.now;
  const nowW = Math.min(textMax, env.measure({ ...nowRun(nowFull, 4096), truncate: "none" }));
  const beforeW = p.before === undefined ? 0 : Math.min(textMax, env.measure({ ...beforeRun(p.before, 4096), truncate: "none" }));
  const textW = Math.max(nowW, beforeW, 1);
  const nowLines = env.measure({ ...nowRun(nowFull, 4096), truncate: "none" }) > textMax ? 2 : 1;
  const innerW = GLYPH + GAP + textW + 2 + CLOSE;
  const width = Math.min(BUBBLE.maxWidth, innerW + padding.left + padding.right + border * 2);
  const lines = nowLines * NOW_LEADING + (p.before === undefined ? 0 : BEFORE_LEADING + 3);
  const height = lines + padding.top + padding.bottom + border * 2;
  const x = seat.x + BUBBLE.leftBase + p.dx;
  const y = seat.y - BUBBLE.gap - height;
  const card = at(x, y, width, height);
  const hue = tok(p.hue);
  const mix = p.strong === true ? 0.55 : 0.3;
  const wash = p.strong === true ? 0.09 : 0.04;
  const fill = { kind: "flat", color: mixOf(hue, tok("raise"), wash) } as const;
  const stroke = { color: mixOf(hue, tok("stroke"), mix), width: border };
  const tiers = TIER_BIT.near;
  const base = { tiers, band: "lifted" as const };
  const out: Quad[] = [
    shadow({ key: "bubble.shadow", z: 80, rect: card }, { shadow: { name: "bubble" } }, { ...base, radii: radius }),
    shape({ key: "bubble", z: 81, rect: card }, { fill, stroke }, { ...base, radii: radius }),
  ];
  // The tail: a 9px square turned 45 degrees, centre 0.5 below the card's lower edge.
  const tailX = seat.x + Math.max(8, SEAT_RING_CENTRE.x - 12 - p.dx) + 4.5;
  const diag = 9 * Math.SQRT2;
  out.push(
    shape(
      { key: "bubble.tail", z: 82, rect: at(tailX - diag / 2, y + height - diag / 2 + 0.5, diag, diag / 2 + 0.5) },
      { fill, stroke: { color: stroke.color, width: border } },
      { ...base, shape: "triangle", flip: true },
    ),
  );
  const innerX = x + border + padding.left;
  let innerY = y + border + padding.top;
  if (p.before !== undefined) {
    out.push(
      sprite({ key: "bubble.before.glyph", z: 83, rect: at(innerX, innerY, GLYPH, BEFORE_LEADING) }, { ...base, style: { ink: hue, opacity: 0.5 }, sprite: { atlas: "glyph", name: p.glyph ?? "preamble" } }),
      text(
        { key: "bubble.before", z: 83, rect: at(innerX + GLYPH + GAP, innerY, textW, BEFORE_LEADING) },
        { ink: tok("dim"), opacity: 0.5 },
        { ...base, text: beforeRun(p.before, textW) },
      ),
    );
    innerY += BEFORE_LEADING + 3;
  }
  const rise = { kind: "rise", since: p.since } as const;
  out.push(
    sprite({ key: "bubble.glyph", z: 84, rect: at(innerX, innerY, GLYPH, GLYPH) }, { ...base, motion: rise, style: { ink: hue }, sprite: { atlas: "glyph", name: p.glyph ?? "preamble" } }),
  );
  let cx = innerX + GLYPH + GAP;
  if (p.speaker !== undefined) {
    const whoRun: TextRun = { ...nowRun(p.speaker, 4096), weight: 600, truncate: "none" };
    const w = env.measure(whoRun) + 0.6 * 6.6;
    out.push(
      text({ key: "bubble.who", z: 84, rect: at(cx, innerY, w, NOW_LEADING) }, { ink: hue }, { ...base, motion: rise, text: { ...whoRun, width: w } }),
    );
    cx += w;
  }
  const rest = Math.max(1, innerX + GLYPH + GAP + textW - cx);
  out.push(
    text({ key: "bubble.now", z: 84, rect: at(cx, innerY, rest, nowLines * NOW_LEADING) }, { ink: tok("ink") }, { ...base, motion: rise, text: nowRun(p.now, rest) }),
    shape(
      { key: "bubble.close", z: 85, rect: at(x + width - border - padding.right - CLOSE, y + border + padding.top, CLOSE, CLOSE) },
      {},
      { ...base, part: { kind: "bubbleClose" } },
    ),
  );
  return out;
};
