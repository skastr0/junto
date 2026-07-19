import { describe, expect, it } from "vitest";
import { HerdrStreamManager, type HerdrProcessLike, type ObservePoolHooks } from "../src/main/vellum/herdr/stream";

class FakeProcess implements HerdrProcessLike {
  written: string[] = [];
  killedSignal: NodeJS.Signals | undefined;
  stdin = {
    write: (chunk: string) => {
      this.written.push(chunk);
      return true;
    },
  };
  stdout = {
    setEncoding: () => undefined,
    on: () => undefined,
  };
  stderr = {
    setEncoding: () => undefined,
    on: () => undefined,
  };
  kill(sig?: NodeJS.Signals) {
    this.killedSignal = sig ?? "SIGTERM";
  }
  on() {
    return undefined;
  }
}

const mockPool: ObservePoolHooks = {
  ensureObserve: () => ({ pooled: true }),
  retainedFrames: () => ({ frames: ["F1"], cols: 120, rows: 32 }),
  pauseForControl: () => undefined,
  clearRetention: () => undefined,
  releaseObserve: () => undefined,
  stopAll: () => undefined,
};

describe("HerdrStreamManager geometry bounds normalization", () => {
  it("normalizes resize numeric inputs (0, NaN, Infinity, negative, fractions)", () => {
    let proc: FakeProcess | undefined;
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        proc = new FakeProcess();
        return proc;
      },
      async () => "/tmp/img",
    );

    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // 0: cols clamps to 20, rows clamps to 5
    mgr.resize(opened.streamId, 0, 0);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 20, rows: 5 }) + "\n");

    // NaN: falls back to 80x24
    mgr.resize(opened.streamId, NaN, NaN);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 80, rows: 24 }) + "\n");

    // Infinity: falls back to 80x24
    mgr.resize(opened.streamId, Infinity, -Infinity);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 80, rows: 24 }) + "\n");

    // Negative: clamps to min bounds 20x5
    mgr.resize(opened.streamId, -10, -50);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 20, rows: 5 }) + "\n");

    // Fractional: floors to integer
    mgr.resize(opened.streamId, 110.8, 40.2);
    expect(proc?.written.at(-1)).toBe(JSON.stringify({ type: "terminal.resize", cols: 110, rows: 40 }) + "\n");
  });

  it("normalizes scroll numeric inputs (NaN, zero, negative, pointer cell bounds)", () => {
    let proc: FakeProcess | undefined;
    const mgr = new HerdrStreamManager(
      mockPool,
      () => {
        proc = new FakeProcess();
        return proc;
      },
      async () => "/tmp/img",
    );

    const opened = mgr.open({ hostId: "local", terminalId: "t1", cols: 80, rows: 24 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Scroll with NaN delta and NaN pointer coordinates
    mgr.scroll(opened.streamId, NaN, { column: NaN, row: NaN, modifiers: NaN });
    const lastPayload = JSON.parse(proc?.written.at(-1) ?? "{}");
    expect(lastPayload).toEqual({
      type: "terminal.scroll",
      direction: "down",
      lines: 1,
      column: 0,
      row: 0,
      modifiers: 0,
    });
  });
});
