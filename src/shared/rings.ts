/**
 * The ring language, apart from how it is painted: which ring a seat shows,
 * in which tone, and how fast it moves. The desktop paints these in
 * activity-rings.ts and bakes them into its atlas (activity-atlas.ts); the
 * phone's native canvas draws the same rings from the same answer. Imports
 * nothing but effect: no theme, no canvas, no renderer.
 *
 *   work      an arc circles the ring, clockwise
 *   reverse   circling runs backwards (stuck)
 *   snake     the ring itself zigzags as a wave travels round it (thrashing, looping)
 *   call      a steady ring that keeps sending rings outward (needs your input)
 *   wait      two beads orbit a lit ring, slowly (waiting on you, declared)
 *   halt      a heavy ring on a steady double heartbeat (blocked, failed)
 *   glint     done: the ring sweeps closed once, then a faint glint laps it (unread)
 *   fracture  a broken ring grinds slowly round (trouble, at rest)
 *   dot, live the ring breathes (a settled fact, a warm session)
 *   rest, off still: acknowledged idle and stopped are the only silent rings
 */
import { Schema } from "effect";
import type { AgentSignalKind } from "./agent-signals";
import type { ThreadHealthTone, ThreadHealthValue } from "./thread-health";

/** A severity's hue, by name; each surface owns its palette. */
export const ActivityTone = Schema.Literals(["amber", "cyan", "green", "crimson", "steel"]);
export type ActivityTone = typeof ActivityTone.Type;

/**
 * What a mark draws, named by meaning; the concept in activity-concepts.ts
 * decides the form.
 * work → something is in flight (loops)
 * call → wants the operator (loops, then rests)
 * halt → blocked or failed (a slow double beat)
 * done → finished: draws itself once, then rests still
 * live → a warm session, quietly present
 * dot  → a settled fact in a tone (met, live chat)
 * rest → idle
 * off  → stopped, gone, unknown
 */
export const ActivityGlyph = Schema.Literals(["work", "call", "halt", "done", "live", "dot", "rest", "off"]);
export type ActivityGlyph = typeof ActivityGlyph.Type;

export const LoopRing = Schema.Literals(["work", "reverse", "snake", "call", "wait", "halt", "glint", "fracture", "dot", "live"]);
export type LoopRing = typeof LoopRing.Type;
export const StillRing = Schema.Literals(["rest", "off"]);
export type StillRing = typeof StillRing.Type;

/** The waiting glow outside the ring. */
export const RingGlow = Schema.Literals(["amber", "crimson"]);
export type RingGlow = typeof RingGlow.Type;
/** The good-health halo outside the ring. */
export const RingHalo = Schema.Literals(["good", "exceeding"]);
export type RingHalo = typeof RingHalo.Type;

// --- timing ------------------------------------------------------------------

/** The tempo every ring is drawn to: one frame is 90 ms of motion. */
export const RING_FRAME_MS = 90;
/** One full cycle of every loop: 32 frames, 2.88 s. */
export const RING_CYCLE_FRAMES = 32;
/** Frames of the done draw-in; frame LAND_FRAMES is the resting pose. */
export const LAND_FRAMES = 8;
/**
 * Every loop's phase restarts together this often: a multiple of every lap.
 * A ring's phase is wall time modulo this, so a desktop and a phone showing
 * the same seat turn and pulse in step.
 */
export const MARK_PHASE_MS = 896 * RING_FRAME_MS;

/** A part that turns a full lap, clockwise unless `ccw`. */
export type RingSpinTiming = {
  readonly lapMs: number;
  readonly ccw?: boolean;
  /** Also fades in and out once a lap (the glint). */
  readonly fade?: boolean;
};

/**
 * A part that fades or is sent outward: `beat` is the halt's double
 * heartbeat, `breathe` a slow in and out, `send` a ring growing out and away.
 */
export type RingPulseTiming = {
  readonly kind: "beat" | "breathe" | "send";
  readonly ms: number;
};

/**
 * How each moving ring runs: a still base (when `base`) under a part that
 * turns or a part that pulses. Only transform and opacity ever animate, so
 * the motion runs on the compositor at the display's rate. A lap is the time
 * the shape takes to come round to itself.
 */
export type RingMotion = {
  readonly base: boolean;
  readonly spin?: RingSpinTiming;
  readonly pulse?: RingPulseTiming;
};

