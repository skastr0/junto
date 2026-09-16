import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  InstallationId,
  StationConfiguration,
  type StationConfiguration as StationConfigurationValue,
} from "../src/shared/station-api";
import {
  createStationReadinessCoordinator,
  stationReadinessMetadata,
  type BrowserProductPathReceipt,
} from "../src/main/junto/station-readiness";
import type { NativeTerminalReadiness } from "../src/main/junto/term/native-readiness";

const installationId = Schema.decodeUnknownSync(InstallationId);
const stationConfiguration = Schema.decodeUnknownSync(StationConfiguration);
const commandCenterInstallationId = installationId("command-installation");

const remoteConfiguration = (
  hostId = "studio",
): StationConfigurationValue =>
  stationConfiguration({
    role: "remote",
    hostId,
    agentHostId: hostId,
    commandCenterInstallationId,
    supervisedPreferred: true,
  });

const commandCenterConfiguration = (): StationConfigurationValue =>
  stationConfiguration({
    role: "command-center",
    hostId: "local",
    supervisedPreferred: false,
  });

const input = {
  version: "0.1.0",
  configuration: remoteConfiguration(),
  packageIdentity: "junto 0.1.0",
  supervisorAligned: true,
  projectionInstalled: true,
  databaseReady: true,
  simulationReady: true,
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
  it("projects a fully proven Remote from canonical station facts", async () => {
    const coordinator = createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady() },
    });

    const report = await coordinator.assess(input);

    expect(report).toEqual({
      version: 1,
      state: "ready",
      components: {
        version: "ready",
        configuration: "ready",
        role: "ready",
        host: "ready",
        package: "ready",
        supervisor: "ready",
        projection: "ready",
        database: "ready",
        work: "ready",
        simulation: "ready",
        terminal: "ready",
        browserTransport: "ready",
        browserComposition: "ready",
        display: "ready",
        sandbox: "ready",
        browserCapability: "ready",
      },
    });
    expect(JSON.stringify(report)).not.toContain("token");
    expect(stationReadinessMetadata(report)).toMatchObject({
      readinessVersion: "1",
      readinessState: "ready",
      "readiness.configuration": "ready",
      "readiness.projection": "ready",
      "readiness.database": "ready",
      "readiness.simulation": "ready",
    });
  });

  it("degrades a Remote whose canonical projection is not installed", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady() },
    }).assess({
      ...input,
      projectionInstalled: false,
    });
    expect(report).toMatchObject({
      state: "degraded",
      components: {
        configuration: "ready",
        projection: "degraded",
      },
    });
  });

  it("accepts canonical Command Center projection readiness", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady("local") },
    }).assess({
      ...input,
      configuration: commandCenterConfiguration(),
      projectionInstalled: true,
    });
    expect(report).toMatchObject({
      state: "ready",
      components: {
        configuration: "ready",
        projection: "ready",
      },
    });
  });

  it("degrades when no canonical station configuration exists", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
    }).assess({
      ...input,
      configuration: undefined,
      projectionInstalled: false,
    });

    expect(report.components).toMatchObject({
      configuration: "degraded",
      projection: "degraded",
    });
  });

  it("reports canonical database and simulation readiness independently", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady() },
    }).assess({
      ...input,
      databaseReady: false,
      simulationReady: false,
    });

    expect(report).toMatchObject({
      state: "failed",
      components: {
        database: "failed",
        simulation: "degraded",
      },
    });
  });

  it("fails browser readiness when the receipt is for a different physical host", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe: async () => browserReady("other-host") },
    }).assess(input);

    expect(report.state).toBe("failed");
    expect(report.components).toMatchObject({
      browserTransport: "failed",
      browserCapability: "failed",
    });
  });

  it("states unsupported when no browser product path producer is installed", async () => {
    const report = await createStationReadinessCoordinator({
      terminalProbe: terminalReady,
    }).assess(input);

    expect(report.state).toBe("unsupported");
    expect(report.components).toMatchObject({
      browserTransport: "unsupported",
      display: "unsupported",
    });
  });

  it("joins concurrent callers into one browser probe", async () => {
    let resolve!: (value: BrowserProductPathReceipt) => void;
    const pending = new Promise<BrowserProductPathReceipt>((done) => {
      resolve = done;
    });
    const probe = vi.fn(async () => pending);
    const coordinator = createStationReadinessCoordinator({
      terminalProbe: terminalReady,
      browser: { probe },
    });

    const first = coordinator.assess(input);
    const second = coordinator.assess({
      ...input,
      configuration: remoteConfiguration("ignored-by-joined-flight"),
    });
    resolve(browserReady());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Object),
      expect.any(Object),
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a bounded browser probe does not settle", async () => {
    vi.useFakeTimers();
    const coordinator = createStationReadinessCoordinator({
      timeoutMs: 5,
      terminalProbe: terminalReady,
      browser: {
        probe: async () =>
          new Promise<BrowserProductPathReceipt>(() => undefined),
      },
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
