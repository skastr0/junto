import { describe, expect, it } from "vitest";
import {
  createRendererSurfaceRecovery,
  resolveRendererSurfaceTimeoutMs,
} from "../src/main/vellum/renderer-surface-recovery";

describe("renderer surface recovery", () => {
  it("accepts a bounded timeout override only in the unpackaged test harness", () => {
    const resolve = (packaged: boolean, testHarness: boolean, override: string | undefined) =>
      resolveRendererSurfaceTimeoutMs({ packaged, testHarness, override, fallbackMs: 30_000 });

    expect(resolve(false, true, "5000")).toBe(5_000);
    expect(resolve(true, true, "5000")).toBe(30_000);
    expect(resolve(false, false, "5000")).toBe(30_000);
    expect(resolve(false, true, "999")).toBe(30_000);
    expect(resolve(false, true, "30001")).toBe(30_000);
    expect(resolve(false, true, "5e3")).toBe(30_000);
  });

  it("bounds retries and enters a visible diagnostic state", () => {
    let clock = 0;
    const recovery = createRendererSurfaceRecovery({
      maxRetries: 2,
      windowMs: 1_000,
      now: () => clock,
    });

    expect(recovery.failed()).toBe("retry");
    expect(recovery.failed()).toBe("retry");
    expect(recovery.failed()).toBe("diagnostic");

    recovery.succeeded();
    expect(recovery.failed()).toBe("retry");

    clock = 2_000;
    expect(recovery.failed()).toBe("retry");
  });
});
