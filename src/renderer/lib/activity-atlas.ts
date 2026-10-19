/**
 * ActivityMark sprite atlas: every frame of every ring, painted once per
 * theme into one canvas, served to the page as a single data URL.
 *
 * A mark on screen is one element whose background points into this atlas:
 * still rings, the outer band, and the rest pose a moving ring shows while
 * motion is paused. A moving ring is baked here as still parts (RING_MOTION
 * in activity-rings.ts): its base is the mark's own background, and the part
 * that turns or pulses is a child the compositor animates with transform and
 * opacity alone. Nothing is repainted per frame and the main thread never
 * runs the motion.
 *
 * Layers (20-unit box; see ActivityMark.tsx and activity-rings.ts):
 *   ring     control state, bent by the thread-health reading when it is trouble
 *   band     outside the ring: the waiting glow, the good-health halo, and the
 *            declared-signal flag, baked together into one overlay cell that
 *            the mark's ::after draws over the ring
 */

import type { ThemeMode } from "@shared/theme";
import type { AgentSignalKind } from "@shared/agent-signals";
import {
  LAND_FRAMES,
  RING_CYCLE_FRAMES,
  RING_FRAME_MS,
  RING_MOTION,
  SIGNAL_FLAG_TONE,
  ringState,
  type LoopRing,
  type RingGlow,
  type RingHalo,
  type RingPulseTiming,
  type RingStateInput,
  type StillRing,
} from "@shared/rings";
import { themeFor } from "./theme";
import type { ActivityTone } from "./activity";
import {
  LOOP_REST_FRAME,
  RING_PAINT,
  paintDone,
  paintFlag,
  paintGlow,
  paintHalo,
  paintLoop,
  paintStill,
  type RingPalette,
  type RingPart,
} from "./activity-rings";

export { LAND_FRAMES };

/** Design units per mark edge. */
export const MARK_BOX = 20;
const BOX = MARK_BOX;
/** Atlas pixels per unit: a 52px seat ring at dpr 2 draws 1:1. */
const SCALE = 5.2;
export const MARK_CELL = Math.round(BOX * SCALE);
const CELL = MARK_CELL;
export const MARK_ATLAS_COLS = RING_CYCLE_FRAMES;

const LOOP_ROWS: ReadonlyArray<readonly [LoopRing, ActivityTone]> = [
  ["work", "cyan"],
  ["work", "green"],
  ["work", "steel"],
  ["work", "amber"],
  ["work", "crimson"],
  ["reverse", "amber"],
  ["snake", "amber"],
  ["call", "amber"],
  ["halt", "crimson"],
  ["wait", "amber"],
  ["wait", "cyan"],
  ["glint", "green"],
  ["fracture", "amber"],
  ["dot", "green"],
  ["dot", "cyan"],
  ["dot", "amber"],
  ["live", "green"],
  ["live", "cyan"],
];
const LAND_ROW = LOOP_ROWS.length;

const STILL_CELLS: ReadonlyArray<readonly [StillRing, ActivityTone]> = [
  ["rest", "steel"],
  ["off", "steel"],
];

const GLOWS: ReadonlyArray<RingGlow | "none"> = ["none", "amber", "crimson"];
const HALOS: ReadonlyArray<RingHalo | "none"> = ["none", "good", "exceeding"];
const FLAGS: ReadonlyArray<AgentSignalKind | "none"> = ["none", "blocked", "escalate", "feedback"];

export type AtlasCell = { readonly col: number; readonly row: number };

const key = (a: string, b: string): string => `${a}:${b}`;
const bandKey = (glow: string, halo: string, stale: boolean, flag: string): string =>
  `${glow}:${halo}:${stale ? "stale" : "fresh"}:${flag}`;

/** Where a moving ring's still parts sit in the atlas, and how each runs. */
export type RingParts = {
  /** The still base: the mark's background while the ring moves; blank when absent. */
  readonly base: AtlasCell;
  readonly spin?: AtlasCell & { readonly ms: number; readonly ccw: boolean; readonly fade: boolean };
  readonly pulse?: AtlasCell & { readonly ms: number; readonly kind: RingPulseTiming["kind"] };
  /** Done only: the sealed ring, faded and grown in once before the glint. */
  readonly land?: AtlasCell;
};

