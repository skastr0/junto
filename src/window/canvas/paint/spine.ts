/**
 * The spine card, peer and stub only (inventory 2.3): a head chip, a status
 * tag, a leaf line or a spine of rows. Near and mid draw it whole, with no
 * shell of its own; far draws a held disc with the kind's glyph and a status
 * pip; overview hides it. Words carry a ground halo. A stub is the same card
 * at 0.72 opacity; a peer wears a 20 unit portrait disc holding its first
 * letter in place of the glyph.
 *
 * Far geometry (documented choice): the disc is 26 board units at the card's
 * top left, scaled by the `node` rule about that corner. `--node-s` is at
 * least 1.6 at far, so `max(28px, 26px * s)` is always `26 * s`. The cap by
 * the node's width (`100cqw`) is not applied.
 */

import type { ColorRef, CardFact, CardPaint, CardView, PaintEnv, Quad, QuadStyle, ScaleRule, SpineLive, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import { BORDER } from "@shared/theme";
import { dimOf, focusQuads, reachQuads } from "./overlays";
import { at, grow, shape, sprite, text, tok } from "./refs";

const NEAR_MID = TIER_BIT.near | TIER_BIT.mid;
const FAR = TIER_BIT.far;

/** `SPINE_ROWS_MAX`. */
export const SPINE_ROWS_MAX = 4;

const CHIP = { height: 28, padLeft: 9, padRight: 11, gap: 7, glyph: 15, border: 1, maxCard: 320, headGap: 8 } as const;
const TAG = { height: 22, padLeft: 7, padRight: 8, gap: 5, border: BORDER.bold, shape: 8 } as const;
const LEAF = { x: 15, marginTop: 5 } as const;
const SPINE = { x: 15, marginTop: 6, padTop: 3, padBottom: 2, gap: 7, border: BORDER.bold, pad: 16, tick: 11 } as const;
const PORTRAIT = { size: 20, marginLeft: -4 } as const;
const NAME = 12;
const COUNT = 11;
const LABEL = 10;
const BODY = 11;
const COMPACT = 1.2;
const DISC = { size: 26, glyph: 14, pip: 11, pipTriangle: [15, 13], pipOffset: 3 } as const;

const GLYPH_INK: Readonly<Record<string, string>> = {
  green: "green",
  violet: "violet",
  amber: "amber-fg",
  indigo: "indigo",
  orange: "orange",
  cyan: "cyan-fg",
  steel: "steel",
  dim: "dim",
};

type Look = { readonly shape: "triangle" | "dot" | "arc" | "ring"; readonly tone: "crimson" | "amber" | "cyan" | "faint" };

/** `spineStatusLook`: every status is a shape and a word, never colour alone. */
export const spineLook = (status: SpineLive["status"]): Look | undefined => {
  switch (status) {
    case "blocked":
    case "failed":
      return { shape: "triangle", tone: "crimson" };
    case "needs-you":
      return { shape: "dot", tone: "amber" };
    case "working":
      return { shape: "arc", tone: "cyan" };
    case "off":
    case "retired":
      return { shape: "ring", tone: "faint" };
    default:
      return undefined;
  }
};

const TAG_INK: Readonly<Record<Look["tone"], { readonly border: string; readonly ink: string }>> = {
  crimson: { border: "crimson", ink: "crimson-fg" },
  amber: { border: "amber", ink: "amber-fg" },
  cyan: { border: "cyan", ink: "cyan-fg" },
  faint: { border: "faint", ink: "dim" },
};

const run = (value: string, size: number, extra: Partial<TextRun> = {}): TextRun => ({
  text: value,
  font: "mono",
  size,
  weight: 400,
  leading: COMPACT,
  truncate: "end",
  width: 4096,
  ...extra,
});

export const paintSpine = (fact: CardFact, view: CardView, env: PaintEnv): CardPaint => {
  const live = fact.spine;
  const row = fact.row;
  const nodeW = row.width;
  const box = at(0, 0, nodeW, row.height);
  if (live === undefined) return { quads: [], dim: dimOf(view), lift: 0 };
  const stub = row.kind === "stub";
  const peer = row.kind === "peer";
  const look = spineLook(live.status);
  const out: Quad[] = [];
  const cardMax = Math.max(nodeW, CHIP.maxCard);
  const measure = (value: string, size: number, extra: Partial<TextRun> = {}): number => env.measure(run(value, size, extra));

  // --- chip ----------------------------------------------------------------------
  const iconW = peer ? PORTRAIT.size + PORTRAIT.marginLeft : CHIP.glyph;
  const nameX = CHIP.padLeft + iconW + CHIP.gap;
  const nameFull = measure(live.name, NAME, { weight: 600 });
  const countText = live.count;
  const countW = countText === undefined ? 0 : measure(countText, COUNT, { weight: 600, tabular: true });
  const countSpace = countText === undefined ? 0 : CHIP.gap + countW;
  const chipNatural = nameX + nameFull + countSpace + CHIP.padRight;
  const chipW = Math.min(chipNatural, cardMax);
  const nameW = Math.max(0, chipW - nameX - countSpace - CHIP.padRight);
  const chip = at(0, 0, chipW, CHIP.height);
  const dashed = live.dashed;

  const chipStyle = (): QuadStyle => {
    const color: ColorRef = view.selected ? tok("main") : view.hovered ? tok("stroke-hi") : dashed ? tok("dim") : tok("stroke");
    const stroke = { color, width: CHIP.border, ...(dashed ? { dash: [4, 3] as const } : {}) };
    return dashed ? { stroke } : { fill: { kind: "flat", color: tok("overlay-3") }, stroke };
  };
  if (view.selected) {
    out.push(shape({ key: "chip.ring", z: 1, rect: grow(chip, 1) }, { stroke: { color: tok("main"), width: 1, outside: false } }, { tiers: NEAR_MID, radii: 999 }));
  }
  out.push(shape({ key: "chip", z: 2, rect: chip }, chipStyle(), { tiers: NEAR_MID, radii: 999 }));
  if (view.keyboardFocus) {
    out.push(shape({ key: "focus", z: 3, rect: grow(chip, 3) }, { stroke: { color: tok("cyan"), width: BORDER.heavy, outside: true } }, { tiers: NEAR_MID, radii: 999 }));
  }
  if (peer) {
    const d = at(CHIP.padLeft + PORTRAIT.marginLeft, (CHIP.height - PORTRAIT.size) / 2, PORTRAIT.size, PORTRAIT.size);
    out.push(
      shape({ key: "portrait", z: 4, rect: d }, { stroke: { color: tok("dim"), width: 1, dash: [3, 2] } }, { tiers: NEAR_MID, shape: "disc" }),
      text(
        { key: "portrait.letter", z: 5, rect: d },
        { ink: tok("ink-2") },
        { tiers: NEAR_MID, text: run(live.name.charAt(0), LABEL, { weight: 700, align: "center", truncate: "none", width: PORTRAIT.size }) },
      ),
    );
  } else {
    out.push(
      sprite(
        { key: "glyph", z: 5, rect: at(CHIP.padLeft, (CHIP.height - CHIP.glyph) / 2, CHIP.glyph, CHIP.glyph) },
        { tiers: NEAR_MID, sprite: { atlas: "glyph", name: live.glyph }, style: { ink: tok(GLYPH_INK[live.hue] ?? "dim") } },
      ),
    );
  }
  out.push(
    text(
      { key: "name", z: 6, rect: at(nameX, (CHIP.height - NAME * COMPACT) / 2, nameW, NAME * COMPACT) },
      { ink: tok("ink") },
      { tiers: NEAR_MID, text: run(live.name, NAME, { weight: 600, width: nameW }) },
    ),
  );
  if (countText !== undefined) {
    out.push(
      text(
        { key: "count", z: 6, rect: at(nameX + nameW + CHIP.gap, (CHIP.height - COUNT * COMPACT) / 2, countW, COUNT * COMPACT) },
        { ink: tok("dim") },
        { tiers: NEAR_MID, text: run(countText, COUNT, { weight: 600, tabular: true, truncate: "none", width: countW }) },
      ),
    );
  }

  // --- status tag ----------------------------------------------------------------
  if (look !== undefined && live.tag !== undefined) {
    const ink = TAG_INK[look.tone];
    const tagRun = run(live.tag, LABEL, { font: "body", weight: 700, tracking: 0.04, upper: true, halo: true, truncate: "none" });
    const tw = env.measure(tagRun);
    const width = TAG.border * 2 + TAG.padLeft + TAG.shape + TAG.gap + tw + TAG.padRight;
    const x = chipW + CHIP.headGap;
    const rect = at(x, (CHIP.height - TAG.height) / 2, width, TAG.height);
    out.push(shape({ key: "tag", z: 2, rect }, { stroke: { color: tok(ink.border), width: TAG.border } }, { tiers: NEAR_MID, radii: 999 }));
    const sx = x + TAG.border + TAG.padLeft;
    const sy = rect.y + (TAG.height - TAG.shape) / 2;
    const sr = at(sx, sy, TAG.shape, TAG.shape);
    if (look.shape === "triangle") out.push(shape({ key: "tag.shape", z: 3, rect: sr }, { fill: { kind: "flat", color: tok("crimson") } }, { tiers: NEAR_MID, shape: "triangle" }));
    else if (look.shape === "dot") out.push(shape({ key: "tag.shape", z: 3, rect: sr }, { fill: { kind: "flat", color: tok("amber") } }, { tiers: NEAR_MID, shape: "disc" }));
    else out.push(shape({ key: "tag.shape", z: 3, rect: sr }, { stroke: { color: tok(ink.border), width: BORDER.bold } }, { tiers: NEAR_MID, shape: "disc" }));
    out.push(
      text(
        { key: "tag.word", z: 3, rect: at(sx + TAG.shape + TAG.gap, rect.y + (TAG.height - LABEL * COMPACT) / 2, tw, LABEL * COMPACT) },
        { ink: tok(ink.ink) },
        { tiers: NEAR_MID, text: { ...tagRun, width: tw } },
      ),
    );
  }

  // --- leaf and spine ------------------------------------------------------------
  if (live.leaf !== undefined) {
    const width = Math.max(0, nodeW - LEAF.x);
    out.push(
      text(
        { key: "leaf", z: 6, rect: at(LEAF.x, CHIP.height + LEAF.marginTop, width, LABEL * COMPACT) },
        { ink: tok("dim") },
        { tiers: NEAR_MID, text: run(live.leaf, LABEL, { halo: true, truncate: live.leafTail === true ? "head" : "end", width }) },
      ),
    );
  }
  if (live.meta !== undefined || live.rows.length > 0) {
    const rows = live.rows.slice(0, SPINE_ROWS_MAX);
    const more = (live.more ?? 0) + Math.max(0, live.rows.length - SPINE_ROWS_MAX);
    type Item = { readonly key: string; readonly value: string; readonly size: number; readonly ink: string };
    const items: Item[] = [];
    if (live.meta !== undefined) items.push({ key: "meta", value: live.meta, size: LABEL, ink: "dim" });
    rows.forEach((value, i) => items.push({ key: `row.${String(i)}`, value, size: BODY, ink: "ink-2" }));
    if (more > 0) items.push({ key: "more", value: `+${String(more)} more`, size: LABEL, ink: "dim" });
    const top = CHIP.height + SPINE.marginTop;
    const textX = SPINE.x + SPINE.border + SPINE.pad;
    const width = Math.max(0, nodeW - SPINE.x - SPINE.border - SPINE.pad);
    let y = top + SPINE.padTop;
    for (const [i, item] of items.entries()) {
      const h = item.size * COMPACT;
      out.push(
        shape(
          { key: `${item.key}.tick`, z: 5, rect: at(SPINE.x + SPINE.border, y + h / 2 - SPINE.border / 2, SPINE.tick, SPINE.border) },
          { fill: { kind: "flat", color: tok("stroke-hi") } },
          { tiers: NEAR_MID },
        ),
        text({ key: item.key, z: 6, rect: at(textX, y, width, h) }, { ink: tok(item.ink) }, { tiers: NEAR_MID, text: run(item.value, item.size, { halo: true, width }) }),
      );
      y += h + (i === items.length - 1 ? 0 : SPINE.gap);
    }
    const bottom = y + SPINE.padBottom;
    out.push(
      shape(
        { key: "spine", z: 4, rect: at(SPINE.x, top, SPINE.border, bottom - top) },
        { fill: { kind: "flat", color: tok("stroke-hi") } },
        { tiers: NEAR_MID },
      ),
    );
  }

  // --- far: a held disc, its glyph and the status pip ---------------------------
  const nodeScale: ScaleRule = { kind: "node", anchor: { x: 0, y: 0 } };
  const disc = at(0, 0, DISC.size, DISC.size);
  const tone = look?.tone;
  const discStroke =
    tone === "crimson" || tone === "amber"
      ? { color: tok(tone), width: BORDER.heavy }
      : { color: tok("ink", 0.55), width: BORDER.bold };
  const farOpts = { tiers: FAR, scale: nodeScale };
  out.push(
    shape({ key: "far.disc", z: 2, rect: disc }, { stroke: discStroke }, { ...farOpts, shape: "disc" }),
    sprite(
      { key: "far.glyph", z: 3, rect: at((DISC.size - DISC.glyph) / 2, (DISC.size - DISC.glyph) / 2, DISC.glyph, DISC.glyph) },
      { ...farOpts, sprite: peer ? { atlas: "glyph", name: "peer" } : { atlas: "glyph", name: live.glyph }, style: { ink: tok("ink", 0.78) } },
    ),
  );
  if (view.selected) {
    out.push(shape({ key: "far.selected", z: 1, rect: grow(disc, 2) }, { stroke: { color: tok("main"), width: BORDER.heavy, outside: true } }, { ...farOpts, shape: "disc" }));
  }
  if (view.keyboardFocus) {
    out.push(shape({ key: "far.focus", z: 1, rect: grow(disc, 3) }, { stroke: { color: tok("cyan"), width: BORDER.heavy, outside: true } }, { ...farOpts, shape: "disc" }));
  }
  if (look !== undefined && tone !== undefined) {
    const o = DISC.pipOffset;
    if (look.shape === "triangle") {
      const [pw, ph] = DISC.pipTriangle;
      out.push(shape({ key: "far.pip", z: 4, rect: at(DISC.size + o - pw!, -o, pw!, ph!) }, { fill: { kind: "flat", color: tok("crimson") } }, { ...farOpts, shape: "triangle" }));
    } else {
      const rect = at(DISC.size + o - DISC.pip, -o, DISC.pip, DISC.pip);
      const solid = tone === "amber";
      out.push(
        shape(
          { key: "far.pip", z: 4, rect },
          solid
            ? { fill: { kind: "flat", color: tok("amber") }, stroke: { color: tok("ground"), width: BORDER.bold, outside: true } }
            : { stroke: { color: tok(tone === "cyan" ? "cyan" : "faint"), width: BORDER.heavy } },
          { ...farOpts, shape: "disc" },
        ),
      );
    }
  }

  // --- stub, reach, focus --------------------------------------------------------
  const quads: Quad[] = stub ? out.map((q) => ({ ...q, style: { ...q.style, opacity: (q.style.opacity ?? 1) * 0.72 } })) : out;
  quads.push(...reachQuads(view, box, env, true));
  quads.push(...focusQuads(view, box, 0));
  return { quads, dim: dimOf(view), lift: 0 };
};