const F = RING_FRAME_MS;

export const RING_MOTION: Readonly<Record<LoopRing, RingMotion>> = {
  work: { base: true, spin: { lapMs: 16 * F } },
  reverse: { base: true, spin: { lapMs: 32 * F, ccw: true } },
  // The wave crest travels 8/7 of a half-turn a cycle; the whole zigzag
  // (its bulge baked in) turns at that speed, a full lap in 56 frames.
  snake: { base: false, spin: { lapMs: 56 * F } },
  call: { base: true, pulse: { kind: "send", ms: 16 * F } },
  wait: { base: true, spin: { lapMs: 64 * F } },
  halt: { base: true, pulse: { kind: "beat", ms: 16 * F } },
  glint: { base: true, spin: { lapMs: 32 * F, fade: true } },
  // Four-fold: a quarter turn a cycle comes round to itself in four.
  fracture: { base: false, spin: { lapMs: 128 * F } },
  dot: { base: true, pulse: { kind: "breathe", ms: 32 * F } },
  live: { base: true, pulse: { kind: "breathe", ms: 32 * F } },
};

// --- which ring ----------------------------------------------------------------

/** Declared signal hues: blocked crimson, escalate amber, feedback cyan. */
export const SIGNAL_FLAG_TONE: Readonly<Record<AgentSignalKind, ActivityTone>> = {
  blocked: "crimson",
  escalate: "amber",
  feedback: "cyan",
};

export type RingStateInput = {
  readonly glyph: ActivityGlyph;
  readonly tone: ActivityTone;
  readonly health?: ThreadHealthTone;
  readonly healthValue?: ThreadHealthValue;
  readonly healthStale?: boolean;
  readonly signal?: AgentSignalKind;
};

export type RingState = {
  /** Drawn form after health bent it; `done` lands once, then glints. */
  readonly ring: LoopRing | StillRing | "done";
  /** The tone the ring is drawn in. */
  readonly hue: ActivityTone;
  /** The waiting glow outside the ring, if any. */
  readonly glow?: RingGlow;
  /** The good-health halo outside the ring, if any. */
  readonly halo?: RingHalo;
  /** The band draws faded: an aged reading. */
  readonly stale: boolean;
  /** The open declared signal the band flags, if any. */
  readonly flag?: AgentSignalKind;
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
export const ringState = (input: RingStateInput): RingState => {
  const { glyph, tone, health, healthValue, signal } = input;
  const trouble = health === "trouble";
  const waitTone: ActivityTone | undefined =
    signal === "escalate" || signal === "feedback"
      ? SIGNAL_FLAG_TONE[signal]
      : health === "waiting" && input.healthStale !== true
        ? "amber"
        : undefined;
  let ring: RingState["ring"];
  let hue: ActivityTone = tone;
  if (glyph === "work") {
    ring = trouble ? (healthValue === "stuck" ? "reverse" : "snake") : "work";
    hue = trouble ? "amber" : tone;
  } else if (glyph === "call" || glyph === "halt") {
    ring = glyph;
    hue = glyph === "call" ? "amber" : "crimson";
  } else if (signal === "blocked") {
    ring = "halt";
    hue = "crimson";
  } else if (waitTone) {
    ring = "wait";
    hue = waitTone;
  } else if (glyph === "done") {
    ring = "done";
    hue = "green";
  } else if (trouble) {
    ring = "fracture";
    hue = "amber";
  } else if (glyph === "dot" || glyph === "live") {
    ring = glyph;
    hue = tone === "steel" ? "cyan" : tone;
  } else {
    ring = glyph;
  }

  const signalGlow: RingGlow | undefined =
    signal === "blocked" ? "crimson" : signal === "escalate" ? "amber" : undefined;
  const glow: RingGlow | undefined = signalGlow ?? (health === "waiting" ? "amber" : undefined);
  const halo: RingHalo | undefined =
    health === "good" ? (healthValue === "exceeding" ? "exceeding" : "good") : undefined;
  // Only the reading fades with age; a declared signal is current until closed.
  const stale = input.healthStale === true && (halo !== undefined || (glow !== undefined && !signalGlow));
  return {
    ring,
    hue,
    ...(glow ? { glow } : {}),
    ...(halo ? { halo } : {}),
    stale,
    ...(signal ? { flag: signal } : {}),
  };
};
