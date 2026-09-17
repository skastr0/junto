/**
 * Trace-complete replay of a committed capture.
 *
 * `tests/pty-e2e/runner.ts` is the product-law harness and stays as it is: it
 * disables the mid-turn watchdog, uses a frozen clock, and returns
 * `currentEvents()` (one row per live binding) instead of the event history.
 * That is the right shape for "is the final projection correct", and the wrong
 * shape for "does the whole deterministic trace agree".
 *
 * This module adds, without touching the runner:
 *
 *  1. CONTROLLED TIME — `now()` is driven by the capture's own recorded
 *     timestamps, so every published event's `at` stamp is the capture-relative
 *     elapsed time the seat really saw. Time is monotonic from the first event.
 *  2. A FULL EVENT LOG — every event the runtime publishes, in publication
 *     order, collected through the runtime's own `onEvent` seam. The final
 *     `currentEvents()` projection is returned beside it so the difference
 *     between "trace" and "projection" is inspectable rather than assumed.
 *  3. REAL GEOMETRY — `cols`/`rows` come from each capture's own manifest and
 *     a capture that does not declare them throws instead of silently running
 *     at a default.
 *  4. ONE PASS — the capture is replayed once and snapshotted on the union of
 *     two step grids: every captured PTY write (`event`) and every
 *     `floor(length * i / steps)` cut (`fraction`, the grid the parent's
 *     proof-of-concept used). A single pass is byte-for-byte equivalent to
 *     re-feeding each prefix into a fresh terminal, at a fraction of the cost.
 *
 * The mid-turn watchdog is ENABLED here (the runner disables it). Note what
 * that does and does not buy, measured rather than assumed — see below.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSeatState, AgentSeatStateEvent } from "../../../src/shared/agent-seat-state";
import { SessionObserver } from "../../../src/main/junto/term/observer";
import type { ObserverGridSnapshot } from "../../../src/main/junto/term/observer/types";
import { SeatStateRuntime } from "../../../src/main/junto/term/agent-state/runtime";
import { TURN_STALLED_REASON } from "../../../src/main/junto/term/agent-state/turn-progress-watch";
import { corpusRoot, loadP1Fixture, type SeatSlotProjection } from "../runner";
import type { CaptureGeometry, StepGrid } from "./types";

export const DEFAULT_FRACTION_STEPS = 400;
export const DEFAULT_TURN_STALL_MS = 90_000;
export const BINDING_ID = "seat-1";
export const EPOCH = "e1";

/**
 * The mid-turn watchdog runs here with the product's own `TurnProgressWatch` on
 * real timers — the runner disables it. Two measured facts follow, and the
 * harness records them instead of inventing a stall the product would not
 * produce (see `replay.test.ts`):
 *
 *  1. `TurnProgressWatch.arm`/`noteProgress` stamp `lastProgressAt = now()` and
 *     then compute `remaining = stallMs - (now() - lastProgressAt)`, so
 *     `remaining` is always exactly `stallMs` and only REAL elapsed time can
 *     fire the timer. A replayed clock never reaches the deadline.
 *  2. `progressFingerprint` includes the snapshot `seq`, which advances on every
 *     PTY write, so any output at all — including a static spinner repaint —
 *     resets the deadline.
 *
 * Replay-based stall coverage therefore needs a fake-timer harness or a
 * clock-injectable deadline. Neither is this module's to add.
 */

export type ReplayStep = {
  readonly grid: StepGrid;
  readonly step: number;
  readonly steps: number;
  readonly cut: number;
  readonly cutFraction: number;
  /** Capture-relative elapsed ms at this cut, from the recorded timestamps. */
  /** Capture-relative elapsed ms at this cut (`clockMs - clockBaseMs`). */
  readonly atMs: number;
  readonly snapshot: ObserverGridSnapshot;
  /**
   * The deterministic control plane's published state at this cut. Exposed so
   * an advisory answer can be CROSS-CHECKED against it (the contract's job for
   * a `turn_in_progress` negative) without a second replay. It is never an
   * input to a label: `labels.ts` cannot reach this module.
   */
  readonly seatState: AgentSeatState | undefined;
  readonly seatReason: string | undefined;
};