type Layout = {
  readonly loop: ReadonlyMap<string, number>;
  /** By loop row. */
  readonly parts: ReadonlyMap<number, RingParts>;
  readonly stills: ReadonlyMap<string, AtlasCell>;
  readonly bands: ReadonlyMap<string, AtlasCell>;
  /** Left empty: a live ring's core points here so only its canvas shows. */
  readonly blank: AtlasCell;
  readonly rows: number;
};

const buildLayout = (): Layout => {
  const loop = new Map<string, number>();
  LOOP_ROWS.forEach(([ring, tone], row) => loop.set(key(ring, tone), row));
  let col = LAND_FRAMES + 1;
  let row = LAND_ROW;
  const next = (): AtlasCell => {
    if (col >= MARK_ATLAS_COLS) {
      col = 0;
      row += 1;
    }
    const cell = { col, row };
    col += 1;
    return cell;
  };
  const blank = next();
  const stills = new Map<string, AtlasCell>();
  for (const [ring, tone] of STILL_CELLS) stills.set(key(ring, tone), next());
  const bands = new Map<string, AtlasCell>();
  for (const glow of GLOWS) {
    for (const halo of HALOS) {
      for (const stale of [false, true]) {
        for (const flag of FLAGS) {
          const faded = glow !== "none" || halo !== "none";
          if (!faded && (stale || flag === "none")) continue;
          bands.set(bandKey(glow, halo, stale, flag), next());
        }
      }
    }
  }
  const parts = new Map<number, RingParts>();
  LOOP_ROWS.forEach(([ring], loopRow) => {
    const motion = RING_MOTION[ring];
    const base = motion.base ? next() : blank;
    const spin = motion.spin
      ? { ...next(), ms: motion.spin.lapMs, ccw: motion.spin.ccw === true, fade: motion.spin.fade === true }
      : undefined;
    const pulse = motion.pulse ? { ...next(), ms: motion.pulse.ms, kind: motion.pulse.kind } : undefined;
    parts.set(loopRow, {
      base,
      ...(spin ? { spin } : {}),
      ...(pulse ? { pulse } : {}),
      ...(ring === "glint" ? { land: base } : {}),
    });
  });
  return { loop, parts, stills, bands, blank, rows: row + 1 };
};

const LAYOUT = buildLayout();
export const MARK_ATLAS_ROWS = LAYOUT.rows;

export type CoreCell = AtlasCell & {
  /** loop = moves on the compositor while on screen; still = never moves. */
  readonly motion: "loop" | "still";
  /** The moving ring and the tone it is baked in. */
  readonly live?: { readonly ring: LoopRing; readonly tone: ActivityTone };
  /** Its still parts and how each runs, while it moves. */
  readonly parts?: RingParts;
  /** Atlas row of a one-shot draw-in played before the loop (done). */
  readonly land?: number;
};

export type RingInput = RingStateInput & {
  /** False freezes loops at their rest pose and shows done already resting. */
  readonly animate: boolean;
};

export type RingCells = {
  readonly core: CoreCell;
  readonly band?: AtlasCell;
  /** Drawn form after health bent it, for data attributes and tests. */
  readonly ring: LoopRing | StillRing | "done";
  /** The tone the ring is drawn in: a far camera paints the seat as a disc of it. */
  readonly hue: ActivityTone;
};

const loopCell = (ring: LoopRing, tone: ActivityTone, animate: boolean): CoreCell => {
  const row =
    LAYOUT.loop.get(key(ring, tone)) ??
    LAYOUT.loop.get(key(ring, LOOP_ROWS.find(([r]) => r === ring)?.[1] ?? "cyan")) ??
    0;
  const drawn = LOOP_ROWS[row]?.[1] ?? tone;
  const parts = LAYOUT.parts.get(row);
  return animate
    ? { col: LOOP_REST_FRAME[ring], row, motion: "loop", live: { ring, tone: drawn }, ...(parts ? { parts } : {}) }
    : { col: LOOP_REST_FRAME[ring], row, motion: "still" };
};

