/**
 * ActivityMark sprite atlas: every frame of every ring, painted once per
 * theme into one canvas, served to the page as a single data URL.
 *
 * A mark on screen is one element whose background points into this atlas.
 * Animation is a background-position step keyed off the shared 90 ms clock
 * (`html[data-mark-frame]`, see attention-clock.ts), so a tick costs one
 * style match and one small blit per visible looping mark: no per-mark DOM
 * subtree, no interpolating CSS, no per-mark timers. Anything not looping is
 * a static cell and never repaints.
 *
 * Layers (20-unit box; see ActivityMark.tsx and activity-rings.ts):
 *   ring     control state, bent by the thread-health reading when it is trouble
 *   band     outside the ring: the waiting glow, the good-health halo, and the
 *            declared-signal flag, baked together into one overlay cell that
 *            the mark's ::after draws over the ring
 */

import type { ThemeMode } from "@shared/theme";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import type { AgentSignalKind } from "@shared/agent-signals";
import { ATTENTION_CLOCK_FRAMES, ATTENTION_CLOCK_TICK_MS } from "./attention-clock";
import { themeFor } from "./theme";
import type { ActivityGlyph, ActivityTone } from "./activity";
import {
  LAND_FRAMES,
  LOOP_REST_FRAME,
  paintDone,
  paintFlag,
  paintGlow,
  paintHalo,
  paintLoop,
  paintStill,
  type LoopRing,
  type RingGlow,
  type RingHalo,
  type RingPalette,
  type StillRing,
} from "./activity-rings";

export { LAND_FRAMES };

/** Design units per mark edge. */
const BOX = 20;
/** Atlas pixels per unit: a 52px seat ring at dpr 2 draws 1:1. */
const SCALE = 5.2;
const CELL = Math.round(BOX * SCALE);
export const MARK_ATLAS_COLS = ATTENTION_CLOCK_FRAMES;

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

/** Declared signal hues: blocked crimson, escalate amber, feedback cyan. */
export const SIGNAL_FLAG_TONE: Readonly<Record<AgentSignalKind, ActivityTone>> = {
  blocked: "crimson",
  escalate: "amber",
  feedback: "cyan",
};

export type AtlasCell = { readonly col: number; readonly row: number };

const key = (a: string, b: string): string => `${a}:${b}`;
const bandKey = (glow: string, halo: string, stale: boolean, flag: string): string =>
  `${glow}:${halo}:${stale ? "stale" : "fresh"}:${flag}`;

type Layout = {
  readonly loop: ReadonlyMap<string, number>;
  readonly stills: ReadonlyMap<string, AtlasCell>;
  readonly bands: ReadonlyMap<string, AtlasCell>;
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
  return { loop, stills, bands, rows: row + 1 };
};

const LAYOUT = buildLayout();
export const MARK_ATLAS_ROWS = LAYOUT.rows;

export type CoreCell = AtlasCell & {
  /** loop = steps with the clock; still = never moves. */
  readonly motion: "loop" | "still";
  /** Atlas row of a one-shot draw-in played before the loop (done). */
  readonly land?: number;
};

export type RingInput = {
  readonly glyph: ActivityGlyph;
  readonly tone: ActivityTone;
  /** False freezes loops at their rest pose and shows done already resting. */
  readonly animate: boolean;
  readonly health?: ThreadHealthTone;
  readonly healthValue?: ThreadHealthValue;
  readonly healthStale?: boolean;
  readonly signal?: AgentSignalKind;
};

export type RingCells = {
  readonly core: CoreCell;
  readonly band?: AtlasCell;
  /** Drawn form after health bent it, for data attributes and tests. */
  readonly ring: LoopRing | StillRing | "done";
};

const loopCell = (ring: LoopRing, tone: ActivityTone, animate: boolean): CoreCell => {
  const row =
    LAYOUT.loop.get(key(ring, tone)) ??
    LAYOUT.loop.get(key(ring, LOOP_ROWS.find(([r]) => r === ring)?.[1] ?? "cyan")) ??
    0;
  return { col: LOOP_REST_FRAME[ring], row, motion: animate ? "loop" : "still" };
};

const stillCell = (ring: StillRing): CoreCell => {
  const cell = LAYOUT.stills.get(key(ring, "steel")) ?? { col: 0, row: 0 };
  return { ...cell, motion: "still" };
};