export type ReplayTrace = {
  readonly harness: string;
  readonly scenario: string;
  readonly capturePath: string;
  readonly geometry: CaptureGeometry;
  readonly decodedLength: number;
  readonly rawBytes: number;
  readonly capture: {
    readonly events: number;
    readonly firstTimestampMs: number;
    readonly lastTimestampMs: number;
    readonly elapsedMs: number;
  };
  readonly watchdog: "enabled";
  readonly turnStallMs: number;
  /** Epoch-ms base the replayed clock is anchored to (the capture's first `t`). */
  readonly clockBaseMs: number;
  /** Every event the runtime published, in order. */
  readonly trace: readonly AgentSeatStateEvent[];
  /** What `runner.ts` would have returned: one row per live binding. */
  readonly currentEvents: readonly AgentSeatStateEvent[];
  /** `turn-stalled` attention events, if the real watchdog ever fired. */
  readonly stalls: readonly AgentSeatStateEvent[];
  readonly finalSlot: SeatSlotProjection | undefined;
  readonly isSeatIdle: boolean;
  readonly stepsVisited: number;
  /** A stable digest of the deterministic trace, for cross-run comparison. */
  readonly traceDigest: string;
};

/** Stable JSON of an event with its fields in a fixed order. */
const eventKey = (e: AgentSeatStateEvent): string =>
  JSON.stringify([e.bindingId, e.epoch, e.state, e.reason, e.confidence, e.at, e.harness ?? null]);