const stillCell = (ring: StillRing): CoreCell => {
  const cell = LAYOUT.stills.get(key(ring, "steel")) ?? { col: 0, row: 0 };
  return { ...cell, motion: "still" };
};

/**
 * Where a ring sits in the atlas. Which ring, in which tone, and its band are
 * ringState's (src/shared/rings.ts), the rule the phone draws from too; this
 * only finds the cells that draw it, frozen at the rest pose unless
 * `animate`.
 */
export const ringCells = (input: RingInput): RingCells => {
  const state = ringState(input);
  const { ring, hue } = state;
  const core: CoreCell =
    ring === "done"
      ? input.animate
        ? { ...loopCell("glint", "green", true), land: LAND_ROW }
        : { col: LAND_FRAMES, row: LAND_ROW, motion: "still" }
      : ring === "rest" || ring === "off"
        ? stillCell(ring)
        : loopCell(ring, hue, input.animate);
  const band = LAYOUT.bands.get(bandKey(state.glow ?? "none", state.halo ?? "none", state.stale, state.flag ?? "none"));
  return band ? { core, band, ring, hue } : { core, ring, hue };
};

// --- painting ----------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
type Tones = Readonly<Record<ActivityTone, string>>;

export const tonesFor = (mode: ThemeMode): Tones => {
  const t = themeFor(mode);
  return {
    amber: t.amber ?? "",
    cyan: t.cyan ?? "",
    green: t.green ?? "",
    crimson: t.crimson ?? "",
    steel: t.steel ?? "",
  };
};

export const paletteFor = (mode: ThemeMode): RingPalette => ({
  glow: mode === "dark" ? 1.8 : 0,
  dark: mode === "dark",
});

/**
 * Each cell is painted on a scratch canvas and composited in, so knock-outs
 * (the flag's clearance) only touch their own cell.
 */
const paintAtlas = (ctx: Ctx, mode: ThemeMode): void => {
  const p = paletteFor(mode);
  const tones = tonesFor(mode);
  const scratch = document.createElement("canvas");
  scratch.width = CELL;
  scratch.height = CELL;
  const sx = scratch.getContext("2d");
  if (!sx) return;
  const cell = (at: AtlasCell, draw: (x: Ctx) => void): void => {
    sx.clearRect(0, 0, CELL, CELL);
    sx.save();
    sx.scale(CELL / BOX, CELL / BOX);
    draw(sx);
    sx.restore();
    ctx.drawImage(scratch, at.col * CELL, at.row * CELL);
  };
  LOOP_ROWS.forEach(([ring, tone], row) => {
    for (let frame = 0; frame < MARK_ATLAS_COLS; frame += 1) {
      cell({ col: frame, row }, (x) => paintLoop(x, p, ring, tones[tone], frame));
    }
  });
  for (let frame = 0; frame <= LAND_FRAMES; frame += 1) {
    cell({ col: frame, row: LAND_ROW }, (x) => paintDone(x, p, tones.green, frame));
  }
  LOOP_ROWS.forEach(([ring, tone], row) => {
    const parts = LAYOUT.parts.get(row);
    const paint = RING_PAINT[ring];
    if (!parts) return;
    const bake = (at: AtlasCell | undefined, part: RingPart | undefined): void => {
      if (at && part) cell(at, (x) => part(x, p, tones[tone]));
    };
    bake(RING_MOTION[ring].base ? parts.base : undefined, paint.base);
    bake(parts.spin, paint.spin);
    bake(parts.pulse, paint.pulse);
  });
  for (const [ring, tone] of STILL_CELLS) {
    const at = LAYOUT.stills.get(key(ring, tone));
    if (at) cell(at, (x) => paintStill(x, p, ring, tones[tone]));
  }
  for (const glow of GLOWS) {
    for (const halo of HALOS) {
      for (const stale of [false, true]) {
        for (const flag of FLAGS) {
          const at = LAYOUT.bands.get(bandKey(glow, halo, stale, flag));
          if (!at) continue;
          const fade = stale ? 0.4 : 1;
          cell(at, (x) => {
            if (glow !== "none") paintGlow(x, p, tones[glow], fade);
            if (halo !== "none") paintHalo(x, p, halo, tones.green, fade);
            if (flag !== "none") paintFlag(x, p, tones[SIGNAL_FLAG_TONE[flag]], flag === "blocked");
          });
        }
      }
    }
  }
};