/**
 * One rule for what a ring shows.
 *
 * Control state owns the motion. A trouble reading bends it: work that is
 * stuck runs backwards, work that is thrashing or looping snakes, and a
 * settled ring fractures; trouble is amber, never crimson (crimson is a
 * declared blocker's). Call and halt outrank a reading. A seat that is not
 * working but waits on the operator circles: a declared blocked beats as
 * halt, escalate and feedback orbit in their flag's hue, and a fresh
 * "waiting" reading orbits amber. Done draws itself once and then glints
 * until it is read. The band says who is waiting on whom: a declared blocked
 * or escalate glows first, a health "waiting" reading second; a good reading
 * is a fine outer halo. The flag marks any open declared signal. Stale
 * readings draw faded. Only resting and stopped rings are still.
 */
export const ringCells = (input: RingInput): RingCells => {
  const { glyph, tone, animate, health, healthValue, signal } = input;
  const trouble = health === "trouble";
  const waitTone: ActivityTone | undefined =
    signal === "escalate" || signal === "feedback"
      ? SIGNAL_FLAG_TONE[signal]
      : health === "waiting" && input.healthStale !== true
        ? "amber"
        : undefined;
  let core: CoreCell;
  let ring: RingCells["ring"];
  if (glyph === "work") {
    ring = trouble ? (healthValue === "stuck" ? "reverse" : "snake") : "work";
    core = loopCell(ring, trouble ? "amber" : tone, animate);
  } else if (glyph === "call" || glyph === "halt") {
    ring = glyph;
    core = loopCell(glyph, glyph === "call" ? "amber" : "crimson", animate);
  } else if (signal === "blocked") {
    ring = "halt";
    core = loopCell("halt", "crimson", animate);
  } else if (waitTone) {
    ring = "wait";
    core = loopCell("wait", waitTone, animate);
  } else if (glyph === "done") {
    ring = "done";
    core = animate
      ? { ...loopCell("glint", "green", true), land: LAND_ROW }
      : { col: LAND_FRAMES, row: LAND_ROW, motion: "still" };
  } else if (trouble) {
    ring = "fracture";
    core = loopCell("fracture", "amber", animate);
  } else if (glyph === "dot" || glyph === "live") {
    ring = glyph;
    core = loopCell(glyph, tone === "steel" ? "cyan" : tone, animate);
  } else {
    ring = glyph;
    core = stillCell(glyph);
  }

  const signalGlow: RingGlow | undefined =
    signal === "blocked" ? "crimson" : signal === "escalate" ? "amber" : undefined;
  const glow: RingGlow | "none" = signalGlow ?? (health === "waiting" ? "amber" : "none");
  const halo: RingHalo | "none" =
    health === "good" ? (healthValue === "exceeding" ? "exceeding" : "good") : "none";
  // Only the reading fades with age; a declared signal is current until closed.
  const stale = input.healthStale === true && (halo !== "none" || (glow !== "none" && !signalGlow));
  const band = LAYOUT.bands.get(bandKey(glow, halo, stale, signal ?? "none"));
  return band ? { core, band, ring } : { core, ring };
};

// --- painting ----------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
type Tones = Readonly<Record<ActivityTone, string>>;

const tonesFor = (mode: ThemeMode): Tones => {
  const t = themeFor(mode);
  return {
    amber: t.amber ?? "",
    cyan: t.cyan ?? "",
    green: t.green ?? "",
    crimson: t.crimson ?? "",
    steel: t.steel ?? "",
  };
};

const paletteFor = (mode: ThemeMode): RingPalette => ({
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

/**
 * Frame rules: one per clock frame, matched only by visible looping marks.
 * The html stamp is the only thing that changes per tick; with no stamp
 * (motion paused, clock idle) a loop shows its rest pose.
 */
const frameRules = (): string => {
  const rules: string[] = [];
  for (let frame = 0; frame < MARK_ATLAS_COLS; frame += 1) {
    rules.push(
      `html[data-mark-frame="${String(frame)}"] .junto-mark[data-mark-motion="loop"][data-mark-visible]{background-position-x:calc(var(--mark-u) * -${String(frame)})}`,
    );
  }
  return rules.join("\n");
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
    frameRules(),
    // Done draws itself once from its land row, then hands over to its loop:
    // the animation has no fill, so when it ends the loop's own rules resume.
    `@keyframes juntoMarkLand{from{background-position:0 calc(var(--mark-lrow) * var(--mark-u) * -1)}to{background-position:calc(var(--mark-u) * -${String(LAND_FRAMES)}) calc(var(--mark-lrow) * var(--mark-u) * -1)}}`,
    `.junto-mark[data-mark-land]{animation:juntoMarkLand ${String(LAND_FRAMES * ATTENTION_CLOCK_TICK_MS)}ms steps(${String(LAND_FRAMES)}, end) 1}`,
    `html[data-surface-motion="paused"] .junto-mark[data-mark-land]{animation:none}`,
    `@media (prefers-reduced-motion: reduce){.junto-mark[data-mark-land]{animation:none}}`,
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
