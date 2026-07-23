import { describe, expect, it, vi } from "vitest";
import {
  createStationReadinessCoordinator,
  stationReadinessMetadata,
  type BrowserProductPathReceipt,
} from "../src/main/vellum/station-readiness";
import type { NativeTerminalReadiness } from "../src/main/vellum/term/native-readiness";

const input = {
  version: "0.1.0",
  role: "remote",
  hostId: "studio",
  packageIdentity: "vellum 0.1.0",
  supervisorAligned: true,
  canvasPull: "fresh" as const,
  workControlReady: true,
};

const terminalReady = async (): Promise<NativeTerminalReadiness> => ({
  ready: true,
  backend: "pty",
  exitCode: 0,
});

const browserReady = (hostId = "studio"): BrowserProductPathReceipt => ({
  version: 1,
  hostId,
  transport: "ready",
  composition: "ready",
  display: "ready",
  sandbox: "ready",
  capability: "ready",
});

describe("station readiness coordinator", () => {
  it("projects a fully proven Remote without producer diagnostics", async () => {
    const coordinator = createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady() },
    });

    const report = await coordinator.assess(input);

    expect(report).toEqual({
      version: 1,
      state: "ready",
      components: {
        version: "ready", role: "ready", host: "ready", package: "ready",
        supervisor: "ready", canvasPull: "ready", work: "ready", terminal: "ready",
        browserTransport: "ready", browserComposition: "ready", display: "ready",
        sandbox: "ready", browserCapability: "ready",
      },
    });
    expect(JSON.stringify(report)).not.toContain("token");
    expect(stationReadinessMetadata(report)).toMatchObject({
      readinessVersion: "1", readinessState: "ready", "readiness.browserTransport": "ready",
    });
  });

  it("fails browser readiness when the receipt is for a different physical host", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady("other-host") },
    }).assess(input);

    expect(report.state).toBe("failed");
    expect(report.components).toMatchObject({ browserTransport: "failed", browserCapability: "failed" });
  });

  it("states unsupported when no browser product path producer is installed", async () => {
    const report = await createStationReadinessCoordinator({ terminalProbe: terminalReady }).assess(input);

    expect(report.state).toBe("unsupported");
    expect(report.components).toMatchObject({ browserTransport: "unsupported", display: "unsupported" });
  });

  it("joins concurrent callers into one browser probe", async () => {
    let resolve!: (value: BrowserProductPathReceipt) => void;
    const pending = new Promise<BrowserProductPathReceipt>((done) => { resolve = done; });
    const probe = vi.fn(async () => pending);
    const coordinator = createStationReadinessCoordinator({ terminalProbe: terminalReady, browser: { probe } });

    const first = coordinator.assess(input);
    const second = coordinator.assess({ ...input, hostId: "ignored-by-joined-flight" });
    resolve(browserReady());

    await expect(Promise.all([first, second])).resolves.toEqual([expect.any(Object), expect.any(Object)]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a bounded browser probe does not settle", async () => {
    vi.useFakeTimers();
    const coordinator = createStationReadinessCoordinator({
      timeoutMs: 5,
      terminalProbe: terminalReady,
      browser: { probe: async () => new Promise<BrowserProductPathReceipt>(() => undefined) },
    });
    const result = coordinator.assess(input);
    await vi.advanceTimersByTimeAsync(5);

    await expect(result).resolves.toMatchObject({
      state: "failed",
      components: { browserTransport: "failed" },
    });
    vi.useRealTimers();
  });
});
