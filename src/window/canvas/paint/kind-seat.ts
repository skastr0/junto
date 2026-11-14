/**
 * The kind seat (inventory 2.2): terminal, task, artifacts, automations, page,
 * git, files, link and a file that is not an image. The seat's own ring
 * grammar around the kind's icon, a ledger band outside the ring, the name and
 * one line. Near: shell, ring, band, icon, name, line, strip, enqueue. Mid: the
 * shell and the name only, centred on the ring. Far and overview: the ring and
 * icon held by the `seat` scale rule, the band gone, the name tag on hover or
 * selection, the urgency halo for call, wait and halt.
 */

import { resolveActivityGlyph } from "@shared/seat-activity";
import { ringState, type ActivityTone, type RingState } from "@shared/wire/rings";
import type { KindIconKind } from "@shared/kind-icon";
import type { KindLedger, KindState } from "../../lib/kind-band";
import type { CardFact, CardPaint, CardView, KindLive, PaintEnv, Quad, QuadStyle, ScaleRule, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { FAR, FOCUS, KIND_SHELL_RADII, LIFT_PX, SEAT, SEAT_BOX, SEAT_RING_CENTRE, SEAT_TEXT } from "./card-spec";
import { bandSprites, kindIconSprite } from "./images";
import { bandMotion, ringQuads } from "./motion";
import { dimOf, reachQuads } from "./overlays";
import { at, fade, grow, mixOf, shadow, shape, sprite, text, tok } from "./refs";

const NEAR = TIER_BIT.near;
const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const FAR_UP = TIER_BIT.far | TIER_BIT.overview;

/** `--kind-hue` (kind-seat.css). */
export const KIND_HUE: Readonly<Record<string, string>> = {
  task: "green",
  artifacts: "violet",
  automations: "amber",
  page: "indigo",
  terminal: "steel",
  git: "orange",
  files: "blue",
  file: "gold",
  link: "cyan",
  note: "gold",
};

/** `kindRing(state)`: the seat's own tones and motion, resolved the way the atlas resolves them. */
export const kindRingState = (state: KindLive["state"]): RingState => {
  const spec: { mode: "wave" | "pulse" | "static"; tone: ActivityTone; glyph?: "off" } =
    state === "working"
      ? { mode: "wave", tone: "cyan" }
      : state === "waiting" || state === "review"
        ? { mode: "wave", tone: "amber" }
        : state === "blocked"
          ? { mode: "wave", tone: "crimson" }
          : state === "done"
            ? { mode: "pulse", tone: "green" }
            : state === "offline"
              ? { mode: "static", tone: "steel", glyph: "off" }
              : { mode: "static", tone: "steel" };
  return ringState({ glyph: resolveActivityGlyph(spec.mode, spec.tone, spec.glyph), tone: spec.tone });
};

/** `lineTone`: the words take a hue's text form. */
const lineInk = (state: KindLive["state"]): string =>
  state === "working" ? "cyan-fg" : state === "waiting" || state === "review" ? "amber-fg" : state === "blocked" ? "crimson-fg" : state === "done" ? "green" : state === "offline" ? "faint" : "dim";

const LABEL = 10;
const GLYPH = 9;
const ENQUEUE = 20;
const ENQUEUE_GAP = 4;

const run = (value: string, extra: Partial<TextRun>): TextRun => ({
  text: value,
  font: "mono",
  size: LABEL,
  weight: 400,
  leading: SEAT.snug,
  truncate: "end",
  width: SEAT_TEXT.width,
  ...extra,
});

const shellStyle = (hue: string, view: CardView): QuadStyle => {
  if (view.selected) return { fill: { kind: "flat", color: mixOf(tok(hue), tok("raise"), 0.1) }, stroke: { color: fade(tok(hue), 0.6), width: 1 } };
  if (view.hovered) return { fill: { kind: "flat", color: tok("raise", 0.9) }, stroke: { color: tok("stroke"), width: 1 } };
  return { fill: { kind: "flat", color: tok("ground", 0.72) }, stroke: { color: tok("ground", 0), width: 1 } };
};

/** The card a kind draws when it is not bound: the default shell and one plain line (inventory 2.2, line 103). */
const unboundQuads = (fact: CardFact, live: KindLive, view: CardView): ReadonlyArray<Quad> => {
  const box = at(0, 0, SEAT_BOX.width, SEAT_BOX.height);
  const kind = fact.row.kind;
  const faint = kind === "page";
  const size = faint ? 12 : 11;
  const out: Quad[] = [];
  if (view.selected) out.push(shadow({ key: "shell.shadow", z: 0, rect: box }, { shadow: { name: "card-lift" } }, { tiers: NEAR, radii: 10 }));
  else out.push(shadow({ key: "shell.shadow", z: 0, rect: box }, { shadow: { name: "card" } }, { tiers: NEAR, radii: 10 }));
  out.push(
    shape(
      { key: "shell", z: 1, rect: box },
      {
        fill: { kind: "gradient", angle: 135, from: tok("raise", 0.94), to: tok("ground", 0.96) },
        stroke: { color: view.selected ? tok("main", 0.75) : tok("stroke"), width: 1 },
      },
      { tiers: NEAR_MID, radii: 10 },
    ),
    text(
      { key: "unbound", z: 40, rect: at(15, 13, SEAT_BOX.width - 30, size * 1.375) },
      { ink: tok(faint ? "faint" : "dim") },
      { tiers: NEAR_MID, text: run(live.line, { size, font: "body", leading: 1.375, width: SEAT_BOX.width - 30 }) },
    ),
    // Far: a tinted box and the kind's glyph (inventory 3, remaining cards).
    shape({ key: "far.box", z: 1, rect: box }, { fill: { kind: "flat", color: tok("ink", 0.05) } }, { tiers: TIER_BIT.far }),
    sprite(
      { key: "far.glyph", z: 2, rect: at((SEAT_BOX.width - 33.6) / 2, (SEAT_BOX.height - 33.6) / 2, 33.6, 33.6) },
      { tiers: TIER_BIT.far, sprite: { atlas: "glyph", name: `kind-glyph:${kind}` }, style: { ink: tok("ink", 0.38) } },
    ),
  );
  if (view.selected) {
    out.push(shape({ key: "far.selected", z: 3, rect: grow(box, 2) }, { stroke: { color: tok("main", 0.7), width: 4, outside: true } }, { tiers: TIER_BIT.far }));
  }
  return out;
};

export const paintKindSeat = (fact: CardFact, view: CardView, env: PaintEnv): CardPaint => {
  const live = fact.kind;
  const kind = fact.row.kind as KindIconKind;
  const box = at(0, 0, SEAT_BOX.width, SEAT_BOX.height);
  if (live === undefined) return { quads: [], dim: dimOf(view), lift: 0 };
  if (live.unbound === true) {
    return { quads: [...unboundQuads(fact, live, view), ...reachQuads(view, box, env, false)], dim: dimOf(view), lift: 0 };
  }

  const hue = KIND_HUE[kind] ?? "steel";
  const cap = fact.derived.ringCap ?? 1;
  const ringScale: ScaleRule = { kind: "seat", cap, anchor: SEAT_RING_CENTRE };
  const ringRect = at(SEAT.rowLeft, SEAT.rowTop, SEAT.ring, SEAT.ring);
  const iconRect = at(SEAT.rowLeft + (SEAT.ring - SEAT.portrait) / 2, SEAT.rowTop + (SEAT.ring - SEAT.portrait) / 2, SEAT.portrait, SEAT.portrait);
  const state: KindState = live.state as KindState;
  const quads: Quad[] = [];

  // --- shell, near and mid -----------------------------------------------------
  if (view.selected) quads.push(shadow({ key: "shell.shadow", z: 0, rect: box }, { shadow: { name: "seat" } }, { tiers: NEAR, radii: KIND_SHELL_RADII }));
  quads.push(shape({ key: "shell", z: 1, rect: box }, shellStyle(hue, view), { tiers: NEAR_MID, radii: KIND_SHELL_RADII }));
  if (view.keyboardFocus) {
    quads.push(
      shape(
        { key: "focus", z: 2, rect: grow(box, FOCUS.offset) },
        { stroke: { color: tok("cyan"), width: FOCUS.width, outside: true } },
        { tiers: NEAR_MID, radii: FOCUS.radius + FOCUS.offset },
      ),
    );
  }
  if (live.dropTarget === true) {
    quads.push(
      shape(
        { key: "drop", z: 3, rect: at(2, 2, SEAT_BOX.width - 4, SEAT_BOX.height - 4) },
        { fill: { kind: "flat", color: tok("cyan", 0.08) }, stroke: { color: tok("cyan"), width: 1, dash: [4, 3] } },
        { tiers: NEAR_MID, radii: 6 },
      ),
    );
  }

  // --- ring, band, icon ----------------------------------------------------------
  const rings = ringQuads(kindRingState(live.state), live.stateSince ?? 0, ringRect, ringScale, "ring", 10);
  quads.push(...rings.under);
  const layers = bandSprites(kind, state, view.mode, live.ledger as KindLedger | undefined);
  layers.forEach((layer, index) => {
    quads.push(
      sprite(
        { key: `band.${String(index)}`, z: 15 + index * 0.1, rect: ringRect },
        { tiers: NEAR_MID, sprite: layer.sprite, ...(layer.motion ? { motion: bandMotion(layer.motion) } : {}) },
      ),
    );
  });
  quads.push(sprite({ key: "icon", z: 20, rect: iconRect }, { scale: ringScale, sprite: kindIconSprite(kind, view.mode, SEAT.portrait), shape: "disc" }));
  quads.push(...rings.over);

  // --- text: near name, line, strip; mid the name alone, centred on the ring ----
  const nameH = SEAT.nameSize * SEAT.snug;
  const lineH = LABEL * SEAT.snug;
  const stripH = SEAT.captionSize * SEAT.snug;
  const rowH = live.enqueue === true ? Math.max(nameH, ENQUEUE) : nameH;
  const blockH = rowH + lineH + (live.tasks ? stripH : 0);
  const top = SEAT_RING_CENTRE.y - blockH / 2;
  const nameRun = (width: number): TextRun => run(live.name, { size: SEAT.nameSize, weight: 600, width });
  const avail = live.enqueue === true ? SEAT_TEXT.width - ENQUEUE - ENQUEUE_GAP : SEAT_TEXT.width;
  const nameW = (): number => Math.min(avail, env.measure(nameRun(4096)));
  if (!view.editing) {
    const w = live.enqueue === true ? nameW() : SEAT_TEXT.width;
    quads.push(
      text({ key: "name", z: 40, rect: at(SEAT_TEXT.x, top + (rowH - nameH) / 2, w, nameH) }, { ink: tok("ink") }, { tiers: NEAR, text: nameRun(w) }),
      text(
        { key: "name.mid", z: 40, rect: at(SEAT_TEXT.x, SEAT_RING_CENTRE.y - nameH / 2, SEAT_TEXT.width, nameH) },
        { ink: tok("ink") },
        { tiers: TIER_BIT.mid, text: nameRun(SEAT_TEXT.width) },
      ),
    );
  }
  if (live.enqueue === true) {
    const x = SEAT_TEXT.x + nameW() + ENQUEUE_GAP;
    const y = top + (rowH - ENQUEUE) / 2;
    quads.push(
      shape({ key: "enqueue", z: 42, rect: at(x, y, ENQUEUE, ENQUEUE) }, {}, { tiers: NEAR, radii: 999, part: { kind: "taskEnqueue" } }),
      sprite({ key: "enqueue.plus", z: 43, rect: at(x + (ENQUEUE - 11) / 2, y + (ENQUEUE - 11) / 2, 11, 11) }, { tiers: NEAR, sprite: { atlas: "glyph", name: "plus" }, style: { ink: tok("amber") } }),
    );
  }
  quads.push(
    text(
      { key: "line", z: 40, rect: at(SEAT_TEXT.x, top + rowH, SEAT_TEXT.width, lineH) },
      { ink: tok(lineInk(live.state)) },
      { tiers: NEAR, text: run(live.line, { size: LABEL }) },
    ),
  );
  if (live.tasks) {
    const ty = top + rowH + lineH;
    const small = { font: "body" as const, size: SEAT.captionSize };
    const labelX = SEAT_TEXT.x + GLYPH + 4;
    const labelW = Math.min(SEAT_TEXT.width, env.measure(run(live.tasks.label, { ...small, tabular: true })));
    const moreText = live.tasks.more > 0 ? `+${String(live.tasks.more)}` : undefined;
    const moreW = moreText === undefined ? 0 : env.measure(run(moreText, { ...small, tabular: true })) + 4;
    const titleX = labelX + labelW + 4;
    const titleW = Math.max(0, SEAT_TEXT.x + SEAT_TEXT.width - titleX - moreW);
    quads.push(
      sprite({ key: "task.mark", z: 41, rect: at(SEAT_TEXT.x, ty + (stripH - GLYPH) / 2, GLYPH, GLYPH) }, { tiers: NEAR, sprite: { atlas: "glyph", name: `task-state:${live.tasks.state}` }, style: { ink: tok("ink") } }),
      text({ key: "task.label", z: 41, rect: at(labelX, ty, labelW, stripH) }, { ink: tok("ink") }, { tiers: NEAR, text: run(live.tasks.label, { ...small, tabular: true, width: labelW }) }),
      text({ key: "task.title", z: 41, rect: at(titleX, ty, titleW, stripH) }, { ink: tok("ink") }, { tiers: NEAR, text: run(live.tasks.title, { ...small, width: titleW }) }),
    );
    if (moreText !== undefined) {
      quads.push(
        text({ key: "task.more", z: 41, rect: at(titleX + titleW + 4, ty, moreW - 4, stripH) }, { ink: tok("ink") }, { tiers: NEAR, text: run(moreText, { ...small, tabular: true, truncate: "none", width: moreW }) }),
      );
    }
  }

  // --- far and overview: halo, outlines, name tag --------------------------------
  const form = kindRingState(live.state).ring;
  if (form === "call" || form === "wait" || form === "halt") {
    const h = form === "halt" ? "crimson" : "amber";
    quads.push(
      shape({ key: "halo.outer", z: 5, rect: ringRect }, { stroke: { color: tok(h, FAR.halo.outerAlpha), width: FAR.halo.outer, outside: true } }, { tiers: FAR_UP, shape: "disc", scale: ringScale }),
      shape({ key: "halo.inner", z: 6, rect: ringRect }, { stroke: { color: tok(h, FAR.halo.innerAlpha), width: FAR.halo.inner, outside: true } }, { tiers: FAR_UP, shape: "disc", scale: ringScale }),
    );
  }
  if (view.selected || view.hovered) {
    const spec = view.selected ? FAR.selected : FAR.hover;
    quads.push(
      shape(
        { key: "far.outline", z: 7, rect: grow(ringRect, spec.offset) },
        { stroke: { color: view.selected ? tok("main", spec.alpha) : tok("ink", spec.alpha), width: spec.width, outside: true } },
        { tiers: FAR_UP, shape: "disc", scale: ringScale },
      ),
    );
    const t = FAR.tag;
    const tagRun = nameRun(4096);
    const textW = Math.min(t.maxWidth - t.padX * 2 - t.border * 2, env.measure(tagRun));
    const width = textW + t.padX * 2 + t.border * 2;
    const height = nameH + t.padTop + t.padBottom + t.border * 2;
    const tagRect = at(SEAT_RING_CENTRE.x - width / 2, SEAT_RING_CENTRE.y + SEAT.ring / 2 + t.gapUnits, width, height);
    const tagScale: ScaleRule = { kind: "seatTag", cap, anchor: SEAT_RING_CENTRE };
    quads.push(
      shape(
        { key: "tag", z: 60, rect: tagRect },
        { fill: { kind: "flat", color: tok("raise") }, stroke: { color: tok("stroke"), width: t.border } },
        { tiers: FAR_UP, radii: t.radius, scale: tagScale, band: "lifted" },
      ),
      text(
        { key: "tag.name", z: 61, rect: at(tagRect.x + t.border + t.padX, tagRect.y + t.border + t.padTop, textW, nameH) },
        { ink: tok("ink") },
        { tiers: FAR_UP, scale: tagScale, band: "lifted", text: { ...tagRun, align: "center", width: textW } },
      ),
    );
  }
  quads.push(...reachQuads(view, box, env));
  return { quads, dim: dimOf(view), lift: view.hovered && !view.dragging ? LIFT_PX : 0 };
};
