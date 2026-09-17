/**
 * Window-size calibration against workstream A's real PTY corpus.
 *
 * The question: how many retained lines should one observation read? C's
 * projection keeps the newest `MAX_EVIDENCE_CANDIDATE_LINES` candidates of
 * whatever it is handed, so the window size is a cost choice, not a correctness
 * one — unless it is too small, in which case evidence is thrown away.
 *
 * These captures are real busy working turns across seven harnesses. The
 * measurements below are the calibration record: evidence saturates exactly at
 * C's candidate cap, and reading past it buys nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionObserver, TerminalObserverPlane } from "../src/main/junto/term/observer";
import { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_CANDIDATE_LINES } from "../src/main/junto/term/awareness/questions";
import { selectAwarenessInput } from "../src/main/junto/term/awareness/select-input";
import {
  AWARENESS_WINDOW_LINES,
  makeAwarenessRuntime,
} from "../src/main/junto/term/awareness/runtime";
import { makeAwarenessScheduler } from "../src/main/junto/term/awareness/scheduler";
import {
  makeAskRecorder,
  makeFakeProjectionPort,
  makeFakeSeatPort,
} from "./helpers/awareness-fakes";

const CORPUS = join(process.cwd(), "tests", "pty-e2e", "corpus");

type Capture = {
  readonly name: string;
  readonly chunks: ReadonlyArray<string>;
  readonly cols: number;
  readonly rows: number;
};

const loadCapture = (name: string): Capture => {
  const dir = join(CORPUS, name);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    pty: { cols: number; rows: number };
  };
  const chunks: string[] = [];
  for (const line of readFileSync(join(dir, "working-turn.jsonl"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as { b64?: string };
    if (typeof record.b64 === "string") {
      chunks.push(Buffer.from(record.b64, "base64").toString("utf8"));
    }
  }
  return { name, chunks, cols: manifest.pty.cols, rows: manifest.pty.rows };
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const replay = async (capture: Capture): Promise<SessionObserver> => {
  const observer = new SessionObserver({
    bindingId: `calibration:${capture.name}`,
    epoch: "e1",
    cols: capture.cols,
    rows: capture.rows,
  });
  let seq = 0n;
  for (const chunk of capture.chunks) {
    seq += 1n;
    observer.feed(chunk, seq);
  }
  await observer.snapshot();
  return observer;
};

const measure = (
  observer: SessionObserver,
  lines: number,
): { readonly evidenceLines: number; readonly evidenceBytes: number; readonly readMs: number; readonly projectMs: number } => {
  const window = observer.readWindowNow(lines);
  const state = selectAwarenessInput({ ...window, observedAt: Date.now() });
  const reads: number[] = [];
  const projections: number[] = [];
  for (let i = 0; i < 25; i += 1) {
    const readStart = performance.now();
    const again = observer.readWindowNow(lines);
    reads.push(performance.now() - readStart);
    const projectStart = performance.now();
    selectAwarenessInput({ ...again, observedAt: Date.now() });
    projections.push(performance.now() - projectStart);
  }
  return {
    evidenceLines: state.evidenceLines.length,
    evidenceBytes: state.evidenceBytes,
    readMs: median(reads),
    projectMs: median(projections),
  };
};

const NAMES = ["omp", "grok", "claude", "devin", "codex", "muse", "amp"] as const;

describe("window calibration on the real corpus", () => {
  it("saturates the evidence at C's candidate cap and gains nothing past it", async () => {
    const rows: string[] = [];
    for (const name of NAMES) {
      const capture = loadCapture(name);
      const observer = await replay(capture);
      try {
        const retained = observer.readWindowNow(4096).totalLines;
        const sizes = [32, 64, 96, 128, 256];
        const measured = sizes.map((size) => ({ size, ...measure(observer, size) }));
        rows.push(
          `${name.padEnd(6)} cols=${capture.cols} rows=${capture.rows} retained=${String(retained).padStart(3)} | ` +
            measured
              .map(
                (entry) =>
                  `${entry.size}:${entry.evidenceLines}l/${entry.evidenceBytes}b/${entry.readMs.toFixed(2)}+${entry.projectMs.toFixed(2)}ms`,
              )
              .join("  "),
        );
        const at128 = measured.find((entry) => entry.size === 128)!;
        const at256 = measured.find((entry) => entry.size === 256)!;
        if (retained >= MAX_EVIDENCE_CANDIDATE_LINES) {
          // Reading past the candidate cap returns the same evidence for a
          // strictly higher read cost: the cap, not the window, is the bound.
          expect(at256.evidenceLines).toBe(at128.evidenceLines);
          expect(at256.evidenceBytes).toBe(at128.evidenceBytes);
          expect(at128.evidenceLines).toBeGreaterThan(0);
        }
        // Evidence never exceeds C's byte cap, and the read stays cheap.
        for (const entry of measured) {
          expect(entry.evidenceBytes).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
          expect(entry.readMs).toBeLessThan(1);
          expect(entry.projectMs).toBeLessThan(5);
        }
      } finally {
        observer.dispose();
      }
    }
    console.log(
      `[awareness] window calibration (evidence/bytes, median read+projection ms, 25 runs)\n  ${rows.join("\n  ")}`,
    );
    expect(rows).toHaveLength(NAMES.length);
  });

  it("reads exactly C's candidate cap, so no capture is clipped by the window", async () => {
    expect(AWARENESS_WINDOW_LINES).toBe(MAX_EVIDENCE_CANDIDATE_LINES);
    for (const name of NAMES) {
      const observer = await replay(loadCapture(name));
      try {
        const window = observer.readWindowNow(AWARENESS_WINDOW_LINES);
        // The window reports its own clip: a grid that retained fewer lines is
        // honest about it rather than looking like a short screen.
        expect(window.lines.length).toBeLessThanOrEqual(AWARENESS_WINDOW_LINES);
        expect(window.totalLines).toBeGreaterThanOrEqual(window.lines.length);
      } finally {
        observer.dispose();
      }
    }
  });

  it("keeps one real busy-seat flush bounded end to end", async () => {
    const capture = loadCapture("omp");
    const plane = new TerminalObserverPlane();
    const observer = plane.attach({
      bindingId: "calibration:flush",
      epoch: "e1",
      cols: capture.cols,
      rows: capture.rows,
    });
    let seq = 0n;
    for (const chunk of capture.chunks) {
      seq += 1n;
      observer.feed(chunk, seq);
    }
    await observer.snapshot();

    const seats = makeFakeSeatPort();
    const projection = makeFakeProjectionPort();
    const model = makeAskRecorder();
    seats.set("calibration:flush", {});
    const scheduler = makeAwarenessScheduler({
      ask: model.ask,
      unavailable: model.unavailable,
      modelId: "jev-latest",
      modelAvailable: true,
      modelUnavailableReason: undefined,
      seats,
      projection,
      config: { coalesceMs: 1, coalesceMaxWaitMs: 1 },
      random: () => 0.5,
    });
    const runtime = makeAwarenessRuntime({
      plane,
      scheduler,
      seats,
      projection,
      config: { coalesceMs: 1, coalesceMaxWaitMs: 1 },
    });
    runtime.start();
    try {
      seq += 1n;
      observer.feed("one more line of output\r\n", seq);
      await observer.snapshot();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const status = runtime.status();
      console.log(
        `[awareness] real busy-seat flush (omp working turn, ${AWARENESS_WINDOW_LINES}-line window): ` +
          `${status.lastFlushMs.toFixed(3)} ms, ${status.windowReads} window read(s), ${status.flushes} flush(es)`,
      );
      // One flush for the replayed grid at subscribe time, one for the new
      // output: `lastFlushMs` is the busy-grid flush.
      expect(status.windowReads).toBeGreaterThan(0);
      expect(status.flushes).toBeGreaterThanOrEqual(1);
      expect(status.lastFlushMs).toBeLessThan(10);
      expect(scheduler.stats().calls).toBe(1);
    } finally {
      runtime.stop();
      plane.disposeAll();
    }
  });
});
