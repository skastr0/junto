/**
 * Thread health in the renderer: what the card's activity mark and the seat
 * sidebar read. Advisory display only; it never writes the canvas or any
 * store but its own clock.
 *
 * Two axes stay apart. A declared signal is the seat's own claim (owned by the
 * signals store); health is Jev's reading of the screen. The only place they
 * meet is `threadHealthMark`, and only to keep one corner of the card from
 * contradicting itself: while the seat has declared it is blocked or wants to
 * escalate, a "wants you" reading is redundant and a good reading must not
 * shine next to it.
 *
 * Freshness differs from the awareness card's judgment rule on purpose. That
 * rule ages a judgment as soon as the seat's turn ends, which is right for
 * "what is it doing" and wrong here: the reading the operator most needs, a
 * thread that stopped to ask them something, is idle by definition. So a
 * health reading stays current while it is inside THREAD_HEALTH_TTL_MS or the
 * screen has not materially changed since it was observed (the producer's own
 * coarse window digest, compared, never derived here).
 */

import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { AgentSignalKind } from "@shared/agent-signals";
import {
  THREAD_HEALTH_LABEL,
  THREAD_HEALTH_TONE,
  THREAD_HEALTH_TTL_MS,
  type ThreadHealthReading,
  type ThreadHealthTone,
  type ThreadHealthValue,
} from "@shared/thread-health";
import type { StatusTone } from "../components/ui/StatusDot";
import { formatSeatAwarenessAge, seatAwareness$ } from "./seat-awareness";

export type ThreadHealthFreshness = "current" | "stale";

/** Current inside the TTL, or while the screen is materially the one observed. */
export const threadHealthFreshness = (
  reading: ThreadHealthReading,
  input: {
    readonly now: number;
    /** Digest of the window the reading was observed against. */
    readonly evidenceDigest: string | undefined;
    /** Newest live window digest the producer reported. */
    readonly liveDigest: string | undefined;
  },
): ThreadHealthFreshness => {
  if (input.now - reading.observedAt < THREAD_HEALTH_TTL_MS) return "current";
  if (
    input.evidenceDigest !== undefined &&
    input.liveDigest !== undefined &&
    input.evidenceDigest === input.liveDigest
  ) {
    return "current";
  }
  return "stale";
};

/** "AI reads: going well", plus the age once the reading is no longer current. */
export const threadHealthLabel = (
  reading: ThreadHealthReading,
  freshness: ThreadHealthFreshness,
  now: number,
): string => {
  const base = `AI reads: ${THREAD_HEALTH_LABEL[reading.value]}`;
  return freshness === "stale"
    ? `${base}, last observed ${formatSeatAwarenessAge(now - reading.observedAt)}`
    : base;
};

/** The three hues health may use; a subset of both the StatusDot and Chip tones. */
export type ThreadHealthHue = Extract<StatusTone, "amber" | "steel" | "green">;

/** Glance colour per tone. Never crimson: that hue belongs to declared blockers. */
export const THREAD_HEALTH_STATUS_TONE: Readonly<Record<ThreadHealthTone, ThreadHealthHue>> = {
  trouble: "amber",
  waiting: "amber",
  steady: "steel",
  good: "green",
};

/** What the seat's ring and label line draw for health. */
export type ThreadHealthMark = {
  readonly health: ThreadHealthTone | undefined;
  /** The exact reading, for ring motion that tells stuck, looping and thrashing apart. */
  readonly value: ThreadHealthValue | undefined;
  /** Draw quietly: the reading is old, or a declared signal outranks it. */
  readonly healthStale: boolean;
  /** Title and aria text: "AI reads: going well". Undefined when nothing is drawn. */
  readonly label: string | undefined;
  /**
   * Short text for the line beneath the seat's name ("going well"). Render it
   * marked as an AI reading so it never passes for the agent's own claim.
   * Undefined while a declared blocked or escalate signal is open: the line
   * then belongs to the signal.
   */
  readonly line: string | undefined;
};

const NO_MARK: ThreadHealthMark = {
  health: undefined,
  value: undefined,
  healthStale: false,
  label: undefined,
  line: undefined,
};

/** Declared kinds that already tell the operator the seat wants them. */
const DECLARED_WANTS_OPERATOR: ReadonlySet<AgentSignalKind> = new Set(["blocked", "escalate"]);

