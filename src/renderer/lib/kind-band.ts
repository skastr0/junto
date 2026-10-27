import { MARK_PHASE_MS, RING_FRAME_MS } from "@shared/wire/rings";
import { themeRuntime, type ThemeMode } from "@shared/theme";
import type { KindIconKind } from "@shared/kind-icon";
import { SeatUrgency, type ViewGroup } from "@shared/wire/urgency";

// The ledger band: the static art around a kind's ring that says what the kind holds (task states,
// artifact ticks, tabs, commits), baked as parts the way the ring's own parts are. A band has its
// still art and, in a moving state, at most one moving part. A moving part turns or fades with
// transform and opacity alone, never anything that repaints, and its period is a whole number of
// ring frames that divides the ring's phase cycle, so band and ring stay in step across nodes and
// screens (the part takes its delay from the ring's clock, --mark-t0). Colours come from theme
// tokens through themeRuntime; nothing here is a second palette.

/**
 * The states a kind seat says are the seat's own: the seat rail's groups (urgency.ts), so a kind and
 * a seat can never disagree about what resting, waiting on you, blocked, working, done or offline
 * mean. `review` reads as waiting.
 */
export type KindState = ViewGroup<typeof SeatUrgency>;
const U = SeatUrgency.group;

/** What a kind holds, as counts the card already reads. Absent fields draw as zero. */
export type KindLedger =
  | { readonly kind: "task"; readonly finished: number; readonly open: number; readonly asks: number; readonly stuck: number; readonly backlog: number }
  | { readonly kind: "artifacts"; readonly count: number }
  | { readonly kind: "automations"; readonly on: number; readonly off: number; readonly failed: number }
  | { readonly kind: "page"; readonly tabs: number }
  | { readonly kind: "git"; readonly commits?: number };

/** The moving parts a band may have, by name. */
export type BandMotion = "chase" | "shimmer" | "hand" | "scan" | "orbit" | "blink" | "blink-fast" | "pulse" | "breathe" | "ripple" | "glint" | "shake";

/** Ring frames per band period: each divides 896, the ring's phase cycle. */
export const BAND_PERIOD_FRAMES: Readonly<Record<BandMotion, number>> = {
  chase: 112,
  shimmer: 64,
  hand: 128,
  scan: 32,
  orbit: 56,
  blink: 14,
  "blink-fast": 8,
  pulse: 16,
  breathe: 32,
  ripple: 32,
  glint: 28,
  shake: 8,
};

export const BAND_PERIOD_MS: Readonly<Record<BandMotion, number>> = Object.fromEntries(
  (Object.keys(BAND_PERIOD_FRAMES) as BandMotion[]).map((name) => [name, BAND_PERIOD_FRAMES[name] * RING_FRAME_MS]),
) as Record<BandMotion, number>;

/** One layer of the band: still art, or the one moving part. */
export type BandLayer = { readonly svg: string; readonly motion?: BandMotion };

/** The band's box, in the ring mark's units: the 52 seat cell. */
export const BAND_BOX = 52;
const CENTRE = BAND_BOX / 2;
const R = 24.1;
const W = 2.3;

const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180;
const at = (r: number, deg: number): readonly [number, number] => [CENTRE + r * Math.cos(rad(deg)), CENTRE + r * Math.sin(rad(deg))];
const n = (v: number): string => v.toFixed(2);

