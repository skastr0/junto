/**
 * Trigger discipline on real busy working turns.
 *
 * The question: on a real busy seat, does output volume cost provider calls and
 * display churn, or does the cadence follow the triggers? The unit tests answer
 * it against synthetic snapshots; this answers it end to end, against workstream
 * A's real PTY captures, through the observer plane and this runtime.
 *
 * Method. Each captured chunk is fed as `sliceBytes`-sized byte slices, decoded
 * with a streaming decoder so a multi-byte character or an escape sequence may
 * span slices, with timestamps interpolated linearly across the chunk's span.
 * Slicing only makes the observation cadence finer than the capture's ~1s
 * aggregation of the same bytes; it never invents content. The capture's own
 * timeline drives a manual clock and manual timers, so the 60-second working-text
 * interval and the 300-500ms coalescing are exercised at real durations without
 * waiting on them.
 *
 * Classification is C's `computeWindowDigest` (`state.evidenceHash`): the single
 * normalization the cache key, the material-change trigger, and the renderer's
 * staleness comparison all read. An observation whose digest equals the previous
 * one changed only volatile chrome — spinner frames, counters, cursor position,
 * identical repaints.
 *
 * The claims, all measured on the printed numbers:
 *   - a chrome-only observation spends no call and reaches no new judgment;
 *   - the call count follows the triggers, not the output volume, so a finer
 *     cadence over the same bytes does not cost more;
 *   - a busy turn whose material revision keeps changing still costs one call
 *     until the working-text interval elapses;
 *   - the window revision, digest and capture time together, is republished only
 *     when the material revision changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalObserverPlane } from "../src/main/junto/term/observer";
import {
  AWARENESS_WINDOW_LINES,
  makeAwarenessRuntime,
} from "../src/main/junto/term/awareness/runtime";
import {
  makeAwarenessScheduler,
  type AwarenessAdvisory,
  type AwarenessProjectionPort,
} from "../src/main/junto/term/awareness/scheduler";
import {
  makeAskRecorder,
  makeFakeProjectionPort,
  makeFakeSeatPort,
  makeManualTimers,
} from "./helpers/awareness-fakes";

const CORPUS = join(process.cwd(), "tests", "pty-e2e", "corpus");

type RecordedChunk = { readonly t: number; readonly bytes: Buffer };

type Capture = {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly chunks: readonly RecordedChunk[];
};

const loadCapture = (name: string): Capture => {
  const dir = join(CORPUS, name);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    pty: { cols: number; rows: number };
  };
  const chunks: RecordedChunk[] = [];
  for (const line of readFileSync(join(dir, "working-turn.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as { t: number; b64: string };
    chunks.push({ t: record.t, bytes: Buffer.from(record.b64, "base64") });
  }
  return { name, cols: manifest.pty.cols, rows: manifest.pty.rows, chunks };
};

type Feed = { readonly at: number; readonly text: string };

/**
 * The capture's bytes at a finer cadence: `sliceBytes`-sized reads, timestamps
 * interpolated across each chunk's span. Byte slicing with a streaming decoder
 * keeps a split character or escape sequence intact.
 */
const sliceCapture = (capture: Capture, sliceBytes: number): readonly Feed[] => {
  const feeds: Feed[] = [];
  for (let index = 0; index < capture.chunks.length; index += 1) {
    const chunk = capture.chunks[index]!;
    const nextAt = capture.chunks[index + 1]?.t ?? chunk.t;
    const span = Math.max(0, nextAt - chunk.t);
    const slices: Buffer[] = [];
    for (let offset = 0; offset < chunk.bytes.length; offset += sliceBytes) {
      slices.push(chunk.bytes.subarray(offset, Math.min(offset + sliceBytes, chunk.bytes.length)));
    }
    const decoder = new TextDecoder();
    for (let part = 0; part < slices.length; part += 1) {
      const text = decoder.decode(slices[part]!, { stream: true });
      feeds.push({ at: chunk.t + Math.round((span * part) / slices.length), text });
    }
  }
  return feeds;
};

type TurnMeasurement = {
  /** Observations that reached the projection, i.e. a grid the seat had not sent. */
  readonly observations: number;
  /** Observations whose material revision (C's digest) equaled the previous one. */
  readonly chromeOnly: number;
  /** Calls dispatched by a chrome-only observation. Must be zero. */
  readonly chromeOnlyCalls: number;
  readonly calls: number;
  readonly emissions: number;
  readonly judgmentEmissions: number;
  /** Emissions that moved `windowCapturedAt` alone: a repaint reported as a window change. */
  readonly windowChurnEmissions: number;
  readonly snapshots: number;
  readonly windowReads: number;
  readonly captureMs: number;
};

