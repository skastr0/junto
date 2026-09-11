import { describe, expect, it } from "vitest";
import {
  createRendererSurfaceRecovery,
  resolveRendererSurfaceTimeoutMs,
} from "../src/main/vellum-command/renderer-surface-recovery";

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

    expect(recovery.failed({ admissionClosed: false })).toBe("retry");
    expect(recovery.failed({ admissionClosed: false })).toBe("retry");
    expect(recovery.failed({ admissionClosed: false })).toBe("diagnostic");

    recovery.succeeded();
    expect(recovery.failed({ admissionClosed: false })).toBe("retry");

    clock = 2_000;
    expect(recovery.failed({ admissionClosed: false })).toBe("retry");
  });

  it("fails visibly instead of retrying after authoring admission closes", () => {
    const recovery = createRendererSurfaceRecovery({
      maxRetries: 2,
      windowMs: 1_000,
      now: () => 0,
    });

    expect(recovery.failed({ admissionClosed: true })).toBe("diagnostic");
    // The shutdown-only diagnostic does not consume a future process-lifetime
    // retry if the caller was merely modeling the state in isolation.
    expect(recovery.failed({ admissionClosed: false })).toBe("retry");
  });
});