// --- projection to the page --------------------------------------------------

const STYLE_ID = "junto-mark-atlas";
const atlasUrl = new Map<ThemeMode, string>();

const renderAtlas = (mode: ThemeMode): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = MARK_ATLAS_COLS * CELL;
  canvas.height = MARK_ATLAS_ROWS * CELL;
  let ctx: Ctx | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return undefined;
  paintAtlas(ctx, mode);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
};


const cellAt = (col: string, row: string): string =>
  `calc(var(${col}) * var(--mark-u) * -1) calc(var(${row}) * var(--mark-u) * -1)`;

/**
 * Moving rings on the compositor. While motion is live, a moving mark's
 * background is its still base and its parts show: a spin turns a full lap,
 * a pulse fades or grows. Keyframes touch transform and opacity only, so
 * nothing repaints and no frame runs on the main thread. Paused (hidden
 * window, reduced motion) the parts hide and the rest pose shows. Parts show
 * only on screen (data-mark-visible), so an offscreen mark holds no layer.
 * `--mark-t0` puts every ring on one shared clock. No will-change: the
 * running animation composites a part anyway, and will-change pins its raster
 * scale, which canvas-tier-budget.spec.ts reads as pinned layers zoomed out.
 */
const motionCss = (): readonly string[] => {
  const live = `html:not([data-surface-motion="paused"])`;
  return [
    `${live} .junto-mark[data-mark-motion="loop"][data-mark-parts]{background-position:${cellAt("--mark-lcol", "--mark-lrow")}}`,
    `${live} .junto-mark[data-mark-land]:not([data-mark-landed]){background-position:calc(${String(LAYOUT.blank.col)} * var(--mark-u) * -1) calc(${String(LAYOUT.blank.row)} * var(--mark-u) * -1)}`,
    `.junto-mark__part{display:none;position:absolute;inset:0;pointer-events:none;background-image:inherit;background-repeat:no-repeat;background-size:inherit;background-position:${cellAt("--part-col", "--part-row")};animation-duration:var(--part-ms);animation-delay:var(--mark-t0,0ms);animation-iteration-count:infinite}`,
    `${live} .junto-mark[data-mark-visible]>.junto-mark__part{display:block}`,
    `${live} .junto-mark[data-mark-landed]>.junto-mark__part[data-part="land"]{display:none}`,
    `.junto-mark__part[data-spin]{animation-name:junto-mark-turn;animation-timing-function:linear}`,
    `.junto-mark__part[data-spin="ccw"]{animation-direction:reverse}`,
    `.junto-mark__part[data-spin][data-fade]{animation-name:junto-mark-turn,junto-mark-breathe;animation-timing-function:linear,ease-in-out}`,
    `.junto-mark__part[data-pulse="beat"]{animation-name:junto-mark-beat;animation-timing-function:linear}`,
    `.junto-mark__part[data-pulse="breathe"]{animation-name:junto-mark-breathe;animation-timing-function:ease-in-out}`,
    `.junto-mark__part[data-pulse="send"]{animation-name:junto-mark-send;animation-timing-function:linear}`,
    // Done lands once: the sealed ring fades and grows in, then rests.
    `.junto-mark__part[data-part="land"]{animation:junto-mark-land ${String(LAND_FRAMES * RING_FRAME_MS)}ms cubic-bezier(.33,1,.68,1) both}`,
    `@keyframes junto-mark-turn{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`,
    // Two beats then a rest, as heartbeat() in activity-rings.ts, frame for frame.
    `@keyframes junto-mark-beat{0%{opacity:0}18.75%{opacity:1}37.5%{opacity:0}50%{opacity:.55}68.75%{opacity:0}100%{opacity:0}}`,
    `@keyframes junto-mark-breathe{0%{opacity:0}50%{opacity:1}100%{opacity:0}}`,
    // The call wave: out from just past the ring to the band's edge in 13 of 16 frames.
    `@keyframes junto-mark-send{0%{transform:scale(1);opacity:1;animation-timing-function:cubic-bezier(.33,1,.68,1)}81.25%{transform:scale(1.31);opacity:0}100%{transform:scale(1.31);opacity:0}}`,
    `@keyframes junto-mark-land{from{transform:scale(.82);opacity:0}to{transform:scale(1);opacity:1}}`,
  ];
};