export const threadHealthMark = (
  reading: ThreadHealthReading | undefined,
  input: {
    readonly now: number;
    readonly freshness: ThreadHealthFreshness;
    /** Worst open declared signal on the seat, from the signals rollup. */
    readonly signal?: AgentSignalKind | undefined;
  },
): ThreadHealthMark => {
  if (reading === undefined) return NO_MARK;
  const tone = THREAD_HEALTH_TONE[reading.value];
  const declared = input.signal !== undefined && DECLARED_WANTS_OPERATOR.has(input.signal);
  // The seat already said it wants the operator; the AI echo adds nothing.
  if (declared && tone === "waiting") return NO_MARK;
  return {
    health: tone,
    value: reading.value,
    healthStale: input.freshness === "stale" || (declared && tone === "good"),
    label: threadHealthLabel(reading, input.freshness, input.now),
    line: declared ? undefined : THREAD_HEALTH_LABEL[reading.value],
  };
};

// --- store reads ---------------------------------------------------------------

export type ThreadHealthView = {
  readonly reading: ThreadHealthReading;
  readonly freshness: ThreadHealthFreshness;
  readonly label: string;
  readonly tone: ThreadHealthTone;
  /** "just now", "2m ago": how long since the evidence was observed. */
  readonly observedAgo: string;
};

export const threadHealthView = (
  bindingId: string | undefined,
  now: number,
): ThreadHealthView | undefined => {
  if (!bindingId) return undefined;
  const assessment = seatAwareness$.byBindingId[bindingId].peek();
  const reading = assessment?.health;
  if (assessment === undefined || reading === undefined) return undefined;
  const freshness = threadHealthFreshness(reading, {
    now,
    evidenceDigest: assessment.evidence.digest,
    liveDigest: seatAwareness$.windowDigestByBindingId[bindingId].peek(),
  });
  return {
    reading,
    freshness,
    label: threadHealthLabel(reading, freshness, now),
    tone: THREAD_HEALTH_TONE[reading.value],
    observedAgo: formatSeatAwarenessAge(now - reading.observedAt),
  };
};

/** A probability as the whole percent the sidebar prints. */
export const healthPercent = (probability: number): string =>
  `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%`;

export type ThreadHealthSectionModel = {
  readonly tone: ThreadHealthHue;
  readonly headline: string;
  readonly confidence: string;
  /** Every other accepted property, so a mixed thread shows as mixed. */
  readonly alsoRead: ReadonlyArray<{ readonly label: string; readonly tone: ThreadHealthHue; readonly confidence: string }>;
  /** Section header meta; set only when the reading is no longer current. */
  readonly meta: string | undefined;
  readonly provenance: string;
};

export const threadHealthSectionModel = (view: ThreadHealthView): ThreadHealthSectionModel => {
  const { reading } = view;
  const model = reading.provenance.model;
  return {
    tone: THREAD_HEALTH_STATUS_TONE[view.tone],
    headline: THREAD_HEALTH_LABEL[reading.value],
    confidence: healthPercent(reading.confidence),
    alsoRead: reading.signals
      .filter((signal) => signal.value !== reading.value)
      .map((signal) => ({
        label: THREAD_HEALTH_LABEL[signal.value],
        tone: THREAD_HEALTH_STATUS_TONE[THREAD_HEALTH_TONE[signal.value]],
        confidence: healthPercent(signal.probability),
      })),
    meta: view.freshness === "stale" ? `last observed ${view.observedAgo}` : undefined,
    provenance:
      `Jev's reading of the screen, observed ${view.observedAgo}` +
      (model !== undefined ? ` by ${model}` : "") +
      ". Not the agent's own claim.",
  };
};

// --- clock ---------------------------------------------------------------------

/** Coarse shared clock: one interval for every mounted reader, stopped when none are. */
const HEALTH_CLOCK_MS = 15_000;
const healthClock$ = observable(Date.now());
let clockReaders = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;

export const useHealthClock = (): number => {
  useEffect(() => {
    clockReaders += 1;
    if (clockTimer === undefined) {
      healthClock$.set(Date.now());
      clockTimer = setInterval(() => healthClock$.set(Date.now()), HEALTH_CLOCK_MS);
    }
    return () => {
      clockReaders -= 1;
      if (clockReaders === 0 && clockTimer !== undefined) {
        clearInterval(clockTimer);
        clockTimer = undefined;
      }
    };
  }, []);
  return use$(healthClock$);
};

// --- hooks ---------------------------------------------------------------------

/** The seat's health for the sidebar: reading, freshness, and its label. */
export const useThreadHealth = (bindingId: string | undefined): ThreadHealthView | undefined => {
  use$(seatAwareness$.rev);
  const now = useHealthClock();
  return threadHealthView(bindingId, now);
};

/** Props for the card's activity mark rim, with the non-contradiction rule applied. */
export const useThreadHealthMark = (
  bindingId: string | undefined,
  signal: AgentSignalKind | undefined,
): ThreadHealthMark => {
  use$(seatAwareness$.rev);
  const now = useHealthClock();
  const view = threadHealthView(bindingId, now);
  if (view === undefined) return NO_MARK;
  return threadHealthMark(view.reading, { now, freshness: view.freshness, signal });
};
