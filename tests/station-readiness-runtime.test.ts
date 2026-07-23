import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/settings";
import {
  STATION_PULL_STALE_AFTER_MS,
  STATION_STATUS_VERSION,
  type StationStatusDocument,
} from "../src/shared/station-status";
import {
  stationCanvasPullReadiness,
  stationCanvasPullMatchesMirror,
  supervisorAlignedForReadiness,
} from "../src/main/runtime";
import { stationSettingsWitness } from "../src/main/vellum/station-witness";

describe("station readiness runtime facts", () => {
  it.each([
    ["remote", true, "installed", true],
    ["remote", true, "absent", false],
    ["remote", true, "unknown", false],
    ["remote", false, "absent", true],
    ["remote", false, "installed", false],
    ["command-center", false, "absent", true],
    ["command-center", false, "installed", false],
    ["command-center", false, "unknown", true],
  ] as const)(
    "aligns role %s / preference %s with observed provider %s",
    (role, supervisedPreferred, supervisedInstalled, expected) => {
      expect(
        supervisorAlignedForReadiness({
          role,
          hostId: "studio",
          supervisedPreferred,
          supervisedInstalled,
        }),
      ).toBe(expected);
    },
  );

  it("requires a fresh pull admitted for the exact current Remote settings", () => {
    const station = {
      ...defaultSettings().station,
      role: "remote" as const,
      hostId: "studio",
      commandCenterRef: "command-center",
      supervisedPreferred: true,
    };
    const now = Date.parse("2026-07-23T08:00:00.000Z");
    const status: StationStatusDocument = {
      version: STATION_STATUS_VERSION,
      lastPull: {
        at: new Date(now).toISOString(),
        status: "ok",
        ok: true,
        detail: "complete",
        commandCenterRef: station.commandCenterRef,
        keptLocal: false,
        pulledCount: 1,
        failedCount: 0,
        admission: {
          version: 1,
          stationHostId: station.hostId,
          stationConfigSha256: stationSettingsWitness(station),
          canvasMirrorSha256: "a".repeat(64),
          canvasCount: 1,
        },
      },
    };

    expect(stationCanvasPullReadiness(station, status, now)).toBe("fresh");
    expect(
      stationCanvasPullMatchesMirror(status, {
        sha256: "a".repeat(64),
        canvasCount: 1,
      }),
    ).toBe(true);
    expect(
      stationCanvasPullMatchesMirror(status, {
        sha256: "b".repeat(64),
        canvasCount: 1,
      }),
    ).toBe(false);
    expect(
      stationCanvasPullReadiness(
        station,
        status,
        now + STATION_PULL_STALE_AFTER_MS + 1,
      ),
    ).toBe("stale");
    expect(
      stationCanvasPullReadiness(
        station,
        {
          ...status,
          lastPull: {
            ...status.lastPull!,
            at: new Date(now + 1).toISOString(),
          },
        },
        now,
      ),
    ).toBe("stale");
    expect(
      stationCanvasPullReadiness(
        station,
        {
          ...status,
          lastPull: { ...status.lastPull!, admission: undefined },
        },
        now,
      ),
    ).toBe("missing");
    expect(
      stationCanvasPullReadiness(
        { ...station, hostId: "different-seat" },
        status,
        now,
      ),
    ).toBe("missing");
    expect(
      stationCanvasPullReadiness(
        { ...station, commandCenterRef: "different-command-center" },
        status,
        now,
      ),
    ).toBe("missing");
  });

  it("does not require a canvas pull on Command Center", () => {
    expect(
      stationCanvasPullReadiness(
        { ...defaultSettings().station, role: "command-center" },
        { version: STATION_STATUS_VERSION },
      ),
    ).toBe("not-required");
  });
});
