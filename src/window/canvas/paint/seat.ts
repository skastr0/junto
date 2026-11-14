/**
 * The agent seat (inventory 2.1) at every tier and in every state: facts in,
 * quads out. Near: shell, ring with band and parts, portrait, harness badge,
 * crest, name, one line, task strip, preamble bubble. Mid: the shell and the
 * name only. Far and overview: the shell is gone and the ring and portrait are
 * held at a screen size by the `seat` scale rule; the name tag shows on hover
 * or selection and the urgency halo says call, wait and halt.
 */

import { TONE_TEXT, accentRef, at, grow, shadow, shape, sprite, text, tok } from "./refs";
import type { CardFact, CardPaint, CardView, PaintEnv, Quad, QuadStyle, ScaleRule, SeatLive, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { BADGE, CREST, FAR, FLAG_HIT, FOCUS, LIFT_PX, SEAT, SEAT_BOX, SEAT_RING_CENTRE, SEAT_TEXT } from "./card-spec";
import { dimOf, reachQuads } from "./overlays";
import { bubbleQuads } from "./bubble";
import { harnessSprite, portraitSprite } from "./images";
import { ringQuads } from "./motion";

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const FAR_UP = TIER_BIT.far | TIER_BIT.overview;
const NEAR = TIER_BIT.near;

const shellStyle = (view: CardView): QuadStyle => {
  if (view.selected) return { fill: { kind: "flat", color: tok("raise", 0.94) }, stroke: { color: tok("main", 0.55), width: 1 } };
  if (view.hovered) return { fill: { kind: "flat", color: tok("raise", 0.9) }, stroke: { color: tok("stroke"), width: 1 } };
  return { fill: { kind: "flat", color: tok("ground", 0.72) }, stroke: { color: tok("ground", 0), width: 1 } };
};

const run = (value: string, extra: Partial<TextRun>): TextRun => ({
  text: value,
  font: "mono",
  size: SEAT.lineSize,
  weight: 400,
  leading: SEAT.snug,
  truncate: "end",
  width: SEAT_TEXT.width,
  ...extra,
});

/** The seat's one line, in the parts `seatSaying` gives it. */
const lineQuads = (live: SeatLive, y: number, env: PaintEnv): ReadonlyArray<Quad> => {
  const h = SEAT.lineSize * SEAT.snug;
  const saying = live.saying ?? { kind: "plain" as const };
  const base = { z: 40, tiers: NEAR };
  const line = (k: string, x: number, width: number, value: string, ink: ReturnType<typeof tok>, extra: Partial<TextRun> = {}, dy = 0): Quad =>
    text({ key: `line.${k}`, z: base.z, rect: at(x, y + dy, width, h) }, { ink }, { tiers: base.tiers, text: run(value, { width, ...extra }) });
  const tone = saying.tone as keyof typeof TONE_TEXT | undefined;
  const toneInk = tone !== undefined && tone in TONE_TEXT ? tok(TONE_TEXT[tone]) : tok("dim");
  const rest = (lead: Quad | undefined, x: number, width: number, value: string, ink: ReturnType<typeof tok>): ReadonlyArray<Quad> =>
    lead === undefined ? [line("text", x, width, value, ink)] : [lead, line("text", x, width, value, ink)];
  if (saying.kind === "signal" && saying.lead !== undefined) {
    const leadRun = run(saying.lead, { weight: 600 });
    const used = Math.min(SEAT_TEXT.width, env.measure(leadRun) + env.measure(run(" ", {})));
    const lead = line("lead", SEAT_TEXT.x, used, saying.lead, toneInk, { weight: 600 });
    return rest(lead, SEAT_TEXT.x + used, Math.max(0, SEAT_TEXT.width - used), live.line, tok("dim"));
  }
  if (saying.kind === "failure") return rest(undefined, SEAT_TEXT.x, SEAT_TEXT.width, live.line, tok("amber-fg"));
  if (saying.kind === "reading") {
    const prefix = run("AI", { font: "display", size: SEAT.aiSize, tracking: SEAT.aiTracking });
    // `mr-1` after the prefix, raised 1px by `align-[1px]`.
    const used = Math.min(SEAT_TEXT.width, env.measure(prefix) + 4);
    const lead = line("ai", SEAT_TEXT.x, used, "AI", tok("faint"), { font: "display", size: SEAT.aiSize, tracking: SEAT.aiTracking }, -1);
    return rest(lead, SEAT_TEXT.x + used, Math.max(0, SEAT_TEXT.width - used), live.line, saying.stale === true ? tok("faint") : tok("dim"));
  }
  return rest(undefined, SEAT_TEXT.x, SEAT_TEXT.width, live.line, tone !== undefined ? toneInk : tok("dim"));
};

/** A seat's text block is centred in the 52 high row: name, line, and the task strip when it has one. */
const blockTop = (rows: number, captionRow: boolean): number => {
  const h = SEAT.nameSize * SEAT.snug + (rows > 1 ? SEAT.lineSize * SEAT.snug : 0) + (captionRow ? SEAT.captionSize * SEAT.snug : 0);
  return SEAT_RING_CENTRE.y - h / 2;
};

export const paintSeat = (fact: CardFact, live: SeatLive | undefined, view: CardView, env: PaintEnv): CardPaint => {
  const id = fact.id;
  const row = fact.row;
  const cap = fact.derived.ringCap ?? 1;
  const ringScale: ScaleRule = { kind: "seat", cap, anchor: SEAT_RING_CENTRE };
  const ringRect = at(SEAT.rowLeft, SEAT.rowTop, SEAT.ring, SEAT.ring);
  const name = row.kind === "agent" ? row.label : "";
  const quads: Quad[] = [];
  const box = at(0, 0, SEAT_BOX.width, SEAT_BOX.height);

  // --- shell: near and mid; the far seat has none --------------------------------
  if (view.selected) {
    // The drop is ``0 8px 22px``: the quad grows past the card so the blur
    // has room, and the card itself is the hole no layer paints inside.
    quads.push(
      shadow(
        { key: "shell.shadow", z: 0, rect: grow(box, SEAT.shadowInset) },
        { shadow: { name: "seat" } },
        { tiers: NEAR, radii: SEAT.radii, hole: SEAT.shadowInset },
      ),
    );
  }
  quads.push(shape({ key: "shell", z: 1, rect: box }, shellStyle(view), { tiers: NEAR_MID, radii: SEAT.radii }));
  if (view.keyboardFocus) {
    quads.push(
      shape(
        { key: "focus", z: 2, rect: grow(box, FOCUS.offset) },
        { stroke: { color: tok("cyan"), width: FOCUS.width, outside: true } },
        { tiers: NEAR_MID, radii: FOCUS.radius + FOCUS.offset },
      ),
    );
  }

  // --- ring, portrait, badge, crest: every tier, the ring held at far -----------
  if (live) {
    const rings = ringQuads(live.ring, live.ringSince, ringRect, ringScale, "ring", 10);
    quads.push(...rings.under);
    const p = live.portrait ?? { seed: id };
    const portraitRect = at(SEAT.rowLeft + (SEAT.ring - SEAT.portrait) / 2, SEAT.rowTop + (SEAT.ring - SEAT.portrait) / 2, SEAT.portrait, SEAT.portrait);
    quads.push(
      sprite(
        { key: "portrait", z: 20, rect: portraitRect },
        { scale: ringScale, sprite: portraitSprite(p.seed, view.mode, SEAT.portrait, p.expression, p.config), shape: "disc" },
      ),
    );
    quads.push(...rings.over);
    if (live.harness !== undefined) {
      const bx = portraitRect.x + BADGE.offset;
      const by = portraitRect.y + BADGE.offset;
      const badgeRect = at(bx, by, BADGE.size, BADGE.size);
      quads.push(
        shape(
          { key: "badge.plate", z: 50, rect: grow(badgeRect, BADGE.plate) },
          { fill: { kind: "flat", color: tok("raise") } },
          { tiers: NEAR, radii: BADGE.radius + BADGE.plate },
        ),
        sprite({ key: "badge", z: 51, rect: badgeRect }, { tiers: NEAR, sprite: harnessSprite(live.harness, BADGE.size) }),
      );
    }
    if (live.overseer) {
      const ringCentreX = SEAT.rowLeft + SEAT.ring / 2;
      quads.push(
        sprite(
          { key: "crest", z: 55, rect: at(ringCentreX - CREST.width / 2, SEAT.rowTop + CREST.dy, CREST.width, CREST.height) },
          { scale: ringScale, sprite: { atlas: "glyph", name: "overseer-crest" }, style: { ink: tok("indigo") } },
        ),
      );
    }
    if (live.ring.flag !== undefined) {
      quads.push(
        shape(
          { key: "flag.hit", z: 56, rect: at(SEAT.rowLeft + SEAT.ring - FLAG_HIT, SEAT.rowTop, FLAG_HIT, FLAG_HIT) },
          {},
          { tiers: NEAR, part: { kind: "ringFlag" }, scale: ringScale },
        ),
      );
    }
  }

  // --- text: near name, line, strip; mid name ------------------------------------
  const hasStrip = live?.tasks !== undefined;
  const top = blockTop(2, hasStrip);
  if (!view.editing) {
    quads.push(
      text(
        { key: "name", z: 40, rect: at(SEAT_TEXT.x, top, SEAT_TEXT.width, SEAT.nameSize * SEAT.snug) },
        { ink: accentRef(live?.nameColor, "ink") },
        { tiers: NEAR, text: run(name, { size: SEAT.nameSize, weight: 600 }) },
      ),
      // Mid shows the name alone, so the text block is the name and sits at the ring's centre.
      text(
        { key: "name.mid", z: 40, rect: at(SEAT_TEXT.x, SEAT_RING_CENTRE.y - (SEAT.nameSize * SEAT.snug) / 2, SEAT_TEXT.width, SEAT.nameSize * SEAT.snug) },
        { ink: accentRef(live?.nameColor, "ink") },
        { tiers: TIER_BIT.mid, text: run(name, { size: SEAT.nameSize, weight: 600 }) },
      ),
    );
  }
  if (live) {
    quads.push(...lineQuads(live, top + SEAT.nameSize * SEAT.snug, env));
    if (live.tasks) {
      const ty = top + SEAT.nameSize * SEAT.snug + SEAT.lineSize * SEAT.snug;
      const th = SEAT.captionSize * SEAT.snug;
      const glyph = 9;
      quads.push(
        sprite(
          { key: "task.mark", z: 41, rect: at(SEAT_TEXT.x, ty + (th - glyph) / 2, glyph, glyph) },
          { tiers: NEAR, sprite: { atlas: "glyph", name: `task-state:${live.tasks.state}` }, style: { ink: tok("ink") } },
        ),
      );
      const small = { font: "body" as const, size: SEAT.captionSize };
      const labelX = SEAT_TEXT.x + glyph + 4;
      const labelW = Math.min(SEAT_TEXT.width, env.measure(run(live.tasks.label, { ...small, tabular: true })));
      const moreText = live.tasks.more > 0 ? `+${String(live.tasks.more)}` : undefined;
      const moreW = moreText === undefined ? 0 : env.measure(run(moreText, { ...small, tabular: true })) + 4;
      quads.push(
        text({ key: "task.label", z: 41, rect: at(labelX, ty, labelW, th) }, { ink: tok("ink") }, { tiers: NEAR, text: run(live.tasks.label, { ...small, tabular: true, width: labelW }) }),
      );
      const titleX = labelX + labelW + 4;
      const titleW = Math.max(0, SEAT_TEXT.x + SEAT_TEXT.width - titleX - moreW);
      quads.push(
        text({ key: "task.title", z: 41, rect: at(titleX, ty, titleW, th) }, { ink: tok("ink") }, { tiers: NEAR, text: run(live.tasks.title, { ...small, width: titleW }) }),
      );
      if (moreText !== undefined) {
        quads.push(
          text({ key: "task.more", z: 41, rect: at(titleX + titleW + 4, ty, moreW - 4, th) }, { ink: tok("ink") }, { tiers: NEAR, text: run(moreText, { ...small, tabular: true, truncate: "none", width: moreW }) }),
        );
      }
    }
  }

  // --- far and overview: the halo, hover and selection rings, and the name tag ---
  if (live) {
    const ring = live.ring.ring;
    if (ring === "call" || ring === "wait" || ring === "halt") {
      const hue = ring === "halt" ? "crimson" : "amber";
      quads.push(
        shape({ key: "halo.outer", z: 5, rect: ringRect }, { stroke: { color: tok(hue, FAR.halo.outerAlpha), width: FAR.halo.outer, outside: true } }, { tiers: FAR_UP, shape: "disc", scale: ringScale }),
        shape({ key: "halo.inner", z: 6, rect: ringRect }, { stroke: { color: tok(hue, FAR.halo.innerAlpha), width: FAR.halo.inner, outside: true } }, { tiers: FAR_UP, shape: "disc", scale: ringScale }),
      );
    }
  }
  if (view.selected || view.hovered) {
    const spec = view.selected ? FAR.selected : FAR.hover;
    const color = view.selected ? tok("main", spec.alpha) : tok("ink", spec.alpha);
    quads.push(
      shape(
        { key: "far.outline", z: 7, rect: grow(ringRect, spec.offset) },
        { stroke: { color, width: spec.width, outside: true } },
        { tiers: FAR_UP, shape: "disc", scale: ringScale },
      ),
    );
    // The name tag: padding 1px 8px 2px, border 1, radius 6, up to 220 wide, under the ring.
    const nameRun = run(name, { size: SEAT.nameSize, weight: 600, align: "center" });
    const t = FAR.tag;
    const textW = Math.min(t.maxWidth - t.padX * 2 - t.border * 2, env.measure(nameRun));
    const width = textW + t.padX * 2 + t.border * 2;
    const height = SEAT.nameSize * SEAT.snug + t.padTop + t.padBottom + t.border * 2;
    const tagRect = at(SEAT_RING_CENTRE.x - width / 2, SEAT_RING_CENTRE.y + SEAT.ring / 2 + t.gapUnits, width, height);
    const tagScale: ScaleRule = { kind: "seatTag", cap, anchor: SEAT_RING_CENTRE };
    quads.push(
      shape(
        { key: "tag", z: 60, rect: tagRect },
        { fill: { kind: "flat", color: tok("raise") }, stroke: { color: tok("stroke"), width: t.border } },
        { tiers: FAR_UP, radii: t.radius, scale: tagScale, band: "lifted" },
      ),
      text(
        { key: "tag.name", z: 61, rect: at(tagRect.x + t.border + t.padX, tagRect.y + t.border + t.padTop, textW, SEAT.nameSize * SEAT.snug) },
        { ink: tok("ink") },
        { tiers: FAR_UP, scale: tagScale, band: "lifted", text: { ...nameRun, width: textW } },
      ),
    );
  }

  // --- bubble, reach, focus roots -------------------------------------------------
  if (live?.preamble !== undefined) quads.push(...bubbleQuads(live.preamble, box, env));
  quads.push(...reachQuads(view, box, env));

  return { quads, dim: dimOf(view), lift: view.hovered && !view.dragging ? LIFT_PX : 0 };
};

