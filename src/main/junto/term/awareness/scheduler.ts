/**
 * Awareness scheduler — cadence, coalescing, caps, budget, cache, and failure
 * policy for the advisory sidecar.
 *
 * Authority: read-only and advisory. The scheduler receives a settled grid
 * window reference plus deterministic seat facts, asks a bounded question pack
 * through an injected model port, and publishes advisory display. It has no
 * seat, no write decision, no delivery, no occupancy, and no canvas authority,
 * and it never acknowledges anything.
 *
 * Hot path: `observe()` is synchronous and does no I/O. It is called from
 * bounded background work scheduled off the observer plane's synchronous
 * listener, never from the listener itself. No code here awaits anything on the
 * deterministic path.
 *
 * Trigger discipline (a call is spent only on one of these):
 *   - first stable screen of a generation
 *   - a material control transition or new deterministic attention
 *   - materially different working text, at most once per 60s
 *   - one priority refresh per turn-stall or unresolved-delivery episode
 *   - a hover cache-miss, when budget permits
 * Never on spinner animation, byte increments, or attention heartbeats, and
 * never for an unchanged idle seat.
 *
 * The window digest is workstream C's normalization of the bounded redacted
 * evidence, handed in through the projection port. This file never computes a
 * second one: the cache key, the material-change trigger, and the renderer's
 * staleness comparison all read the same value.
 */

import { Context, Effect, Layer } from "effect";
import type { ObserverGridSnapshot } from "../observer";
import {
  AwarenessModel,
  isBreakerFailure,
  isRetryableFailure,
  runAwarenessAsk,
  type AwarenessAsk,
  type AwarenessAskOutcome,
  type AwarenessModelShape,
  type AwarenessTransportFailure,
  type AwarenessTransportFailureKind,
} from "./jev-client";
import type { AiConcernValue } from "./questions";
import type { AwarenessAssessment } from "./project-result";
import type {
  AwarenessEvidenceWindow,
  AwarenessRequestState,
  EvidenceLine,
} from "./select-input";

// ---------------------------------------------------------------------------
// Injected ports (owned by the evidence/projection workstream)
// ---------------------------------------------------------------------------

/** Deterministic, non-model seat facts. Read-only, synchronous, cheap. */
export type AwarenessSeatFacts = {
  /** Which harness occupies the seat. Part of the cache key. */
  readonly harness: string;
  /** Monotonic revision of deterministic control state (seat state, composer). */
  readonly controlRevision: number;
  /** Deterministic attention is present right now. */
  readonly attention: boolean;
  /**
   * Identity of the current stall-or-delivery episode, or undefined when none.
   * One priority refresh is spent per distinct episode.
   */
  readonly episode: string | undefined;
};

export interface AwarenessSeatPort {
  readonly facts: (bindingId: string) => AwarenessSeatFacts;
}

export type AwarenessProjection = {
  /** C's canonical request for this observation. */
  readonly state: AwarenessRequestState;
};

export interface AwarenessProjectionPort {
  /**
   * Project one observation. Pure, synchronous, and bounded by C's own caps.
   * The window is the non-flushing read from the observer; it must never be a
   * `readWindow` call, which would force grid settlement.
   */
  readonly project: (input: {
    readonly window: AwarenessEvidenceWindow;
    readonly facts: AwarenessSeatFacts;
  }) => AwarenessProjection;
}

// ---------------------------------------------------------------------------
// Timers and clock (injected so every bound is provable)
// ---------------------------------------------------------------------------

