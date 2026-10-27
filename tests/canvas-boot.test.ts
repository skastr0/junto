import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOT_STEP_STALL_MS, bootStep, nextCanvasBootAction } from "../src/renderer/lib/canvas-boot";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bootStep", () => {
  it("logs a step's start and end under the boot area and returns its value", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(bootStep("canvas list", async () => ["factory"])).resolves.toEqual(["factory"]);
    expect(info.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(/^\[boot\] canvas list started at \d+ ms$/u),
      expect.stringMatching(/^\[boot\] canvas list ended after \d+ ms$/u),
    ]);
  });

  it("logs the end of a step that fails, and passes the failure on", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(bootStep("settings", async () => { throw new Error("no backend"); })).rejects.toThrow("no backend");
    expect(String(info.mock.calls.at(-1)?.[0])).toMatch(/^\[boot\] settings ended after/u);
  });

  it("names a step that is still running after the stall threshold", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let finish: () => void = () => undefined;
    const step = bootStep("open canvas factory", () => new Promise<void>((resolve) => { finish = resolve; }));
    vi.advanceTimersByTime(BOOT_STEP_STALL_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledWith(`[boot] open canvas factory still running after ${BOOT_STEP_STALL_MS} ms`);
    finish();
    await step;
    vi.advanceTimersByTime(BOOT_STEP_STALL_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("nextCanvasBootAction", () => {
  it("opens the first canvas this machine holds", () => {
    expect(nextCanvasBootAction(["factory", "ops"])).toEqual({
      kind: "open",
      name: "factory",
    });
  });

  it("starts an empty canvas when it holds none", () => {
    expect(nextCanvasBootAction([])).toEqual({ kind: "seed" });
  });
});