export const digestTrace = (events: readonly AgentSeatStateEvent[]): string => {
  const joined = events.map(eventKey).join("\n");
  // Small, dependency-free FNV-1a over the canonical event list.
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, "0")}:${events.length}`;
};

/** Geometry, read from the capture's manifest. Never defaulted. */
export const captureGeometry = (harness: string): CaptureGeometry => {
  const manifestPath = join(corpusRoot(), harness, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `no capture manifest for ${harness} at ${manifestPath}; geometry must come from the capture, never a default`,
    );
  }
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    pty?: { cols?: number; rows?: number };
  };
  const cols = raw.pty?.cols;
  const rows = raw.pty?.rows;
  if (typeof cols !== "number" || typeof rows !== "number") {
    throw new Error(
      `capture manifest for ${harness} declares no pty.cols/pty.rows (${manifestPath}); ` +
        `geometry must come from the capture, never a default`,
    );
  }
  return { cols, rows, source: `${harness}/manifest.json pty.cols/pty.rows` };
};

export const decodeEvents = (
  events: readonly { readonly t: number; readonly b64: string }[],
): { readonly parts: readonly string[]; readonly at: readonly number[] } => {
  const parts: string[] = [];
  const at: number[] = [];
  for (const ev of events) {
    parts.push(Buffer.from(ev.b64, "base64").toString("utf8"));
    at.push(ev.t);
  }
  return { parts, at };
};

type GridEntry = {
  readonly cut: number;
  readonly grid: StepGrid;
  readonly step: number;
  readonly steps: number;
};

/** Union of the event grid and the fraction grid, ascending and deduped. */
export const buildGrid = (
  decodedLength: number,
  fractionSteps: number,
  eventEnds: readonly number[],
): readonly GridEntry[] => {
  const byCut = new Map<number, GridEntry>();
  for (let i = 1; i <= fractionSteps; i++) {
    const cut = Math.floor((decodedLength * i) / fractionSteps);
    if (cut <= 0 || byCut.has(cut)) continue;
    byCut.set(cut, { cut, grid: "fraction", step: i, steps: fractionSteps });
  }
  eventEnds.forEach((cut, index) => {
    if (cut <= 0) return;
    byCut.set(cut, { cut, grid: "event", step: index + 1, steps: eventEnds.length });
  });
  return [...byCut.values()].sort((a, b) => a.cut - b.cut);
};

/**
 * No timer drain is needed around `observe`, and that is a property of the
 * product rather than an omission: with `setWriteIntervalMs(0)` the observer
 * never arms a flush timer (`maybeFlush` flushes inline when `floorWaitMs()`
 * is <= 0, and `settled()` flushes synchronously before `snapshot()`), and the
 * mid-turn watchdog always schedules `stallMs` ahead of itself because
 * `arm`/`noteProgress` stamp `lastProgressAt = now()` before computing
 * `remaining`. A replay therefore has no pending zero-delay timer whose
 * ordering could depend on the scheduler, so `replay.ts` needs no drain — the
 * trace is ordered by the feed loop alone.
 */

export type ReplayOptions = {
  readonly harness: string;
  readonly scenario: string;
  readonly fractionSteps?: number;
  readonly turnStallMs?: number;
  /** Consume each sampled step. Snapshots are not retained after it returns. */
  readonly onStep?: (step: ReplayStep) => void;
};

/**
 * Replay one committed capture in a single pass and return its full
 * deterministic trace.
 */
export const replayCapture = async (opts: ReplayOptions): Promise<ReplayTrace> => {
  const fixture = loadP1Fixture(opts.harness, opts.scenario);
  if (!fixture) {
    throw new Error(
      `no committed capture for ${opts.harness}/${opts.scenario} under ${corpusRoot()}`,
    );
  }
  const geometry = captureGeometry(opts.harness);
  const fractionSteps = opts.fractionSteps ?? DEFAULT_FRACTION_STEPS;
  const turnStallMs = opts.turnStallMs ?? DEFAULT_TURN_STALL_MS;

  const { parts, at } = decodeEvents(fixture.events);
  const blob = parts.join("");
  const decodedLength = blob.length;
  const rawBytes = fixture.events.reduce(
    (sum, ev) => sum + Buffer.from(ev.b64, "base64").length,
    0,
  );
  const eventEnds: number[] = [];
  let acc = 0;
  for (const part of parts) {
    acc += part.length;
    eventEnds.push(acc);
  }
  const firstTimestampMs = at[0] ?? 0;
  const lastTimestampMs = at[at.length - 1] ?? firstTimestampMs;
  const elapsedMs = Math.max(0, lastTimestampMs - firstTimestampMs);

  const grid = buildGrid(decodedLength, fractionSteps, eventEnds);

  const trace: AgentSeatStateEvent[] = [];
  // Anchored to the capture's first timestamp: `bind` publishes immediately, and
  // an event stamped 0 would be dropped by `currentEvents()` (`lastPublishedAt > 0`).
  let clockMs = firstTimestampMs;
  const obs = new SessionObserver({
    bindingId: BINDING_ID,
    epoch: EPOCH,
    cols: geometry.cols,
    rows: geometry.rows,
  });
  // Deterministic seq pinning: with a zero sampling floor the observer flushes
  // every fed chunk synchronously, so a snapshot never races a pending timer.
  obs.setWriteIntervalMs(0);
  const rt = new SeatStateRuntime({
    now: () => clockMs,
    turnStallMs,
    turnProgressWatch: true,
    onEvent: (event) => trace.push(event),
  });
  rt.bindHarness(BINDING_ID, opts.harness, EPOCH);

  let eventCursor = 0;
  let fedTo = 0;
  let seq = 0n;
  let stepsVisited = 0;

  try {
    for (const entry of grid) {
      // Advance the clock to the last recorded timestamp fully inside the prefix.
      // The replayed clock is the capture's own recorded epoch-ms timestamp of
      // the last write fully inside the prefix. Anchoring to the raw timestamp
      // (rather than to zero) keeps `currentEvents()` — which drops events
      // published at `at === 0` — honest about a capture that starts at t=0.
      while (eventCursor < eventEnds.length && eventEnds[eventCursor]! <= entry.cut) {
        clockMs = at[eventCursor]!;
        eventCursor += 1;
      }
      seq += 1n;
      obs.feed(blob.slice(fedTo, entry.cut), seq);
      fedTo = entry.cut;
      const snapshot = await obs.snapshot();
      rt.observe(snapshot);

      stepsVisited += 1;
      const slot = rt.machine.getSlot(BINDING_ID);
      opts.onStep?.({
        grid: entry.grid,
        step: entry.step,
        steps: entry.steps,
        cut: entry.cut,
        cutFraction: entry.cut / decodedLength,
        atMs: clockMs - firstTimestampMs,
        snapshot,
        seatState: slot?.state,
        seatReason: slot?.reason,
      });
    }

    const slot = rt.machine.getSlot(BINDING_ID);
    const currentEvents = rt.currentEvents();
    return {
      harness: opts.harness,
      scenario: opts.scenario,
      capturePath: fixture.corpusPath ?? "",
      geometry,
      decodedLength,
      rawBytes,
      capture: {
        events: fixture.events.length,
        firstTimestampMs,
        lastTimestampMs,
        elapsedMs,
      },
      watchdog: "enabled",
      turnStallMs,
      clockBaseMs: firstTimestampMs,
      trace,
      currentEvents,
      stalls: trace.filter((event) => event.reason === TURN_STALLED_REASON),
      finalSlot: slot
        ? {
            state: slot.state,
            reason: slot.reason,
            confidence: slot.confidence,
            visibleIdle: slot.visibleIdle,
            visibleWorking: slot.visibleWorking,
            visibleAttention: slot.visibleAttention,
          }
        : undefined,
      isSeatIdle: rt.isSeatIdle(BINDING_ID),
      stepsVisited,
      traceDigest: digestTrace(trace),
    };
  } finally {
    rt.stop();
    obs.dispose();
  }
};
