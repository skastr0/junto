import { describe, expect, it } from "vitest";
import { createQuitPhaseLog } from "../src/main/junto/quit-phase-log";

const clock = () => {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe("quit phase log", () => {
  it("measures offsets from the first quit event and each phase's duration", async () => {
    const lines: string[] = [];
    const c = clock();
    const log = createQuitPhaseLog((line) => lines.push(line), c.now);
    log.mark("signal SIGTERM");
    c.advance(40);
    await log.time("terminal drain", async () => {
      c.advance(120);
    });
    log.mark("will-quit");
    expect(lines).toEqual([
      "[quit] +0ms signal SIGTERM",
      "[quit] +40ms terminal drain done in 120ms",
      "[quit] +160ms will-quit",
    ]);
  });

  it("laps sequential phases from the previous logged event", () => {
    const lines: string[] = [];
    const c = clock();
    const log = createQuitPhaseLog((line) => lines.push(line), c.now);
    log.mark("runtime dispose begins");
    c.advance(30);
    log.lap("dispose: terminal plane");
    c.advance(5);
    log.lap("dispose: browser");
    expect(lines).toEqual([
      "[quit] +0ms runtime dispose begins",
      "[quit] +0ms dispose: terminal plane done in 30ms",
      "[quit] +30ms dispose: browser done in 5ms",
    ]);
  });

  it("logs a failed phase and rethrows its error unchanged", async () => {
    const lines: string[] = [];
    const c = clock();
    const log = createQuitPhaseLog((line) => lines.push(line), c.now);
    const error = new Error("retained");
    await expect(
      log.time("runtime dispose", async () => {
        c.advance(7);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(lines).toEqual(["[quit] +0ms runtime dispose failed in 7ms"]);
  });

  it("never lets a throwing writer change the phase result", async () => {
    const log = createQuitPhaseLog(() => {
      throw new Error("closed stdout");
    });
    expect(() => log.mark("before-quit")).not.toThrow();
    await expect(log.time("canvas flush", async () => 42)).resolves.toBe(42);
  });
});
