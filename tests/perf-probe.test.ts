import { describe, expect, it } from "vitest";
import {
  makePerfProbe,
  perfProbeEnabled,
  perfQuantile,
  summarizePerfBlocks,
  summarizePerfReads,
  type PerfWindowLine,
} from "../src/main/vellum-command/observability/perf-probe";

describe("perf probe gate", () => {
  it("is off unless VELLUM_PERF is exactly 1", () => {
    // The zero-cost invariant: without the env flag there is no live probe,
    // so every hot-path guard folds to a constant false.
    expect(perfProbeEnabled).toBe(process.env.VELLUM_PERF === "1");
    if (process.env.VELLUM_PERF !== "1") expect(perfProbeEnabled).toBe(false);
  });
});

describe("perfQuantile", () => {
  it("uses nearest rank and returns zero for an empty tape", () => {
    expect(perfQuantile([], 0.5)).toBe(0);
    expect(perfQuantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(perfQuantile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(perfQuantile([10], 0.9)).toBe(10);
  });
});

describe("summarizePerfReads", () => {
  it("rolls cost up per caller tag, heaviest first", () => {
    const rollup = summarizePerfReads([
      { tag: "kernel.wakeManagedSeat", ms: 60, statements: 2000, bytes: 1000, probeMs: 1 },
      { tag: "kernel.wakeManagedSeat", ms: 80, statements: 2200, bytes: 1100, probeMs: 1 },
      { tag: "ipc.readCanvas", ms: 5, statements: 30, bytes: 100, probeMs: 0 },
    ]);
    expect(rollup.map((entry) => entry.tag)).toEqual([
      "kernel.wakeManagedSeat",
      "ipc.readCanvas",
    ]);
    expect(rollup[0]).toEqual({
      tag: "kernel.wakeManagedSeat",
      calls: 2,
      totalMs: 140,
      p50Ms: 60,
      maxMs: 80,
      statements: 4200,
      bytes: 2100,
    });
  });
});

describe("summarizePerfBlocks", () => {
  it("reports duty cycle, distribution, and per-caller attribution", () => {
    const rollup = summarizePerfBlocks(
      [
        {
          ms: 400,
          attribution: [{ tag: "kernel.wakeManagedSeat", calls: 1, ms: 390 }],
        },
        {
          ms: 600,
          attribution: [
            { tag: "kernel.wakeManagedSeat", calls: 2, ms: 560 },
            { tag: "ipc.readCanvas", calls: 1, ms: 20 },
          ],
        },
      ],
      5_000,
    );
    expect(rollup.count).toBe(2);
    expect(rollup.totalMs).toBe(1000);
    expect(rollup.dutyPct).toBe(20);
    expect(rollup.minMs).toBe(400);
    expect(rollup.p50Ms).toBe(400);
    expect(rollup.maxMs).toBe(600);
    expect(rollup.perSec).toBe(0.4);
    expect(rollup.byCaller).toEqual([
      { tag: "kernel.wakeManagedSeat", calls: 3, ms: 950 },
      { tag: "ipc.readCanvas", calls: 1, ms: 20 },
    ]);
  });
});

describe("makePerfProbe", () => {
  it("attributes a statement count and byte size to the caller tag of one read", () => {
    let clock = 0;
    const probe = makePerfProbe({ now: () => clock });

    // Noise before the read must not land in the read's statement count.
    probe.countStatement();

    const token = probe.beginRead("kernel.wakeManagedSeat");
    clock += 68;
    for (let index = 0; index < 2279; index += 1) probe.countStatement();
    probe.endRead(token, { nodes: ["a", "b"] });

    const line = probe.drain(1_000);
    expect(line.reads.calls).toBe(1);
    expect(line.reads.perSec).toBe(1);
    const caller = line.reads.byCaller[0];
    expect(caller?.tag).toBe("kernel.wakeManagedSeat");
    expect(caller?.statements).toBe(2279);
    expect(caller?.totalMs).toBe(68);
    expect(caller?.bytes).toBe(JSON.stringify({ nodes: ["a", "b"] }).length);
  });

  it("names the reads that ran inside an observed block", () => {
    let clock = 0;
    const probe = makePerfProbe({ now: () => clock });

    const token = probe.beginRead("kernel.wakeManagedSeat");
    clock += 437;
    probe.endRead(token, {});
    probe.recordBlock(437);

    const line = probe.drain(5_000);
    expect(line.blocks.count).toBe(1);
    expect(line.blocks.byCaller).toEqual([
      { tag: "kernel.wakeManagedSeat", calls: 1, ms: 437 },
    ]);
  });

  it("clears the tape on drain so windows never double count", () => {
    const probe = makePerfProbe({ now: () => 0 });
    probe.endRead(probe.beginRead("ipc.readCanvas"), {});
    probe.recordBlock(90);

    expect(probe.drain(5_000).reads.calls).toBe(1);
    const second = probe.drain(5_000);
    expect(second.reads.calls).toBe(0);
    expect(second.blocks.count).toBe(0);
  });

  it("bounds the retained tape and reports what it dropped", () => {
    const probe = makePerfProbe({ now: () => 0, maxSamples: 2 });
    for (let index = 0; index < 5; index += 1) {
      probe.endRead(probe.beginRead("control.read"), {});
    }
    const line = probe.drain(5_000);
    expect(line.reads.calls).toBe(2);
    expect(line.dropped).toBe(3);
  });

  it("emits one window line on the window timer and stops cleanly", async () => {
    const lines: Array<PerfWindowLine> = [];
    const probe = makePerfProbe({
      emit: (line) => lines.push(line),
      tickMs: 1,
      blockMs: 1_000_000,
      windowMs: 5,
    });
    probe.start();
    probe.endRead(probe.beginRead("control.list"), {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    probe.stop();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.kind).toBe("perf.window");
    const totalCalls = lines.reduce((sum, line) => sum + line.reads.calls, 0);
    expect(totalCalls).toBe(1);
  });
});