type ArcOptions = { readonly w?: number; readonly r?: number; readonly dash?: string; readonly opacity?: number; readonly cap?: string };
const arc = (from: number, to: number, color: string, o: ArcOptions = {}): string => {
  const r = o.r ?? R;
  const [x0, y0] = at(r, from);
  const [x1, y1] = at(r, to);
  return `<path d="M${n(x0)} ${n(y0)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}" fill="none" stroke="${color}" stroke-width="${o.w ?? W}" stroke-linecap="${o.cap ?? "round"}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}${o.opacity === undefined ? "" : ` opacity="${o.opacity}"`}/>`;
};
const dot = (deg: number, color: string, r = 2.3, ring = R): string => {
  const [x, y] = at(ring, deg);
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${color}"/>`;
};
const tick = (deg: number, color: string, from = 21.8, to = 25.2, w = 2.2): string => {
  const [x0, y0] = at(from, deg);
  const [x1, y1] = at(to, deg);
  return `<path d="M${n(x0)} ${n(y0)}L${n(x1)} ${n(y1)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
};
const alpha = (hex: string, a: number): string => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;

/** Each kind's colours: body (the kind's hue) and spark (its accent), as theme tokens. */
export const KIND_BAND_HUES: Readonly<Record<KindIconKind, { readonly body: string; readonly spark: string }>> = {
  task: { body: "green", spark: "amber" },
  artifacts: { body: "violet", spark: "gold" },
  automations: { body: "amber", spark: "cyan" },
  page: { body: "indigo", spark: "cyan" },
  terminal: { body: "steel", spark: "green" },
  git: { body: "orange", spark: "violet" },
  file: { body: "gold", spark: "violet" },
  link: { body: "cyan", spark: "orange" },
  note: { body: "gold", spark: "orange" },
};

const runtime = (mode: ThemeMode): Record<string, string> => themeRuntime(mode);
const RUNTIME: Partial<Record<ThemeMode, Record<string, string>>> = {};
const tokens = (mode: ThemeMode): Record<string, string> => (RUNTIME[mode] ??= runtime(mode));

/** Task arcs: finished, open, asking for you, stuck, backlog, as parts of a turn; a finished board is all finished. */
const taskParts = (state: KindState, ledger: Extract<KindLedger, { kind: "task" }> | undefined): readonly (readonly [string, number])[] => {
  if (state === U.done) return [["finished", 1]];
  const l = ledger ?? { kind: "task" as const, finished: 0, open: 0, asks: 0, stuck: 0, backlog: 0 };
  return [["finished", l.finished], ["open", l.open], ["asks", l.asks], ["stuck", l.stuck], ["backlog", l.backlog]];
};

/**
 * The band's layers for a kind in a state, in the theme. Still layers first; at most one layer has
 * a motion. States that do not move (idle, off, and a held blocked or done) have none.
 */
export function kindBandLayers(kind: KindIconKind, state: KindState, mode: ThemeMode, ledger?: KindLedger): readonly BandLayer[] {
  return layersOf(kind, state, mode, ledger).filter((layer) => layer.svg !== "");
}

function layersOf(kind: KindIconKind, shown: KindState, mode: ThemeMode, ledger?: KindLedger): readonly BandLayer[] {
  const state = shown === U.review ? U.waiting : shown;
  const t = tokens(mode);
  const hues = KIND_BAND_HUES[kind];
  const P = t[hues.body]!, S = t[hues.spark]!;
  const AMBER = t.amber!, CRIMSON = t.crimson!, GREEN = t.green!, CYAN = t.cyan!, INK = t.ink!, STEEL = t.steel!;
  const track: BandLayer = { svg: arc(0, 359.9, alpha(INK, 0.1), { w: 1.6 }) };
  const tone = state === U.waiting ? AMBER : state === U.blocked ? CRIMSON : state === U.done ? GREEN : P;
  const dim = state === U.resting || state === U.offline ? 0.55 : 1;
  const moving = (svg: string, motion: BandMotion): BandLayer => ({ svg, motion });

  switch (kind) {
    case "task": {
      const led = ledger?.kind === "task" ? ledger : undefined;
      const parts = taskParts(state, led);
      const total = parts.reduce((s, p) => s + p[1], 0) || 1;
      const colour: Record<string, string> = { finished: GREEN, open: P, asks: AMBER, stuck: CRIMSON, backlog: STEEL };
      let at0 = 0;
      let art = "";
      let hot = "";
      for (const [name, count] of parts) {
        if (count <= 0) continue;
        const span = (count / total) * 360;
        const op = name === "finished" ? 0.45 : 1;
        art += arc(at0 + 4, at0 + span - 4, colour[name]!, { opacity: op, dash: name === "backlog" ? "0.1 4.6" : undefined });
        if (name === "asks" || name === "stuck") hot += arc(at0 + 4, at0 + span - 4, colour[name]!, { w: 3.2 });
        at0 += span;
      }
      const out: BandLayer[] = [track, { svg: art }];
      if (state === U.waiting || state === U.blocked) out.push(moving(hot, "pulse"));
      if (state === U.working) out.push(moving(arc(0, 70, alpha(INK, 0.9), { w: 3.2 }) + arc(70, 100, alpha(INK, 0.35), { w: 2.8 }), "chase"));
      if (state === U.done) out.push(moving(arc(0, 359, alpha(GREEN, 0.5), { w: 3.6 }), "glint"));
      return out;
    }
    case "artifacts": {
      const count = Math.max(0, Math.min(ledger?.kind === "artifacts" ? ledger.count : 9, 24));
      let ticks = "";
      let newest = "";
      for (let i = 0; i < count; i += 1) {
        const deg = (i * 360) / Math.max(count, 1) + 10;
        const col = state === U.blocked ? CRIMSON : state === U.waiting && i === count - 1 ? AMBER : state === U.done ? GREEN : P;
        ticks += tick(deg, col);
        if (i === count - 1) newest = tick(deg, state === U.waiting ? AMBER : S, 21.4, 25.4, 3.4);
      }
      const out: BandLayer[] = [track, { svg: ticks }];
      if (state === U.waiting) out.push(moving(newest, "pulse"));
      if (state === U.working) out.push(moving(arc(0, 40, alpha(INK, 0.55), { w: 3.2 }), "shimmer"));
      if (state === U.done) out.push(moving(arc(0, 359.9, alpha(GREEN, 0.7), { w: 2, r: 25.2 }), "ripple"));
      return out;
    }
    case "automations": {
      const led = ledger?.kind === "automations" ? ledger : { on: 2, off: 1, failed: 0 };
      const slots = Math.max(1, Math.min(led.on + led.off + led.failed, 8));
      let dots = "";
      let hot = "";
      for (let i = 0; i < slots; i += 1) {
        const deg = (i * 360) / slots;
        const failed = i >= led.on + led.off;
        const on = i < led.on;
        const bad = state === U.blocked && i === slots - 1;
        if (bad || failed) { dots += dot(deg, CRIMSON, 3); if (bad) hot = dot(deg, CRIMSON, 3.8); }
        else if (on) dots += dot(deg, state === U.done ? GREEN : AMBER, 3);
        else dots += `<circle cx="${n(at(R, deg)[0])}" cy="${n(at(R, deg)[1])}" r="2.7" fill="none" stroke="${alpha(INK, 0.45)}" stroke-width="1.5"/>`;
      }
      if (state === U.waiting) hot = dot((Math.max(slots - 1, 0) * 360) / slots, AMBER, 3.8);
      const hand = `<path d="M${CENTRE} ${CENTRE}L${CENTRE} 8" stroke="${state === U.waiting ? AMBER : S}" stroke-width="2.2" stroke-linecap="round"/><circle cx="${CENTRE}" cy="${CENTRE}" r="2" fill="${state === U.waiting ? AMBER : S}"/>`;
      const out: BandLayer[] = [track, { svg: dots }];
      if (state === U.waiting) out.push(moving(hot, "pulse"));
      if (state === U.blocked) out.push(moving(hot, "shake"));
      if (state === U.working) out.push(moving(hand, "hand"));
      return out;
    }
    case "page": {
      const tabs = Math.max(1, Math.min(ledger?.kind === "page" ? ledger.tabs : 3, 6));
      const span = 360 / tabs;
      let art = "";
      for (let i = 0; i < tabs; i += 1) {
        const col = state === U.blocked ? CRIMSON : state === U.done ? GREEN : state === U.waiting && i === 0 ? AMBER : P;
        art += arc(i * span + 8, (i + 1) * span - 8, col, { opacity: i === 0 ? 1 : 0.55 });
      }
      const out: BandLayer[] = [track, { svg: art }];
      if (state === U.working) out.push(moving(arc(0, 46, CYAN, { w: 3.2 }) + arc(46, 78, alpha(CYAN, 0.3), { w: 2.8 }), "scan"));
      if (state === U.waiting) out.push(moving(arc(8, span - 8, AMBER, { w: 3.2 }), "pulse"));
      if (state === U.done) out.push(moving(dot(300, GREEN, 3.4), "pulse"));
      return out;
    }
    case "terminal": {
      const body = arc(14, 346, state === U.blocked ? CRIMSON : state === U.done ? alpha(GREEN, 0.9) : alpha(STEEL, 0.9));
      const cursor = (col: string): string => `<rect x="${CENTRE - 3}" y="1" width="6" height="4.2" rx="1" fill="${col}"/>`;
      const out: BandLayer[] = [track, { svg: body }];
      if (state === U.working) out.push(moving(cursor(GREEN), "blink"));
      else if (state === U.waiting) out.push(moving(cursor(AMBER), "blink-fast"));
      else out.push({ svg: cursor(state === U.blocked ? CRIMSON : state === U.done ? GREEN : alpha(GREEN, 0.5)) });
      return out;
    }
    case "git": {
      const commits = [20, 100, 170, 230];
      const beads = commits.map((d, i) => dot(d, state === U.blocked && i === 2 ? CRIMSON : state === U.done ? GREEN : P, 2.4)).join("") + dot(300, state === U.waiting ? AMBER : S, 3.4);
      const out: BandLayer[] = [track, { svg: arc(20, 300, alpha(P, 0.35), { w: 1.5 }) }, { svg: beads }];
      if (state === U.waiting || state === U.done) out.push(moving(dot(300, state === U.waiting ? AMBER : S, 4.6), "pulse"));
      if (state === U.working) out.push(moving(dot(0, alpha(INK, 0.95), 2.4), "orbit"));
      return out;
    }
    case "file": {
      const out: BandLayer[] = [track, { svg: arc(20, 290, tone, { opacity: dim }) }];
      if (state === U.working || state === U.waiting || state === U.done) out.push(moving(arc(20, 290, tone, { w: 3.4 }), "breathe"));
      return out;
    }
    case "link": {
      const out: BandLayer[] = [track, { svg: arc(20, 160, tone, { opacity: dim }) + arc(200, 340, tone, { opacity: dim }) }];
      if (state === U.working || state === U.waiting) out.push(moving(dot(180, state === U.waiting ? AMBER : S, 3) + dot(0, state === U.waiting ? AMBER : S, 3), "pulse"));
      return out;
    }
    case "note": {
      const col = state === U.blocked ? CRIMSON : state === U.done ? GREEN : P;
      const dots = Array.from({ length: 14 }, (_, i) => dot(i * (360 / 14) + 12, col, 1.4)).join("");
      const out: BandLayer[] = [track, { svg: dots }];
      if (state === U.working || state === U.waiting) out.push(moving(dot(0, state === U.waiting ? AMBER : S, 3.4), "pulse"));
      return out;
    }
  }
}

/** A layer's art as a CSS background value. */
export const bandBackground = (svg: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${String(BAND_BOX)} ${String(BAND_BOX)}'>${svg}</svg>`)}")`;

/** Every band period divides the ring's phase cycle, so band and ring share one clock. */
export const bandPeriodsDivideThePhase = (): boolean =>
  (Object.values(BAND_PERIOD_MS) as number[]).every((ms) => MARK_PHASE_MS % ms === 0);