const ADVISORY_FIELDS = [
  "epoch",
  "assessmentId",
  "availability",
  "unavailableReason",
  "status",
  "reason",
  "pending",
  "trigger",
  "windowDigest",
  "windowCapturedAt",
  "evidenceDigest",
  "absences",
  "unansweredConcerns",
  "evidenceLines",
] as const;

const differingFields = (a: AwarenessAdvisory, b: AwarenessAdvisory): readonly string[] => {
  const differing: string[] = [];
  for (const field of ADVISORY_FIELDS) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) differing.push(field);
  }
  return differing;
};

/**
 * Replay one seat's turn. The clock and timers are manual, driven by the feed
 * timestamps, so the turn's real duration is respected without waiting.
 */
const runTurn = async (
  capture: Capture,
  feeds: readonly Feed[],
  startAt: number,
): Promise<TurnMeasurement> => {
  const bindingId = `turn:${capture.name}`;
  const plane = new TerminalObserverPlane();
  const observer = plane.attach({
    bindingId,
    epoch: "e1",
    cols: capture.cols,
    rows: capture.rows,
  });
  const timers = makeManualTimers(startAt);
  const seats = makeFakeSeatPort();
  // Deterministic facts held constant: no control transition, no attention edge
  // and no episode, so only the evidence can trigger anything.
  seats.set(bindingId, { harness: capture.name, controlRevision: 0, attention: false });

  const realProjection = makeFakeProjectionPort();
  const digests: string[] = [];
  const emissions: AwarenessAdvisory[] = [];
  const model = makeAskRecorder();
  /** Observation index (1-based) that dispatched each call. */
  const callsByObservation: number[] = [];
  const projection: AwarenessProjectionPort = {
    project: (input) => {
      const projected = realProjection.project(input);
      digests.push(projected.state.evidenceHash);
      return projected;
    },
  };
  const ask = (input: Parameters<typeof model.ask>[0], signal: AbortSignal) => {
    // The projection for this observation has already run, so its index names
    // the observation that is spending the call.
    callsByObservation.push(digests.length);
    return model.ask(input, signal);
  };

  const scheduler = makeAwarenessScheduler({
    ask,
    unavailable: model.unavailable,
    modelId: "jev-latest",
    modelAvailable: true,
    modelUnavailableReason: undefined,
    seats,
    projection,
    clock: timers.clock,
    timers,
    random: () => 0.5,
  });
  const runtime = makeAwarenessRuntime({
    plane,
    scheduler,
    seats,
    projection,
    clock: timers.clock,
    timers,
  });
  runtime.subscribe((advisory) => emissions.push(advisory));
  runtime.start();

  let seq = 0n;
  let clockAt = startAt;
  try {
    for (const feed of feeds) {
      seq += 1n;
      observer.feed(feed.text, seq);
      // Await the settled snapshot so the plane's notification reaches the
      // runtime before the clock moves to this feed's own timestamp.
      await observer.snapshot();
      const delta = feed.at - clockAt;
      if (delta > 0) {
        clockAt = feed.at;
        timers.advance(delta);
      } else {
        timers.advance(0);
      }
    }
    // Let anything the last feeds queued settle before reading the totals.
    timers.advance(1_000);
    await scheduler.drain();
    const status = runtime.status();

    let chromeOnly = 0;
    for (let index = 1; index < digests.length; index += 1) {
      if (digests[index] === digests[index - 1]) chromeOnly += 1;
    }
    const chromeOnlyObservations = new Set<number>();
    for (let index = 1; index < digests.length; index += 1) {
      if (digests[index] === digests[index - 1]) chromeOnlyObservations.add(index + 1);
    }
    const chromeOnlyCalls = callsByObservation.filter((index) =>
      chromeOnlyObservations.has(index),
    ).length;

    let judgmentEmissions = 0;
    let windowChurnEmissions = 0;
    for (let index = 1; index < emissions.length; index += 1) {
      const previous = emissions[index - 1]!;
      const current = emissions[index]!;
      const differing = differingFields(previous, current);
      if (previous.assessmentId !== current.assessmentId) {
        if (current.assessmentId !== undefined) judgmentEmissions += 1;
        continue;
      }
      if (differing.length === 1 && differing[0] === "windowCapturedAt") {
        windowChurnEmissions += 1;
      }
    }

    return {
      observations: digests.length,
      chromeOnly,
      chromeOnlyCalls,
      calls: model.count(),
      emissions: emissions.length,
      judgmentEmissions,
      windowChurnEmissions,
      snapshots: status.snapshotsRetained,
      windowReads: status.windowReads,
      captureMs: clockAt - startAt,
    };
  } finally {
    runtime.stop();
    plane.disposeAll();
  }
};

