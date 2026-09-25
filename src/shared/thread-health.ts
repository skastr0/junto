import { Schema } from "effect";

/**
 * Thread health: the seat-awareness sidecar's advisory reading of how an
 * agent's thread is going, on one spectrum from trouble to success.
 *
 * It is an AI assessment, never the agent's own claim. Declared agent signals
 * (`agent-signals.ts`) are a separate axis and are never merged in: a signal is
 * what the seat said about itself; health is what Jev read on its screen. Health
 * is read-only and advisory. It never feeds seat state, delivery, flags, or the
 * canvas document, and it only exists where the awareness sidecar runs.
 */

/** Worst first. The order is the spectrum the surface paints. */
export const THREAD_HEALTH_VALUES = [
  "stuck",
  "looping",
  "thrashing",
  "confused",
  "overwhelmed",
  "waiting_on_operator",
  "steady",
  "going_well",
  "succeeding",
  "exceeding",
] as const;
export const ThreadHealthValue = Schema.Literals(THREAD_HEALTH_VALUES);
export type ThreadHealthValue = typeof ThreadHealthValue.Type;

/** Four glance tones: something is wrong, it wants you, fine, going well. */
export const THREAD_HEALTH_TONES = ["trouble", "waiting", "steady", "good"] as const;
export type ThreadHealthTone = (typeof THREAD_HEALTH_TONES)[number];

export const THREAD_HEALTH_TONE: Readonly<Record<ThreadHealthValue, ThreadHealthTone>> = {
  stuck: "trouble",
  looping: "trouble",
  thrashing: "trouble",
  confused: "trouble",
  overwhelmed: "trouble",
  waiting_on_operator: "waiting",
  steady: "steady",
  going_well: "good",
  succeeding: "good",
  exceeding: "good",
};

/** Operator-facing words. Surfaces prefix them with "AI reads" so they never pass for a claim. */
export const THREAD_HEALTH_LABEL: Readonly<Record<ThreadHealthValue, string>> = {
  stuck: "stuck",
  looping: "looping",
  thrashing: "thrashing",
  confused: "confused",
  overwhelmed: "overwhelmed",
  waiting_on_operator: "wants your input",
  steady: "steady",
  going_well: "going well",
  succeeding: "succeeding",
  exceeding: "exceeding expectations",
};

/** A model probability: finite, in [0, 1]. */
const Probability = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

/** One accepted health property and the model's own probability for it. */
export const ThreadHealthSignal = Schema.Struct({
  value: ThreadHealthValue,
  probability: Probability,
  /** The pack question that produced it. */
  questionId: Schema.String,
});
export type ThreadHealthSignal = typeof ThreadHealthSignal.Type;

export const ThreadHealthProvenance = Schema.Struct({
  source: Schema.Literals(["jev"]),
  /** The awareness observation this reading came from. */
  assessmentId: Schema.String,
  /** The question whose answer set the headline value. */
  questionId: Schema.String,
  packVersion: Schema.String,
  model: Schema.optionalKey(Schema.String),
});
export type ThreadHealthProvenance = typeof ThreadHealthProvenance.Type;

/**
 * One reading for one seat. `confidence` is the winning question's own model
 * probability, never a product of several answers. `signals` lists every
 * accepted property in precedence order, so a surface can show a mixed thread
 * ("going well" and "confused") rather than only the headline.
 */
export const ThreadHealthReading = Schema.Struct({
  bindingId: Schema.String,
  value: ThreadHealthValue,
  confidence: Probability,
  /** Epoch ms the evidence was observed. A cached answer never moves it. */
  observedAt: Schema.Finite,
  provenance: ThreadHealthProvenance,
  signals: Schema.Array(ThreadHealthSignal).pipe(
    Schema.check(Schema.isMaxLength(THREAD_HEALTH_VALUES.length)),
  ),
});
export type ThreadHealthReading = typeof ThreadHealthReading.Type;

export const decodeThreadHealthReading = Schema.decodeUnknownOption(ThreadHealthReading);

/**
 * A reading older than this is shown as last observed, unless the seat's
 * screen is still materially the one it was observed on (an idle thread that
 * stopped to ask the operator keeps its reading until something changes).
 */
export const THREAD_HEALTH_TTL_MS = 5 * 60_000;