/** Structural CSS for every mark. Exported so tests can read the real sheet. */
export const markAtlasCss = (): string =>
  [
    `.junto-mark{--mark-u:20px;position:relative;display:inline-block;flex-shrink:0;vertical-align:middle;line-height:0;width:var(--mark-u);height:var(--mark-u);contain:layout style paint;background-repeat:no-repeat;background-size:calc(var(--mark-u) * ${String(MARK_ATLAS_COLS)}) calc(var(--mark-u) * ${String(MARK_ATLAS_ROWS)});background-position:calc(var(--mark-col) * var(--mark-u) * -1) calc(var(--mark-row) * var(--mark-u) * -1)}`,
    `.junto-mark[data-mark-size="inline"]{--mark-u:14px}`,
    `.junto-mark[data-mark-size="seat"]{--mark-u:52px}`,
    `.junto-mark[data-mark-size="glance"]{--mark-u:32px}`,
    // Standalone marks carry a hub: the ring's centre in the state's tone.
    `.junto-mark[data-mark-hub]::before{content:"";position:absolute;inset:33%;border-radius:50%;background:var(--mark-hub)}`,
    `.junto-mark[data-mark-band]::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:inherit;background-repeat:no-repeat;background-size:inherit;background-position:calc(var(--mark-bcol) * var(--mark-u) * -1) calc(var(--mark-brow) * var(--mark-u) * -1)}`,
    // A portrait sits in the ring's hole, centred.
    `.junto-mark__seat{position:absolute;inset:0;display:grid;place-items:center}`,
    ...motionCss(),
    // The portrait's badge, over the ring's parts, in a box the portrait's size.
    `.junto-mark__over{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}`,
    // Overseer crest: top of the ring, rimmed in ground so it cuts the ring.
    `.junto-mark__crest{position:absolute;left:50%;top:0;width:30%;height:21%;min-width:9px;min-height:6px;transform:translate(-50%,-4%);color:var(--color-indigo);pointer-events:none}`,
    `.junto-mark__crest path{fill:currentColor;stroke:var(--color-ground);stroke-width:1.6px;stroke-linejoin:round;paint-order:stroke}`,
    `.junto-mark__flag{position:absolute;top:0;right:0;width:36%;height:36%;min-width:10px;min-height:10px;padding:0;border:0;border-radius:999px;background:transparent;cursor:pointer}`,
    `.junto-mark__flag:focus-visible{outline:1px solid var(--color-focus-ring);outline-offset:1px}`,
  ].join("\n");

const imageRules = (): string => {
  const out: string[] = [];
  const dark = atlasUrl.get("dark");
  const bright = atlasUrl.get("bright");
  if (dark) out.push(`.junto-mark{background-image:url("${dark}")}`);
  if (bright) out.push(`html[data-theme="bright"] .junto-mark{background-image:url("${bright}")}`);
  // Scoped panels (the gallery) pick their theme regardless of the page.
  if (dark) out.push(`html [data-mark-theme="dark"] .junto-mark{background-image:url("${dark}")}`);
  if (bright) out.push(`html [data-mark-theme="bright"] .junto-mark{background-image:url("${bright}")}`);
  return out.join("\n");
};

const writeSheet = (): void => {
  if (typeof document === "undefined" || !document.head) return;
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = `${markAtlasCss()}\n${imageRules()}`;
};

/**
 * Paint (once) the atlas for a theme and publish it. Cheap after the first
 * call. Returns false where no canvas exists (tests, SSR).
 */
export const ensureMarkAtlas = (mode: ThemeMode): boolean => {
  if (atlasUrl.has(mode)) return true;
  const url = renderAtlas(mode);
  if (!url) {
    writeSheet();
    return false;
  }
  atlasUrl.set(mode, url);
  writeSheet();
  return true;
};

/** Test helper. */
export const resetMarkAtlasForTests = (): void => {
  atlasUrl.clear();
  if (typeof document !== "undefined") document.getElementById(STYLE_ID)?.remove();
};