const format = (label: string, measurement: TurnMeasurement): string =>
  `${label.padEnd(24)} obs=${String(measurement.observations).padStart(4)} ` +
  `chromeOnly=${String(measurement.chromeOnly).padStart(4)} calls=${measurement.calls} ` +
  `emissions=${String(measurement.emissions).padStart(4)} judgments=${measurement.judgmentEmissions} ` +
  `windowChurn=${String(measurement.windowChurnEmissions).padStart(3)} ` +
  `snapshots=${measurement.snapshots} reads=${measurement.windowReads} capture=${(measurement.captureMs / 1000).toFixed(1)}s`;

const BUSY = "omp";

describe("trigger discipline on a real busy working turn", () => {
  it(
    "spends calls on triggers, never on output volume or chrome",
    async () => {
      const capture = loadCapture(BUSY);
      const startAt = capture.chunks[0]!.t;
      const rows: string[] = [];
      const measurements: TurnMeasurement[] = [];
      for (const sliceBytes of [1_048_576, 4_096, 1_024, 256]) {
        const measurement = await runTurn(capture, sliceCapture(capture, sliceBytes), startAt);
        measurements.push(measurement);
        rows.push(format(`slice=${sliceBytes}B`, measurement));
      }
      console.log(
        `[awareness] trigger discipline (${BUSY} working turn, ${capture.chunks.length} chunks)\n  ${rows.join("\n  ")}`,
      );

      for (const measurement of measurements) {
        // Chrome really does move without the material moving...
        expect(measurement.chromeOnly).toBeGreaterThan(0);
        // ...and it never spends a call.
        expect(measurement.chromeOnlyCalls).toBe(0);
        // The whole turn costs one call: the first stable screen of the
        // generation. The capture is 20s, inside the 60s working-text interval.
        expect(measurement.calls).toBe(1);
        // One judgment reaches the display, not one per observation.
        expect(measurement.judgmentEmissions).toBe(1);
        // The window revision is republished only when the material revision
        // changes: a repaint must not move `windowCapturedAt` on its own.
        expect(measurement.windowChurnEmissions).toBe(0);
        // The display is not driven by observation volume: every emission is the
        // initial state, a judgment, or a material revision. A chrome-only
        // observation reaches the display as nothing at all.
        expect(measurement.emissions).toBeLessThanOrEqual(
          measurement.observations - measurement.chromeOnly + 1,
        );
      }

      // A finer cadence over the same bytes must not cost more calls.
      const calls = new Set(measurements.map((measurement) => measurement.calls));
      expect(calls.size).toBe(1);
      const finest = measurements[measurements.length - 1]!;
      expect(finest.observations).toBeGreaterThan(measurements[0]!.observations * 4);
    },
    120_000,
  );

  it(
    "spends the working-text refresh once the interval has passed",
    async () => {
      // Three real captures of different harnesses laid end to end as one seat's
      // 67s turn, so the 60s working-text interval elapses inside a busy turn.
      const parts = ["omp", "amp", "grok"].map((name) => loadCapture(name));
      const feeds: Feed[] = [];
      let offset = 0;
      for (const part of parts) {
        const startAt = part.chunks[0]!.t;
        for (const feed of sliceCapture(part, 4_096)) {
          feeds.push({ at: feed.at - startAt + offset, text: feed.text });
        }
        offset += part.chunks[part.chunks.length - 1]!.t - startAt + 1_000;
      }
      const measurement = await runTurn(parts[0]!, feeds, 0);
      console.log(
        `[awareness] trigger discipline (omp+amp+grok, one ${(measurement.captureMs / 1000).toFixed(0)}s turn)\n  ${format("three captures", measurement)}`,
      );

      // The first stable screen, plus exactly one working-text refresh per
      // elapsed interval: a turn that changes materially throughout is two calls.
      expect(measurement.captureMs).toBeGreaterThan(60_000);
      expect(measurement.calls).toBe(2);
      expect(measurement.chromeOnlyCalls).toBe(0);
      expect(measurement.windowChurnEmissions).toBe(0);
    },
    120_000,
  );
});
