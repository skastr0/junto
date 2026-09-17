/**
 * Replay harness contract: controlled time, a complete event history, real
 * geometry, one-pass equivalence, and determinism.
 *
 * These legs use small captures (claude, hermes, grok) so the suite stays fast;
 * the full-corpus replay is exercised by the manifest drift leg in
 * `checkpoints.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { progressFingerprint } from "../../../src/main/junto/term/agent-state/turn-progress-watch";
import { loadP1Fixture } from "../runner";
import { buildGrid, captureGeometry, decodeEvents, digestTrace, replayCapture } from "./replay";
import { firstTraceDivergence } from "./report";

describe("JR — controlled time", () => {
  it("JR-time: the replayed clock follows the capture's own timestamps", async () => {
    const trace = await replayCapture({ harness: "hermes", scenario: "paste-chip", fractionSteps: 40 });
    expect(trace.capture.events).toBeGreaterThan(2);
    expect(trace.capture.elapsedMs).toBeGreaterThan(0);

    // Every published event's `at` is a real moment from the capture, not a
    // frozen constant: it is the epoch-ms timestamp of the last write the seat
    // had absorbed when the event was published.
    const fixture = loadP1Fixture("hermes", "paste-chip");
    const recorded = new Set(fixture!.events.map((event) => event.t));
    const stamps = trace.trace.map((event) => event.at);
    expect(stamps.length).toBeGreaterThan(1);
    for (const stamp of stamps) {
      expect(recorded.has(stamp), `event stamped ${stamp} is not a recorded capture timestamp`).toBe(true);
    }
    expect(new Set(stamps).size).toBeGreaterThan(1);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]!, `event ${i} goes backwards in time`).toBeGreaterThanOrEqual(stamps[i - 1]!);
    }

    // The clock is anchored to the capture's first timestamp, so a capture that
    // begins at t=0 cannot suppress `currentEvents()` (which drops `at === 0`).
    expect(trace.clockBaseMs).toBe(fixture!.events[0]!.t);
    expect(trace.currentEvents.length).toBe(1);
  });

  it("JR-time: the walk clock reaches the end of the capture, not a default", async () => {
    const trace = await replayCapture({ harness: "hermes", scenario: "paste-chip", fractionSteps: 40 });
    let lastStepAtMs = -1;
    let firstStepAtMs = -1;
    await replayCapture({
      harness: "hermes",
      scenario: "paste-chip",
      fractionSteps: 40,
      onStep: (step) => {
        if (firstStepAtMs < 0) firstStepAtMs = step.atMs;
        lastStepAtMs = step.atMs;
      },
    });
    expect(firstStepAtMs).toBe(0);
    expect(lastStepAtMs).toBe(trace.capture.elapsedMs);
  });
});

describe("JR — full event history", () => {
  it("JR-trace: onEvent collects the whole published history, not just the final projection", async () => {
    const trace = await replayCapture({ harness: "claude", scenario: "working-turn", fractionSteps: 40 });
    expect(trace.trace.length).toBeGreaterThan(1);
    // `currentEvents()` is one row per live binding — the thing runner.ts returns.
    expect(trace.currentEvents.length).toBe(1);
    expect(trace.trace.length).toBeGreaterThan(trace.currentEvents.length);
    const final = trace.currentEvents[0];
    const last = trace.trace[trace.trace.length - 1];
    expect(final?.state).toBe(last?.state);
    // The projection is NOT the history. `currentEvents()` reads the slot, and
    // `maybePublish` refreshes `slot.reason` without emitting an event ("Keep
    // reason fresh without event spam"), so the projection can be fresher than
    // anything the history published. runner.ts returns only the projection.
    expect(final?.reason).toBe(trace.finalSlot?.reason);
    expect(trace.traceDigest).toBe(digestTrace(trace.trace));
    // A history, not a projection: the sequence must contain transitions.
    const states = new Set(trace.trace.map((event) => event.state));
    expect(states.size).toBeGreaterThan(1);
  });

  it("JR-trace: a trace can be compared step by step, and the first divergence is located", async () => {
    const trace = await replayCapture({ harness: "claude", scenario: "type-echo", fractionSteps: 40 });
    expect(firstTraceDivergence(trace.trace, trace.trace)).toBe(-1);
    const mutated = trace.trace.map((event, index) =>
      index === 1 ? { ...event, state: "attention" as const, reason: "mutated" } : event,
    );
    expect(firstTraceDivergence(trace.trace, mutated)).toBe(1);
    const truncated = trace.trace.slice(0, 1);
    expect(firstTraceDivergence(trace.trace, truncated)).toBe(1);
  });

  it("JR-trace: the grok permission dialog reaches attention in the deterministic trace", async () => {
    const trace = await replayCapture({ harness: "grok", scenario: "permission-returns-idle" });
    const attention = trace.trace.filter((event) => event.state === "attention");
    expect(attention.length).toBeGreaterThan(0);
    expect(attention.some((event) => event.reason === "rule:option_dialog_attention")).toBe(true);
  });
});

describe("JR — the mid-turn watchdog", () => {
  it("JR-watchdog: enabled, and replayed time cannot reach its deadline", async () => {
    const trace = await replayCapture({
      harness: "hermes",
      scenario: "paste-chip",
      fractionSteps: 40,
      turnStallMs: 5_000,
    });
    expect(trace.watchdog).toBe("enabled");
    expect(trace.turnStallMs).toBe(5_000);
    // The capture spans far more than the threshold, so a clock-driven watchdog
    // would have stalled. It does not, and both reasons are properties of the
    // product (TurnProgressWatch, not the harness):
    expect(trace.capture.elapsedMs).toBeGreaterThan(5_000);
    expect(trace.stalls).toEqual([]);
  });

  it("JR-watchdog: the deadline is always stallMs ahead, so only real time can fire it", () => {
    // Reason 1, read off the product: arm/noteProgress stamp
    // `lastProgressAt = now()` before `remaining = stallMs - (now() - lastProgressAt)`.
    // Reason 2: the fingerprint carries `seq`, which advances on every write, so
    // any output at all — including a static repaint — reads as progress.
    const snapshot = { seq: 1n, signals: { title: "⠙ codex", osc9: "" }, text: "same screen" };
    const later = { ...snapshot, seq: 2n };
    expect(progressFingerprint(snapshot)).not.toBe(progressFingerprint(later));
    expect(progressFingerprint(snapshot)).toBe(progressFingerprint({ ...snapshot }));
  });
});

describe("JR — geometry and grid", () => {
  it("JR-geometry: cols/rows come from the capture manifest and reach the snapshot", async () => {
    const geometry = captureGeometry("claude");
    expect(geometry).toEqual({
      cols: 120,
      rows: 32,
      source: "claude/manifest.json pty.cols/pty.rows",
    });
    const seen: Array<{ cols: number; rows: number }> = [];
    await replayCapture({
      harness: "claude",
      scenario: "type-echo",
      fractionSteps: 20,
      onStep: (step) => {
        seen.push({ cols: step.snapshot.cols, rows: step.snapshot.rows });
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const dims of seen) expect(dims).toEqual({ cols: geometry.cols, rows: geometry.rows });
  });

  it("JR-geometry: a capture without declared geometry throws instead of defaulting", () => {
    expect(() => captureGeometry("not-a-harness")).toThrow(/geometry must come from the capture/u);
  });

  it("JR-grid: the walk grid is the union of the event grid and the fraction grid", () => {
    const grid = buildGrid(1000, 4, [100, 250, 1000]);
    expect(grid.map((entry) => entry.cut)).toEqual([100, 250, 500, 750, 1000]);
    expect(grid.find((entry) => entry.cut === 100)?.grid).toBe("event");
    expect(grid.find((entry) => entry.cut === 500)?.grid).toBe("fraction");
    expect(grid.find((entry) => entry.cut === 1000)?.grid).toBe("event");
    // The end of the capture is always sampled.
    expect(grid[grid.length - 1]?.cut).toBe(1000);
  });

  it("JR-grid: one pass covers the same decoded stream the capture tool recorded", async () => {
    const fixture = loadP1Fixture("claude", "type-echo");
    expect(fixture).not.toBeNull();
    const { parts } = decodeEvents(fixture!.events);
    const trace = await replayCapture({ harness: "claude", scenario: "type-echo", fractionSteps: 20 });
    expect(trace.decodedLength).toBe(parts.join("").length);
    expect(trace.rawBytes).toBe(fixture!.events.reduce((sum, e) => sum + Buffer.from(e.b64, "base64").length, 0));
  });
});

describe("JR — determinism", () => {
  it("JR-determinism: two replays of the same capture produce the same trace and digest", async () => {
    const [a, b] = await Promise.all([
      replayCapture({ harness: "grok", scenario: "permission-returns-idle" }),
      replayCapture({ harness: "grok", scenario: "permission-returns-idle" }),
    ]);
    expect(a.traceDigest).toBe(b.traceDigest);
    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
    expect(firstTraceDivergence(a.trace, b.trace)).toBe(-1);
    // A capture must produce a real history, and the fine grid must sample more
    // than the coarse one the parent's proof-of-concept used.
    expect(a.trace.length).toBeGreaterThan(1);
    expect(a.stepsVisited).toBeGreaterThan(20);
  });
});
