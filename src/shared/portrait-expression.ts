import type { PortraitFace } from "./agent-portrait";
import type { AgentSignalKind } from "./agent-signals";
import type { ThreadHealthValue } from "./thread-health";

// Dynamic expression: what a seat's critter looks like right now. Pure and
// finite: (temperament, seat activity, worst open signal, thread health) picks
// one of a small set of named expressions, so portraits cache per expression
// and never draw per frame.
//
// The activity vocabulary is the seat ring's (work, call, halt, done, live,
// rest, off), so the face inside the ring tells the ring's story: a halt ring
// never frames a grin, a done ring never frames a frown.
//
// Temperament shifts the read, not the facts: a cheerful critter looks
// determined when stuck, a moody one looks grumpy when merely idle. Neither
// ever smiles at a blocker or scowls at a finish.

export const PORTRAIT_EXPRESSIONS = [
  "resting",
  "focused",
  "intent",
  "eager",
  "happy",
  "delighted",
  "content",
  "curious",
  "concerned",
  "worried",
  "frustrated",
  "determined",
  "confused",
  "grumpy",
  "sleepy",
] as const;
export type PortraitExpression = (typeof PORTRAIT_EXPRESSIONS)[number];

/** The seat ring's activity glyphs, the shared vocabulary for face and ring. */
export type ExpressionActivity = "work" | "call" | "halt" | "done" | "live" | "dot" | "rest" | "off";

export interface ExpressionInput {
  /** -1 moody .. 1 cheerful. */
  readonly temperament: number;
  readonly activity?: ExpressionActivity;
  /** Worst open signal on the seat. */
  readonly signal?: AgentSignalKind;
  /** Latest fresh thread-health reading; omit when stale or absent. */
  readonly health?: ThreadHealthValue;
}

/** Faces for each expression. `base` keeps the character's own feature. */
export const EXPRESSION_FACES: Readonly<Record<PortraitExpression, PortraitFace>> = {
  resting: { eyes: "base", mouth: "base", brows: "base", blush: "base", extra: "none" },
  focused: { eyes: "base", mouth: "flat", brows: "level", blush: "base", extra: "none" },
  intent: { eyes: "squint", mouth: "flat", brows: "furrowed", blush: "base", extra: "none" },
  eager: { eyes: "shiny", mouth: "smile", brows: "level", blush: true, extra: "none" },
  happy: { eyes: "happy", mouth: "grin", brows: "base", blush: true, extra: "none" },
  delighted: { eyes: "sparkle", mouth: "grin", brows: "raised", blush: true, extra: "sparkle" },
  content: { eyes: "sleepy", mouth: "smile", brows: "base", blush: true, extra: "none" },
  curious: { eyes: "base", mouth: "o", brows: "quizzical", blush: "base", extra: "none" },
  concerned: { eyes: "base", mouth: "o", brows: "raised", blush: false, extra: "none" },
  worried: { eyes: "base", mouth: "wobble", brows: "worried", blush: false, extra: "sweat" },
  frustrated: { eyes: "squint", mouth: "wobble", brows: "furrowed", blush: false, extra: "none" },
  determined: { eyes: "base", mouth: "fang", brows: "furrowed", blush: "base", extra: "none" },
  confused: { eyes: "base", mouth: "wobble", brows: "quizzical", blush: false, extra: "question" },
  grumpy: { eyes: "line", mouth: "frown", brows: "furrowed", blush: false, extra: "none" },
  sleepy: { eyes: "line", mouth: "none", brows: "base", blush: "base", extra: "zzz" },
};

type Lean = readonly [moody: PortraitExpression, even: PortraitExpression, cheerful: PortraitExpression];

const lean = (temperament: number, [moody, even, cheerful]: Lean): PortraitExpression =>
  temperament <= -0.34 ? moody : temperament >= 0.34 ? cheerful : even;

const TROUBLE: Readonly<Partial<Record<ThreadHealthValue, Lean>>> = {
  stuck: ["frustrated", "worried", "determined"],
  looping: ["frustrated", "confused", "determined"],
  thrashing: ["frustrated", "worried", "worried"],
  confused: ["confused", "confused", "curious"],
  overwhelmed: ["frustrated", "worried", "determined"],
};

const GOOD: Readonly<Partial<Record<ThreadHealthValue, Lean>>> = {
  going_well: ["focused", "eager", "happy"],
  succeeding: ["content", "happy", "delighted"],
  exceeding: ["happy", "delighted", "delighted"],
};

/**
 * Pick the expression. Precedence is the seat's own: gone, then blocked, then
 * a call for the operator, then a troubled thread (the AI's read), then
 * finished, then a thread going well, then working, then idle.
 */
export function portraitExpression(input: ExpressionInput): PortraitExpression {
  const t = Number.isFinite(input.temperament) ? Math.max(-1, Math.min(1, input.temperament)) : 0;
  const { activity, signal, health } = input;
  if (activity === "off") return "sleepy";
  if (activity === "halt" || signal === "blocked") return lean(t, ["frustrated", "concerned", "determined"]);
  // Proven attention outranks the AI's reading, as it does on the seat line.
  if (activity === "call" || signal === "escalate" || signal === "feedback" || health === "waiting_on_operator") {
    return lean(t, ["concerned", "curious", "curious"]);
  }
  const trouble = health ? TROUBLE[health] : undefined;
  if (trouble) return lean(t, trouble);
  if (activity === "done") return lean(t, ["content", "content", "happy"]);
  const good = health ? GOOD[health] : undefined;
  if (good) return lean(t, good);
  if (activity === "work") return lean(t, ["intent", "focused", "eager"]);
  if (activity === "live" || activity === "dot" || activity === "rest") return lean(t, ["grumpy", "resting", "content"]);
  return "resting";
}

/** The face for an input, ready for the portrait renderer. */
export const portraitFaceFor = (input: ExpressionInput): PortraitFace =>
  EXPRESSION_FACES[portraitExpression(input)];