export type AwarenessTimers = {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

export const defaultAwarenessTimers: AwarenessTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending advisory refresh must never hold the process open.
    const unrefable = handle as unknown as { unref?: () => void };
    if (typeof unrefable.unref === "function") unrefable.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ---------------------------------------------------------------------------
// Advisory display
// ---------------------------------------------------------------------------

export type AwarenessTrigger = "first-screen" | "concern" | "working-text" | "hover";

/** Higher wins the fair queue. Hover first, then new concerns, then working text. */
const TRIGGER_PRIORITY: Record<AwarenessTrigger, number> = {
  hover: 3,
  concern: 2,
  "first-screen": 2,
  "working-text": 1,
};

/**
 * Availability as published to the renderer: never `not_assessed` and never
 * `stale`. Those two are renderer derivations (no assessment yet; and an
 * assessment whose window digest or turn moved on).
 */
export type AwarenessPublishedAvailability = "current" | "abstained" | "unavailable";

/** Honest reasons an assessment could not be produced. */
export type AwarenessPublishedUnavailableReason =
  | "missing_key"
  | "provider_failure"
  | "budget_exhausted"
  | "not_configured";

/**
 * One concern the model decisively ruled out for this observation, in the
 * renderer's own vocabulary. A non-empty list with no concerns is "checked and
 * clear", which is a different claim from "not assessed".
 */
export type AwarenessAbsence = {
  readonly concern: AiConcernValue;
  /** The Noul probability behind the absence, at or below the negative bar. */
  readonly probability: number;
};

/** Internal deterministic status. Diagnostics and doctor only. */
export type AwarenessAdvisoryStatus =
  /** No key: awareness is not running. */
  | "disabled"
  /** Nothing assessed yet for this generation. */
  | "none"
  /** Displayable answers, no failed attempt since. */
  | "fresh"
  /** Displayable answers, but the last provider attempt failed. */
  | "stale"
  /** Nothing displayable: the last attempt failed or the answers were unusable. */
  | "unavailable"
  /** Content aged out of its retention window. */
  | "expired"
  /** A cap, budget, or queue bound declined to spend a call. */
  | "refused";

/**
 * Producer-side advisory record. This is the main-process half of the renderer
 * wire contract: the parent's IPC maps it one-to-one onto
 * `SeatAwarenessAssessment` / `SeatAwarenessAssessmentEvent` /
 * `SeatAwarenessWindowEvent`.
 *
 *   assessmentId, availability, unavailableReason   -> assessment.availability
 *   absences                                        -> assessment.absences
 *   assessment.provenance.observedAt                -> assessment.observedAt
 *   assessment.activity.value                       -> assessment.activity
 *   assessment.concerns[].concern                   -> assessment.concerns
 *   assessment.highlight.lineId                     -> assessment.selectedLineId
 *   evidenceDigest, observedAt, evidenceLines       -> assessment.evidence
 *   windowDigest, windowCapturedAt                  -> window event / live digest
 *   status, reason                                  -> diagnostics only
 */
export type AwarenessAdvisory = {
  readonly bindingId: string;
  /** Generation the advisory belongs to. Retired epochs never display. */
  readonly epoch: string | undefined;
  /** Stable id of the observation. A replayed cache hit keeps its own. */
  readonly assessmentId: string | undefined;
  readonly assessment: AwarenessAssessment | undefined;
  /**
   * Concern absences: what the model looked at and decisively ruled out. Empty
   * means nothing was ruled out, not that nothing was assessed. Activity
   * absences are control-plane cross-checks and never appear here.
   */
  readonly absences: readonly AwarenessAbsence[];
  /**
   * Concerns whose question was asked but not decisively answered, exactly as
   * the projection reported them. Display content about concerns and nothing
   * else: it never reaches the control plane, and nothing is filtered out of it.
   * Empty means every concern the pack could ask was decisively answered, which
   * is the only case that supports the display's strong "checked and clear"
   * claim.
   */
  readonly unansweredConcerns: readonly AiConcernValue[];
  /** The judged observation's id -> line mapping: the only excerpt source. */
  readonly evidenceLines: readonly EvidenceLine[];
  /** Digest of the window the displayed assessment was made against. */
  readonly evidenceDigest: string | undefined;
  /** The live window: digest and capture time of the newest observation. */
  readonly windowDigest: string | undefined;
  readonly windowCapturedAt: number | undefined;
  readonly availability: AwarenessPublishedAvailability | undefined;
  readonly unavailableReason: AwarenessPublishedUnavailableReason | null;
  readonly status: AwarenessAdvisoryStatus;
  readonly reason: string | undefined;
  /** A request is coalescing or in flight right now. */
  readonly pending: boolean;
  readonly trigger: AwarenessTrigger | undefined;
};

const emptyAdvisory = (
  bindingId: string,
  status: AwarenessAdvisoryStatus,
  reason: string | undefined,
): AwarenessAdvisory => ({
  bindingId,
  epoch: undefined,
  assessmentId: undefined,
  assessment: undefined,
  absences: [],
  unansweredConcerns: [],
  evidenceLines: [],
  evidenceDigest: undefined,
  windowDigest: undefined,
  windowCapturedAt: undefined,
  availability: undefined,
  unavailableReason: null,
  status,
  reason,
  pending: false,
  trigger: undefined,
});

const advisorySignature = (advisory: AwarenessAdvisory): string =>
  [
    advisory.epoch ?? "",
    advisory.status,
    advisory.pending ? "1" : "0",
    advisory.reason ?? "",
    advisory.availability ?? "",
    advisory.unavailableReason ?? "",
    advisory.assessmentId ?? "",
    advisory.windowDigest ?? "",
    advisory.windowCapturedAt ?? "",
    advisory.evidenceDigest ?? "",
    advisory.trigger ?? "",
    advisory.absences.map((absence) => `${absence.concern}:${absence.probability}`).join(","),
    advisory.unansweredConcerns.join(","),
    advisory.evidenceLines.map((line) => `${line.id}=${line.text}`).join("\u0001"),
    advisory.assessment === undefined
      ? ""
      : [
          advisory.assessment.activity.value,
          advisory.assessment.activity.probability ?? "",
          advisory.assessment.concerns.map((concern) => concern.concern).join(","),
          // Accepted absences are a real verdict ("checked and clear"), never a
          // silent one: a change in them must reach the display.
          advisory.assessment.negatives
            .map((negative) => `${negative.concern}:${negative.probability}`)
            .join(","),
          advisory.assessment.highlight?.kind === "line" ? advisory.assessment.highlight.lineId : "",
          advisory.assessment.abstentions.length,
          advisory.assessment.rejections.length,
          advisory.assessment.provenance.evidenceHash,
        ].join("\u0003"),
  ].join("\u0002");

// ---------------------------------------------------------------------------
// Cost, caps, and budget
// ---------------------------------------------------------------------------

export type AwarenessPricing = {
  readonly inputUsdPerMTokens: number;
  readonly outputUsdPerMTokens: number;
};

export type AwarenessSchedulerConfig = {
  /** Coalescing window: observations inside it become one request. */
  readonly coalesceMs: number;
  /** Hard ceiling on how long a coalesced request may wait before dispatch. */
  readonly coalesceMaxWaitMs: number;
  readonly maxInFlightPerSeat: number;
  readonly maxInFlightStation: number;
  /** Bounded fair queue: how many seats may hold a pending request at once. */
  readonly maxQueuedSeats: number;
  readonly seatCallsPerHour: number;
  readonly stationCallsPerHour: number;
  readonly seatUsdPerHour: number;
  readonly stationUsdPerHour: number;
  readonly stationUsdPerDay: number;
  readonly workingTextIntervalMs: number;
  readonly cacheTtlMs: number;
  readonly temporalBucketMs: number;
  readonly maxCacheEntries: number;
  readonly transportBreakerFailures: number;
  readonly transportBreakerMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Published System One launch price: input tokens only, output free. */
  readonly pricing: AwarenessPricing;
  /** Bytes per input token. Below the real ratio, so the estimate rounds up. */
  readonly bytesPerToken: number;
  /** Fixed request overhead: instructions the transport always sends. */
  readonly promptOverheadTokens: number;
  /** Tokens one question's rendered prompt costs. */
  readonly tokensPerQuestion: number;
};

/**
 * Conservative defaults. The reservation rounds up on every axis, and it is
 * charged whether the call succeeds, fails, or is aborted; at the published
 * price the call caps bind before the dollar ceilings do.
 */
export const DEFAULT_AWARENESS_SCHEDULER_CONFIG: AwarenessSchedulerConfig = {
  coalesceMs: 300,
  coalesceMaxWaitMs: 500,
  maxInFlightPerSeat: 1,
  maxInFlightStation: 4,
  maxQueuedSeats: 16,
  seatCallsPerHour: 120,
  stationCallsPerHour: 1_000,
  seatUsdPerHour: 0.025,
  stationUsdPerHour: 0.2,
  stationUsdPerDay: 1,
  workingTextIntervalMs: 60_000,
  cacheTtlMs: 300_000,
  temporalBucketMs: 60_000,
  maxCacheEntries: 256,
  transportBreakerFailures: 3,
  transportBreakerMs: 30_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  pricing: { inputUsdPerMTokens: 0.042, outputUsdPerMTokens: 0 },
  bytesPerToken: 3,
  promptOverheadTokens: 256,
  tokensPerQuestion: 24,
};

/**
 * Worst-case reservation for one request, from the exact serialized payload
 * size and the number of questions actually sent. Rounds up on every axis.
 */
export const estimateAwarenessCallCost = (
  input: { readonly requestBytes: number; readonly questionCount: number },
  config: AwarenessSchedulerConfig,
): number => {
  const questions = Math.max(0, input.questionCount);
  const inputTokens =
    Math.ceil(Math.max(0, input.requestBytes) / Math.max(1, config.bytesPerToken)) +
    config.promptOverheadTokens +
    questions * config.tokensPerQuestion;
  const outputTokens = questions * config.tokensPerQuestion;
  return (
    (inputTokens / 1_000_000) * config.pricing.inputUsdPerMTokens +
    (outputTokens / 1_000_000) * config.pricing.outputUsdPerMTokens
  );
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Pending = {
  trigger: AwarenessTrigger;
  priority: number;
  firstAt: number;
};

type InFlight = {
  requestSeq: number;
  generationSeq: number;
  generation: string;
  cacheKey: string;
  trigger: AwarenessTrigger;
  controller: AbortController;
};

/** One observation's displayable content, with the mapping it was judged on. */
type Retained = {
  readonly assessment: AwarenessAssessment;
  readonly evidenceLines: readonly EvidenceLine[];
  readonly evidenceDigest: string;
  readonly assessmentId: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  /** False for an honest failure notice: nothing was judged. */
  readonly displayable: boolean;
};

type CacheEntry = Retained & {
  readonly key: string;
  readonly bindingId: string;
  readonly generation: string;
};

type Spend = { readonly at: number; readonly usd: number };

type Seat = {
  readonly bindingId: string;
  generation: string;
  generationSeq: number;
  requestSeq: number;
  facts: AwarenessSeatFacts | undefined;
  /** Geometry of the window the newest projection came from. */
  geometry: { readonly cols: number; readonly rows: number };
  state: AwarenessRequestState | undefined;
  projectedSeq: bigint | undefined;
  windowDigest: string | undefined;
  windowCapturedAt: number | undefined;
  // trigger memory
  sawGeneration: boolean;
  lastControlRevision: number | undefined;
  lastAttention: boolean | undefined;
  lastEpisode: string | undefined;
  lastDigest: string | undefined;
  lastDigestAskedAt: number | undefined;
  /**
   * Armed when the interval floor suppresses a material revision.
   *
   * Without it the re-ask depends on another observation arriving, and a seat
   * that goes quiet right after the change (a blocked dialog, a finished turn)
   * is never asked about it. Measured live: a seat whose screen changed during
   * the floor kept a judgment about the command line it had typed.
   */
  floorRecheck: unknown;
  floorRecheckDigest: string | undefined;
  /** Observation count when the recheck was armed, so it can tell quiet from busy. */
  floorRecheckAt: number;
  /** Observations seen for this seat, ever. */
  observations: number;
  // coalescing
  pending: Pending | undefined;
  pendingTimer: unknown;
  coalesceReady: boolean;
  // in flight
  inFlight: InFlight | undefined;
  // display
  retained: Retained | undefined;
  /** When displayable content was last retained, so an age-out can say so. */
  displayedAt: number | undefined;
  /** The last failed attempt's own words. */
  lastFailure: string | undefined;
  /** The gate that declined the last dispatch, when one did. */
  gate: string | undefined;
  /** The last refusal reason, when a bound declined to spend a call. */
  refused: string | undefined;
  trigger: AwarenessTrigger | undefined;
  advisorySignature: string;
  // failure
  consecutiveFailures: number;
  backoffUntil: number;
  // caps
  callTimes: number[];
  spend: Spend[];
};

export type AwarenessSchedulerStats = {
  /** False when no model is configured at all: no key, no client, no calls. */
  readonly enabled: boolean;
  /** Configured provider model id. */
  readonly model: string;
  readonly calls: number;
  /** Provider-reported input tokens, summed over this session. */
  readonly inputTokens: number;
  /** Reserved dollars, summed over this session. */
  readonly spentUsd: number;
  readonly cacheHits: number;
  readonly droppedStale: number;
  readonly droppedSuperseded: number;
  readonly refusals: Readonly<Record<string, number>>;
  readonly failures: Readonly<Record<AwarenessTransportFailureKind, number>>;
  readonly inFlight: number;
  readonly queued: number;
  readonly seats: number;
  readonly cacheEntries: number;
  readonly credentialBlocked: boolean;
  readonly breakerOpen: boolean;
};

export type AwarenessSchedulerShape = {
  /**
   * One observation. `window` is the non-flushing observer read for the settled
   * grid this snapshot names, and is absent when the runtime already delivered
   * that grid (no new bytes): the seat then evaluates its deterministic facts
   * against the evidence it already holds.
   */
  readonly observe: (
    snapshot: ObserverGridSnapshot,
    window?: AwarenessEvidenceWindow | undefined,
  ) => void;
  readonly hover: (bindingId: string) => AwarenessAdvisory;
  readonly advisory: (bindingId: string) => AwarenessAdvisory;
  /** A generation (or seat) is gone: drop its pending, in-flight, and cache. */
  readonly retire: (bindingId: string) => void;
  /** Configuration changed: clear the credential block, breaker, and backoff. */
  readonly reconfigure: () => void;
  readonly subscribe: (listener: (advisory: AwarenessAdvisory) => void) => () => void;
  /** Await in-flight requests. Test and shutdown seam only. */
  readonly drain: () => Promise<void>;
  readonly stats: () => AwarenessSchedulerStats;
};

/**
 * effect-foundation style service id: `@junto/AwarenessScheduler` — single
 * definition, no dual Live + `.layer` export.
 */
export class AwarenessScheduler extends Context.Service<AwarenessScheduler, AwarenessSchedulerShape>()(
  "@junto/AwarenessScheduler",
) {}

export type AwarenessSchedulerDeps = {
  readonly ask: (ask: AwarenessAsk, signal: AbortSignal) => Promise<AwarenessAskOutcome>;
  readonly unavailable: AwarenessModelShape["unavailable"];
  readonly modelId: string;
  readonly modelAvailable: boolean;
  readonly modelUnavailableReason: string | undefined;
  readonly seats: AwarenessSeatPort;
  readonly projection: AwarenessProjectionPort;
  readonly config?: Partial<AwarenessSchedulerConfig> | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: AwarenessTimers | undefined;
  readonly random?: (() => number) | undefined;
};

export const makeAwarenessScheduler = (deps: AwarenessSchedulerDeps): AwarenessSchedulerShape => {
  const config: AwarenessSchedulerConfig = {
    ...DEFAULT_AWARENESS_SCHEDULER_CONFIG,
    ...deps.config,
    pricing: { ...DEFAULT_AWARENESS_SCHEDULER_CONFIG.pricing, ...deps.config?.pricing },
  };
  const timers = deps.timers ?? defaultAwarenessTimers;
  const clock = deps.clock ?? Date.now;
  const random = deps.random ?? Math.random;
  const now = (): number => clock();

  const seats = new Map<string, Seat>();
  const cache = new Map<string, CacheEntry>();
  const listeners = new Set<(advisory: AwarenessAdvisory) => void>();
  const running = new Set<Promise<void>>();

  let stationCallTimes: number[] = [];
  let stationSpend: Spend[] = [];
  let inFlightCount = 0;
  let breakerFailures = 0;
  let breakerOpenUntil = 0;
  let credentialBlocked = false;
  let pumping = false;
  let wakeTimer: unknown;
  let expiryTimer: unknown;

  const stats = {
    calls: 0,
    inputTokens: 0,
    spentUsd: 0,
    cacheHits: 0,
    droppedStale: 0,
    droppedSuperseded: 0,
    refusals: {} as Record<string, number>,
    failures: {
      unavailable: 0,
      credential: 0,
      "rate-limited": 0,
      timeout: 0,
      transport: 0,
      aborted: 0,
    } as Record<AwarenessTransportFailureKind, number>,
  };

  const refuse = (reason: string): void => {
    stats.refusals[reason] = (stats.refusals[reason] ?? 0) + 1;
  };

  // -------------------------------------------------------------------------
  // Display derivation
  // -------------------------------------------------------------------------

  const retainedNow = (seat: Seat, t: number): Retained | undefined => {
    const retained = seat.retained;
    if (retained === undefined) return undefined;
    return retained.expiresAt > t ? retained : undefined;
  };

  /**
   * The projection's reason, in the renderer's own vocabulary. `missing_key` is
   * the producer's word for a key that was never configured, so it is decided by
   * the caller; everything the projection can report is either the shared
   * `not_configured`/`budget_exhausted` or a provider failure.
   */
  const publishedReasonFor = (
    reason: AwarenessAssessment["unavailableReason"],
  ): AwarenessPublishedUnavailableReason => {
    switch (reason) {
      case "not_configured":
        return "not_configured";
      case "budget_exhausted":
        return "budget_exhausted";
      default:
        return "provider_failure";
    }
  };

  const publishedFor = (
    assessment: AwarenessAssessment,
  ): { availability: AwarenessPublishedAvailability | undefined; unavailableReason: AwarenessPublishedUnavailableReason | null } => {
    switch (assessment.availability) {
      case "abstained":
        return { availability: "abstained", unavailableReason: null };
      case "unavailable":
        return {
          availability: "unavailable",
          unavailableReason: deps.modelAvailable
            ? publishedReasonFor(assessment.unavailableReason)
            : "missing_key",
        };
      default:
        // The projection's union is now `current | abstained | unavailable`,
        // so this arm is current and abstained; `stale` and `not_assessed` are
        // the renderer's derivations and never reach the scheduler.
        return { availability: "current", unavailableReason: null };
    }
  };

  /**
   * Accepted absences for the display. A concern's absence is the surface's
   * "checked and clear"; an activity property's absence is a cross-check the
   * control plane already owns, so it never travels.
   */
  const absencesFor = (assessment: AwarenessAssessment | undefined): readonly AwarenessAbsence[] => {
    if (assessment === undefined) return [];
    const absences: AwarenessAbsence[] = [];
    for (const negative of assessment.negatives) {
      if (negative.crossCheckOnly || negative.concern === undefined) continue;
      absences.push({ concern: negative.concern, probability: negative.probability });
    }
    return absences;
  };

  const buildAdvisory = (seat: Seat): AwarenessAdvisory => {
    const t = now();
    const retained = retainedNow(seat, t);
    const published = retained !== undefined ? publishedFor(retained.assessment) : undefined;
    const status: AwarenessAdvisoryStatus =
      seat.refused !== undefined
        ? "refused"
        : !deps.modelAvailable
          ? "disabled"
          : retained === undefined
            ? seat.displayedAt !== undefined
              ? "expired"
              : "none"
            : !retained.displayable
              ? "unavailable"
              : seat.lastFailure !== undefined
                ? "stale"
                : "fresh";
    return {
      bindingId: seat.bindingId,
      epoch: seat.generation,
      assessmentId: retained?.assessmentId,
      assessment: retained?.assessment,
      absences: absencesFor(retained?.assessment),
      unansweredConcerns: retained?.assessment.unansweredConcerns ?? [],
      evidenceLines: retained?.evidenceLines ?? [],
      evidenceDigest: retained?.evidenceDigest,
      windowDigest: seat.windowDigest,
      windowCapturedAt: seat.windowCapturedAt,
      availability: published?.availability,
      unavailableReason: published?.unavailableReason ?? null,
      status,
      reason: seat.refused ?? seat.gate ?? seat.lastFailure,
      pending: seat.pending !== undefined || seat.inFlight !== undefined,
      trigger: seat.trigger,
    };
  };

  const setAdvisory = (seat: Seat): void => {
    const next = buildAdvisory(seat);
    const signature = advisorySignature(next);
    seat.advisorySignature = signature;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error("[awareness] advisory listener failed:", error);
      }
    }
  };

  /** Emit only when the derived advisory actually changed. */
  const emit = (seat: Seat): void => {
    const next = buildAdvisory(seat);
    const signature = advisorySignature(next);
    if (signature === seat.advisorySignature) return;
    seat.advisorySignature = signature;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error("[awareness] advisory listener failed:", error);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Ledgers
  // -------------------------------------------------------------------------

  const pruneSpend = (ledger: Spend[], t: number): Spend[] => {
    const keepFrom = t - HOUR_MS;
    return ledger.length > 0 && ledger[0]!.at < keepFrom
      ? ledger.filter((entry) => entry.at >= keepFrom)
      : ledger;
  };

  const spendIn = (ledger: Spend[], t: number, windowMs: number): number => {
    const from = t - windowMs;
    let total = 0;
    for (const entry of ledger) if (entry.at >= from) total += entry.usd;
    return total;
  };

  const pruneCalls = (times: number[], t: number): number[] => {
    const keepFrom = t - HOUR_MS;
    return times.length > 0 && times[0]! < keepFrom ? times.filter((at) => at >= keepFrom) : times;
  };

  /** Reserve conservatively before sending. Returns a refusal reason, or undefined. */
  const reserve = (seat: Seat, usd: number, t: number): string | undefined => {
    seat.callTimes = pruneCalls(seat.callTimes, t);
    seat.spend = pruneSpend(seat.spend, t);
    stationCallTimes = pruneCalls(stationCallTimes, t);
    stationSpend = pruneSpend(stationSpend, t);
    if (seat.callTimes.length + 1 > config.seatCallsPerHour) return "seat call cap";
    if (stationCallTimes.length + 1 > config.stationCallsPerHour) return "station call cap";
    if (spendIn(seat.spend, t, HOUR_MS) + usd > config.seatUsdPerHour) return "seat budget";
    if (spendIn(stationSpend, t, HOUR_MS) + usd > config.stationUsdPerHour) return "station budget";
    if (spendIn(stationSpend, t, DAY_MS) + usd > config.stationUsdPerDay) {
      return "station daily budget";
    }
    // Charge the reservation now: failed and aborted attempts count.
    seat.callTimes.push(t);
    seat.spend.push({ at: t, usd });
    stationCallTimes.push(t);
    stationSpend.push({ at: t, usd });
    stats.spentUsd += usd;
    return undefined;
  };

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------

  const pruneCache = (t: number): void => {
    for (const [key, entry] of cache) if (entry.expiresAt <= t) cache.delete(key);
    if (cache.size <= config.maxCacheEntries) return;
    const ordered = [...cache.values()].sort((a, b) => a.observedAt - b.observedAt);
    for (const entry of ordered.slice(0, cache.size - config.maxCacheEntries)) {
      cache.delete(entry.key);
    }
  };

  const assessmentIdFor = (state: AwarenessRequestState): string =>
    `${state.evidenceHash}:${state.observedAt}`;

  /**
   * Cache identity: the projection's window digest plus generation, harness,
   * geometry, the relevant deterministic observations, question-pack version,
   * model, and a temporal bucket. Never `seq` alone.
   */
  const cacheKeyFor = (seat: Seat, t: number): string | undefined => {
    const facts = seat.facts;
    const state = seat.state;
    const digest = seat.windowDigest;
    if (facts === undefined || state === undefined || digest === undefined) return undefined;
    // Nothing askable: no call, no cost, no cache entry.
    if (state.questions.length === 0) return undefined;
    return [
      digest,
      seat.generation,
      facts.harness,
      `${seat.geometry.cols}x${seat.geometry.rows}`,
      `rev:${facts.controlRevision}`,
      `attn:${facts.attention ? 1 : 0}`,
      // The episode is part of the key, so one priority refresh per stall or
      // delivery episode is a real assessment, while a repeat of the same
      // episode is answered from cache.
      `episode:${facts.episode ?? ""}`,
      `pack:${state.packVersion}`,
      `model:${deps.modelId}`,
      `bucket:${Math.floor(t / config.temporalBucketMs)}`,
    ].join("\u0000");
  };

  // -------------------------------------------------------------------------
  // Retention expiry (one station timer, bounded)
  // -------------------------------------------------------------------------

  const armExpiryTimer = (): void => {
    let earliest: number | undefined;
    const consider = (at: number | undefined): void => {
      if (at === undefined) return;
      if (earliest === undefined || at < earliest) earliest = at;
    };
    for (const entry of cache.values()) consider(entry.expiresAt);
    for (const seat of seats.values()) consider(seat.retained?.expiresAt);
    if (expiryTimer !== undefined) {
      timers.clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (earliest === undefined) return;
    expiryTimer = timers.setTimeout(() => {
      expiryTimer = undefined;
      sweepExpired();
    }, Math.max(0, earliest - now()));
  };

  const sweepExpired = (): void => {
    const t = now();
    pruneCache(t);
    for (const seat of seats.values()) {
      if (seat.retained !== undefined && seat.retained.expiresAt <= t) {
        seat.retained = undefined;
        emit(seat);
      }
    }
    armExpiryTimer();
  };

  // -------------------------------------------------------------------------
  // Failure accounting
  // -------------------------------------------------------------------------

  const backoffFor = (failures: number): number => {
    const base = config.backoffBaseMs * 2 ** Math.max(0, failures - 1);
    const capped = Math.min(config.backoffMaxMs, base);
    // Jitter keeps a fleet of seats from retrying in lockstep.
    return Math.round(capped * (0.8 + random() * 0.4));
  };

  const gateFor = (seat: Seat, t: number): string | undefined => {
    if (!deps.modelAvailable) return deps.modelUnavailableReason ?? "Jev is not configured";
    if (credentialBlocked) return "Jev rejected the credential";
    if (t < breakerOpenUntil) return "Jev transport circuit breaker open";
    if (t < seat.backoffUntil) return "backing off after a failed Jev attempt";
    return undefined;
  };

  const armWake = (at: number | undefined): void => {
    if (wakeTimer !== undefined) {
      timers.clearTimeout(wakeTimer);
      wakeTimer = undefined;
    }
    if (at === undefined) return;
    wakeTimer = timers.setTimeout(() => {
      wakeTimer = undefined;
      pump();
    }, Math.max(0, at - now()));
  };

  // -------------------------------------------------------------------------
  // Coalescing and dispatch
  // -------------------------------------------------------------------------

  const clearPendingTimer = (seat: Seat): void => {
    if (seat.pendingTimer === undefined) return;
    timers.clearTimeout(seat.pendingTimer);
    seat.pendingTimer = undefined;
  };

  const clearFloorRecheck = (seat: Seat): void => {
    if (seat.floorRecheck !== undefined) timers.clearTimeout(seat.floorRecheck);
    seat.floorRecheck = undefined;
    seat.floorRecheckDigest = undefined;
  };

  /**
   * A material revision arrived while the interval floor was still closed.
   *
   * The floor exists so a busy seat cannot buy a call per repaint. But the
   * re-ask must not depend on more bytes: the screen that changed is often the
   * screen that then goes quiet. One timer per seat, for the digest that was
   * suppressed, fires when the floor expires and asks if that revision is still
   * the newest one.
   */
  const armFloorRecheck = (
    seat: Seat,
    digest: string,
    askedAt: number | undefined,
  ): void => {
    if (seat.floorRecheck !== undefined && seat.floorRecheckDigest === digest) return;
    // A bound already declined to spend on this seat. The refusal is published
    // and the seat's next transition re-drives it; a timer must not retry it.
    if (seat.refused !== undefined) return;
    clearFloorRecheck(seat);
    const dueAt = (askedAt ?? now()) + config.workingTextIntervalMs;
    seat.floorRecheckDigest = digest;
    seat.floorRecheckAt = seat.observations;
    seat.floorRecheck = timers.setTimeout(() => {
      seat.floorRecheck = undefined;
      seat.floorRecheckDigest = undefined;
      if (seat.refused !== undefined) return;
      // Bytes kept arriving after the suppression: the ordinary path owns this
      // material change, and this timer exists only for the seat that went
      // quiet. Without this guard a busy seat would get a second attempt (and a
      // second refusal) for the same revision.
      if (seat.observations !== seat.floorRecheckAt) return;
      const latest = seat.windowDigest;
      if (latest === undefined || latest === seat.lastDigest) return;
      // Something already queued or in flight will ask; this timer exists only
      // to cover the case where nothing else will, so it never adds an attempt
      // (and never an extra refusal) on top of one.
      if (seat.pending !== undefined || seat.inFlight !== undefined) return;
      const t = now();
      if (
        t - (seat.lastDigestAskedAt ?? Number.NEGATIVE_INFINITY) <
        config.workingTextIntervalMs
      ) {
        return;
      }
      seat.lastDigest = latest;
      seat.lastDigestAskedAt = t;
      enqueue(seat, "working-text");
    }, Math.max(0, dueAt - now()));
  };

  const armPendingTimer = (seat: Seat): void => {
    const pending = seat.pending;
    if (pending === undefined) return;
    // Debounce with a maximum wait: each observation restarts the coalescing
    // window, but the request never waits longer than `coalesceMaxWaitMs`
    // after the first observation in the batch.
    if (seat.pendingTimer !== undefined) timers.clearTimeout(seat.pendingTimer);
    const dispatchAt = Math.min(
      now() + config.coalesceMs,
      pending.firstAt + config.coalesceMaxWaitMs,
    );
    seat.pendingTimer = timers.setTimeout(() => {
      seat.pendingTimer = undefined;
      seat.coalesceReady = true;
      pump();
    }, Math.max(0, dispatchAt - now()));
  };

  const queuedSeats = (): Seat[] => {
    const out: Seat[] = [];
    for (const seat of seats.values()) if (seat.pending !== undefined) out.push(seat);
    out.sort((a, b) => {
      const pa = a.pending!;
      const pb = b.pending!;
      if (pb.priority !== pa.priority) return pb.priority - pa.priority;
      if (pa.firstAt !== pb.firstAt) return pa.firstAt - pb.firstAt;
      return a.bindingId < b.bindingId ? -1 : 1;
    });
    return out;
  };

  /**
   * Bounded fair queue. A higher-priority arrival may displace the lowest
   * pending request; anything else is dropped rather than queued forever.
   */
  const admitToQueue = (trigger: AwarenessTrigger): boolean => {
    const pending = queuedSeats();
    if (pending.length < config.maxQueuedSeats) return true;
    const lowest = pending[pending.length - 1]!;
    if (TRIGGER_PRIORITY[trigger] <= lowest.pending!.priority) {
      refuse("queue full");
      return false;
    }
    const victim = seats.get(lowest.bindingId);
    if (victim === undefined) return true;
    clearPendingTimer(victim);
    victim.pending = undefined;
    victim.coalesceReady = false;
    // The displaced seat is no longer waiting on anything; say so.
    emit(victim);
    return true;
  };

  const enqueue = (seat: Seat, trigger: AwarenessTrigger): void => {
    const priority = TRIGGER_PRIORITY[trigger];
    const existing = seat.pending;
    if (existing === undefined) {
      if (!admitToQueue(trigger)) return;
      const created: Pending = { trigger, priority, firstAt: now() };
      seat.pending = created;
      seat.trigger = created.trigger;
    } else {
      existing.priority = Math.max(existing.priority, priority);
      if (priority > TRIGGER_PRIORITY[existing.trigger]) existing.trigger = trigger;
      seat.trigger = existing.trigger;
    }
    armPendingTimer(seat);
    pump();
    // Reflect the pending slot immediately, even when coalescing has not
    // dispatched yet.
    emit(seat);
  };

  const recordFailure = (
    seat: Seat,
    failure: AwarenessTransportFailure,
    t: number,
  ): void => {
    stats.failures[failure.kind] = (stats.failures[failure.kind] ?? 0) + 1;
    seat.lastFailure = failure.message;
    if (failure.kind === "credential") credentialBlocked = true;
    if (isRetryableFailure(failure.kind)) {
      seat.consecutiveFailures += 1;
      seat.backoffUntil = t + backoffFor(seat.consecutiveFailures);
    }
    if (isBreakerFailure(failure.kind)) {
      breakerFailures += 1;
      if (breakerFailures >= config.transportBreakerFailures) {
        breakerOpenUntil = t + config.transportBreakerMs;
      }
    }
  };

  const complete = (seat: Seat, request: InFlight, outcome: AwarenessAskOutcome): void => {
    inFlightCount = Math.max(0, inFlightCount - 1);
    if (seat.inFlight !== undefined && seat.inFlight.requestSeq === request.requestSeq) {
      seat.inFlight = undefined;
    }
    const t = now();
    // Retired generation or superseded request: the answer belongs to a world
    // that no longer exists. Never cached, never displayed.
    if (seat.generationSeq !== request.generationSeq || seat.generation !== request.generation) {
      stats.droppedStale += 1;
      pump();
      return;
    }
    if (seat.requestSeq !== request.requestSeq) {
      stats.droppedSuperseded += 1;
      pump();
      return;
    }
    if (outcome.usage !== undefined) stats.inputTokens += outcome.usage.inputTokens;
    seat.gate = undefined;
    const state = seat.state;
    const digest = seat.windowDigest;
    if (outcome.failure !== undefined) {
      recordFailure(seat, outcome.failure, t);
    } else {
      seat.consecutiveFailures = 0;
      seat.backoffUntil = 0;
      seat.lastFailure = undefined;
      breakerFailures = 0;
    }
    const availability = outcome.assessment.availability;
    // The projection publishes only current, abstained or unavailable: `stale`
    // and `not_assessed` are the renderer's derivations and never arrive here.
    const displayable = availability === "current" || availability === "abstained";
    // `unavailable` carries a failure but no verdict, so it is retained rather
    // than displayed: whatever was there before stays, and a seat that has
    // never been assessed still says so.
    const retainable = displayable || availability === "unavailable";
    const retained: Retained | undefined =
      retainable && state !== undefined && digest !== undefined
        ? {
            assessment: outcome.assessment,
            evidenceLines: state.evidenceLines,
            evidenceDigest: digest,
            assessmentId: assessmentIdFor(state),
            observedAt: state.observedAt,
            expiresAt: t + config.cacheTtlMs,
            displayable,
          }
        : undefined;
    if (retained !== undefined) {
      if (displayable) {
        // Retain the answer so an identical observation costs nothing.
        const entry: CacheEntry = {
          ...retained,
          key: request.cacheKey,
          bindingId: seat.bindingId,
          generation: seat.generation,
        };
        cache.set(entry.key, entry);
        pruneCache(t);
        seat.retained = entry;
        seat.displayedAt = t;
      } else if (seat.retained === undefined || !seat.retained.displayable) {
        // Nothing displayable is held, so the honest notice takes the slot.
        seat.retained = retained;
      }
      armExpiryTimer();
    }
    emit(seat);
    pump();
  };

  const dispatch = (seat: Seat, pending: Pending): void => {
    clearPendingTimer(seat);
    seat.pending = undefined;
    seat.coalesceReady = false;
    seat.gate = undefined;

    const t = now();
    const state = seat.state;
    const key = cacheKeyFor(seat, t);
    if (state === undefined || key === undefined) {
      // Nothing worth asking about: no reservation, no call, no cost.
      emit(seat);
      return;
    }
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > t) {
      // A cache hit is not a new assessment: no call, no spend, no refresh.
      stats.cacheHits += 1;
      seat.retained = hit;
      seat.refused = undefined;
      emit(seat);
      return;
    }
    const estimate = estimateAwarenessCallCost(
      { requestBytes: state.serializedBytes, questionCount: state.questions.length },
      config,
    );
    const refusal = reserve(seat, estimate, t);
    if (refusal !== undefined) {
      refuse(refusal);
      seat.refused = refusal;
      // A cap or budget bound declined the call, and no call is charged for
      // saying so. A seat holding a judgment keeps it; a seat with nothing
      // displayable is owed one honest notice, in the renderer's own vocabulary.
      if (seat.retained === undefined || !seat.retained.displayable) {
        seat.retained = {
          assessment: deps.unavailable({
            request: state,
            reason: "budget_exhausted",
            detail: refusal,
          }),
          evidenceLines: state.evidenceLines,
          evidenceDigest: seat.windowDigest ?? state.evidenceHash,
          assessmentId: assessmentIdFor(state),
          observedAt: state.observedAt,
          expiresAt: t + config.cacheTtlMs,
          displayable: false,
        };
        armExpiryTimer();
      }
      emit(seat);
      return;
    }
    seat.refused = undefined;

    const controller = new AbortController();
    const requestSeq = seat.requestSeq + 1;
    seat.requestSeq = requestSeq;
    const request: InFlight = {
      requestSeq,
      generationSeq: seat.generationSeq,
      generation: seat.generation,
      cacheKey: key,
      trigger: pending.trigger,
      controller,
    };
    seat.inFlight = request;
    seat.trigger = pending.trigger;
    inFlightCount += 1;
    stats.calls += 1;
    emit(seat);

    const ask: AwarenessAsk = { request: state, harness: seat.facts?.harness ?? "" };
    const task = (async (): Promise<void> => {
      let outcome: AwarenessAskOutcome;
      try {
        outcome = await deps.ask(ask, controller.signal);
      } catch (error) {
        outcome = {
          assessment: deps.unavailable({
            request: state,
            reason: "transport_error",
            detail: error instanceof Error ? error.message : String(error),
          }),
          failure: {
            kind: "transport",
            message: error instanceof Error ? error.message : String(error),
            status: undefined,
            retryable: true,
          },
          usage: undefined,
        };
      }
      complete(seat, request, outcome);
    })();
    running.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        running.delete(task);
      });
  };

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      const t = now();
      let gateWakeAt: number | undefined;
      for (const seat of queuedSeats()) {
        if (inFlightCount >= config.maxInFlightStation) break;
        if (seat.inFlight !== undefined) continue;
        const pending = seat.pending;
        if (pending === undefined) continue;
        const ready = seat.coalesceReady || t >= pending.firstAt + config.coalesceMaxWaitMs;
        if (!ready) continue;
        const gate = gateFor(seat, t);
        if (gate !== undefined) {
          const next =
            t < breakerOpenUntil
              ? breakerOpenUntil
              : t < seat.backoffUntil
                ? seat.backoffUntil
                : undefined;
          if (next !== undefined) {
            gateWakeAt = gateWakeAt === undefined ? next : Math.min(gateWakeAt, next);
          }
          seat.refused = undefined;
          seat.gate = gate;
          // A seat with nothing displayable is owed one honest notice: the
          // provider could not be asked (or answered), and no call is charged
          // for saying so. A seat holding a fresh judgment keeps it instead.
          if (
            seat.state !== undefined &&
            (seat.retained === undefined || !seat.retained.displayable)
          ) {
            seat.retained = {
              assessment: deps.unavailable({
                request: seat.state,
                reason: deps.modelAvailable ? "transport_error" : "not_configured",
                detail: gate,
              }),
              evidenceLines: seat.state.evidenceLines,
              evidenceDigest: seat.windowDigest ?? seat.state.evidenceHash,
              assessmentId: assessmentIdFor(seat.state),
              observedAt: seat.state.observedAt,
              expiresAt: t + config.cacheTtlMs,
              displayable: false,
            };
            armExpiryTimer();
          }
          emit(seat);
          continue;
        }
        dispatch(seat, pending);
      }
      armWake(gateWakeAt);
    } finally {
      pumping = false;
    }
  };

  // -------------------------------------------------------------------------
  // Observation and trigger evaluation
  // -------------------------------------------------------------------------

  const readFacts = (bindingId: string): AwarenessSeatFacts | undefined => {
    try {
      return deps.seats.facts(bindingId);
    } catch (error) {
      console.error("[awareness] seat facts port failed:", error);
      return undefined;
    }
  };

  const createSeat = (snapshot: ObserverGridSnapshot): Seat => {
    const seat: Seat = {
      bindingId: snapshot.bindingId,
      generation: snapshot.epoch,
      generationSeq: 1,
      requestSeq: 0,
      facts: undefined,
      geometry: { cols: snapshot.cols, rows: snapshot.rows },
      state: undefined,
      projectedSeq: undefined,
      windowDigest: undefined,
      windowCapturedAt: undefined,
      sawGeneration: false,
      lastControlRevision: undefined,
      lastAttention: undefined,
      lastEpisode: undefined,
      lastDigest: undefined,
      lastDigestAskedAt: undefined,
      floorRecheck: undefined,
      floorRecheckDigest: undefined,
      floorRecheckAt: 0,
      observations: 0,
      pending: undefined,
      pendingTimer: undefined,
      coalesceReady: false,
      inFlight: undefined,
      retained: undefined,
      displayedAt: undefined,
      lastFailure: undefined,
      gate: undefined,
      refused: undefined,
      trigger: undefined,
      advisorySignature: "",
      consecutiveFailures: 0,
      backoffUntil: 0,
      callTimes: [],
      spend: [],
    };
    seat.advisorySignature = advisorySignature(buildAdvisory(seat));
    return seat;
  };

  /** Generation changed: the old generation's work and display are retired. */
  const retireGeneration = (seat: Seat): void => {
    clearPendingTimer(seat);
    seat.pending = undefined;
    seat.coalesceReady = false;
    if (seat.inFlight !== undefined) {
      seat.inFlight.controller.abort();
      seat.inFlight = undefined;
    }
    for (const [key, entry] of cache) {
      if (entry.bindingId === seat.bindingId) cache.delete(key);
    }
    seat.sawGeneration = false;
    seat.lastControlRevision = undefined;
    seat.lastAttention = undefined;
    seat.lastEpisode = undefined;
    seat.lastDigest = undefined;
    seat.lastDigestAskedAt = undefined;
    seat.generationSeq += 1;
    seat.requestSeq += 1;
    seat.state = undefined;
    seat.projectedSeq = undefined;
    seat.windowDigest = undefined;
    seat.windowCapturedAt = undefined;
    seat.facts = undefined;
    seat.retained = undefined;
    seat.displayedAt = undefined;
    seat.lastFailure = undefined;
    seat.gate = undefined;
    seat.refused = undefined;
    seat.trigger = undefined;
    seat.consecutiveFailures = 0;
    seat.backoffUntil = 0;
    emit(seat);
  };

  /**
   * One observation. The window is the observer's non-flushing read
   * (`readWindowNow`), never `readWindow`, which awaits `settled()` and would
   * turn background analysis into a parser scheduling change.
   */
  const observe = (
    snapshot: ObserverGridSnapshot,
    window: AwarenessEvidenceWindow | undefined,
  ): void => {
    let seat = seats.get(snapshot.bindingId);
    if (seat === undefined) {
      seat = createSeat(snapshot);
      seats.set(snapshot.bindingId, seat);
    } else if (seat.generation !== snapshot.epoch) {
      retireGeneration(seat);
      seat.generation = snapshot.epoch;
    }
    const current = seat;
    current.observations += 1;

    const facts = readFacts(snapshot.bindingId);
    if (facts === undefined) return;
    current.facts = facts;
    current.geometry = { cols: snapshot.cols, rows: snapshot.rows };

    // The projection is bounded work, and it is only worth running when the
    // grid moved: the window's PTY sequence identifies it exactly. A window is
    // absent when the runtime already delivered that grid, in which case the
    // seat evaluates its deterministic facts against the evidence it holds.
    if (window !== undefined && (current.state === undefined || current.projectedSeq !== window.seq)) {
      try {
        const projection = deps.projection.project({ window, facts });
        current.state = projection.state;
        current.projectedSeq = window.seq;
        // `evidenceHash` is C's `computeWindowDigest` output: the single
        // normalization the cache key, the material-change trigger, and the
        // renderer's staleness comparison all read. The capture time is paired
        // with it: the window event says "this material revision was captured
        // at this time", so a repaint that normalizes away moves neither half.
        const digest = projection.state.evidenceHash;
        if (current.windowDigest === undefined || digest !== current.windowDigest) {
          current.windowDigest = digest;
          current.windowCapturedAt = projection.state.observedAt;
        }
      } catch (error) {
        console.error("[awareness] projection port failed:", error);
        return;
      }
    }

    const state = current.state;
    if (state === undefined) return;
    const t = now();
    const firstScreen = !current.sawGeneration;
    current.sawGeneration = true;
    if (firstScreen) enqueue(current, "first-screen");

    // Material control transition or a new deterministic attention edge. An
    // attention heartbeat (still true, same revision) is never a trigger.
    const controlChanged =
      current.lastControlRevision !== undefined && facts.controlRevision !== current.lastControlRevision;
    const attentionRise = current.lastAttention === false && facts.attention;
    current.lastControlRevision = facts.controlRevision;
    current.lastAttention = facts.attention;
    if (controlChanged || attentionRise) enqueue(current, "concern");

    // One priority refresh per stall or unresolved-delivery episode.
    if (facts.episode !== undefined && facts.episode !== current.lastEpisode) {
      enqueue(current, "concern");
    }
    current.lastEpisode = facts.episode;

    // Materially different working text, at most once per interval. The digest
    // normalizes volatile chrome away, so a spinner frame or a counter tick
    // costs nothing and an unchanged idle seat costs nothing at all.
    const digest = current.windowDigest;
    if (digest !== undefined) {
      const first = current.lastDigest === undefined;
      const askedAt = current.lastDigestAskedAt;
      const floorPassed =
        t - (askedAt ?? Number.NEGATIVE_INFINITY) >= config.workingTextIntervalMs;
      if (first || (digest !== current.lastDigest && floorPassed)) {
        current.lastDigest = digest;
        // The first screen of a generation is already an ask, so it starts the
        // interval clock rather than spending a second trigger on the same
        // material.
        current.lastDigestAskedAt = t;
        clearFloorRecheck(current);
        if (!first) enqueue(current, "working-text");
      } else if (!first && digest !== current.lastDigest) {
        armFloorRecheck(current, digest, askedAt);
      }
    }

    // A window that moved is display-relevant even when no call is spent.
    emit(current);
  };

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  return {
    observe,
    hover: (bindingId) => {
      const seat = seats.get(bindingId);
      if (seat === undefined) return emptyAdvisory(bindingId, "none", undefined);
      const t = now();
      const key = cacheKeyFor(seat, t);
      if (key !== undefined) {
        const hit = cache.get(key);
        if (hit !== undefined && hit.expiresAt > t) {
          stats.cacheHits += 1;
          seat.retained = hit;
          seat.refused = undefined;
          seat.trigger = "hover";
          emit(seat);
          return buildAdvisory(seat);
        }
      }
      enqueue(seat, "hover");
      return buildAdvisory(seat);
    },
    advisory: (bindingId) => {
      const seat = seats.get(bindingId);
      return seat === undefined
        ? emptyAdvisory(bindingId, "none", undefined)
        : buildAdvisory(seat);
    },
    retire: (bindingId) => {
      const seat = seats.get(bindingId);
      if (seat === undefined) return;
      clearPendingTimer(seat);
      clearFloorRecheck(seat);
      seat.pending = undefined;
      if (seat.inFlight !== undefined) {
        seat.inFlight.controller.abort();
        seat.inFlight = undefined;
      }
      for (const [key, entry] of cache) {
        if (entry.bindingId === bindingId) cache.delete(key);
      }
      seats.delete(bindingId);
      for (const listener of listeners) {
        try {
          listener(emptyAdvisory(bindingId, "none", undefined));
        } catch (error) {
          console.error("[awareness] advisory listener failed:", error);
        }
      }
    },
    reconfigure: () => {
      credentialBlocked = false;
      breakerFailures = 0;
      breakerOpenUntil = 0;
      for (const seat of seats.values()) {
        seat.consecutiveFailures = 0;
        seat.backoffUntil = 0;
        seat.refused = undefined;
      }
      armWake(undefined);
      pump();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    drain: () => Promise.all([...running]).then(() => undefined),
    stats: () => ({
      enabled: deps.modelAvailable,
      model: deps.modelId,
      calls: stats.calls,
      inputTokens: stats.inputTokens,
      spentUsd: stats.spentUsd,
      cacheHits: stats.cacheHits,
      droppedStale: stats.droppedStale,
      droppedSuperseded: stats.droppedSuperseded,
      refusals: { ...stats.refusals },
      failures: { ...stats.failures },
      inFlight: inFlightCount,
      queued: queuedSeats().length,
      seats: seats.size,
      cacheEntries: cache.size,
      credentialBlocked,
      breakerOpen: now() < breakerOpenUntil,
    }),
  };
};

export type AwarenessSchedulerLiveOptions = Omit<
  AwarenessSchedulerDeps,
  "ask" | "unavailable" | "modelId" | "modelAvailable" | "modelUnavailableReason"
>;

/**
 * Bind the pure scheduler to the Effect model service. The Effect runtime is
 * captured once here so the observer-facing path stays synchronous.
 */
export const makeAwarenessSchedulerLive = (
  options: AwarenessSchedulerLiveOptions,
): Layer.Layer<AwarenessScheduler, never, AwarenessModel> =>
  Layer.effect(
    AwarenessScheduler,
    Effect.gen(function* () {
      const model = yield* AwarenessModel;
      const runtime = yield* Effect.context<never>();
      return AwarenessScheduler.of(
        makeAwarenessScheduler({
          ...options,
          modelId: model.id,
          modelAvailable: model.available,
          modelUnavailableReason: model.reason,
          unavailable: model.unavailable,
          ask: (ask, signal) => runAwarenessAsk(runtime, model, ask, signal),
        }),
      );
    }),
  );
