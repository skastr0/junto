import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveFleetCompatibilitySnapshot,
  type FleetPeerCompatibilitySnapshot,
} from "../src/shared/fleet-compatibility-snapshot";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";
import {
  FleetCompatibilitySection,
  compatibilityStatusColor,
} from "../src/renderer/components/fleet/FleetCompatibilitySection";
import { RemoteStationFaceView } from "../src/renderer/components/remote/RemoteStationFace";
import { statsFromDoctor } from "../src/renderer/lib/remote-station-face";
import { GREEN, HUE } from "../src/renderer/lib/theme";

const now = Date.parse("2026-08-18T12:00:00.000Z");
const observedAt = new Date(now - 1_000).toISOString();

const renderSection = (snapshot: FleetPeerCompatibilitySnapshot): string =>
  renderToStaticMarkup(createElement(FleetCompatibilitySection, { snapshot }));

const rendererSourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });

const observedRemote = {
  hostId: "studio",
  endpoint: "ssh://studio",
  reachability: "reachable" as const,
  source: "live" as const,
  observedAt,
  route: {
    phase: "ready" as const,
    sessionOpen: true,
    attempt: 1,
    updatedAt: observedAt,
  },
  protocol: {
    compatibility: "compatible" as const,
    negotiatedProtocol: 1,
    local: {
      appVersion: "0.1.14",
      stateSchemaVersion: 22,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    },
    peer: {
      appVersion: "0.1.14",
      stateSchemaVersion: 22,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    },
  },
};

describe("Fleet compatibility truth consumers", () => {
  it("renders missing evidence as checking, never Fully compatible", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({ hostId: "studio" });
    const html = renderSection(snapshot);

    expect(snapshot.status).toBe("checking");
    expect(compatibilityStatusColor(snapshot.status)).toBe(HUE.cyan);
    expect(html).toContain("Checking compatibility");
    expect(html).toContain("evidence unavailable");
    expect(html).not.toContain("Fully compatible");
    expect(html).not.toContain("0 pending");
  });

  it("renders Exact only when the supplied snapshot carries explicit proof", () => {
    const snapshot = deriveFleetCompatibilitySnapshot({
      hostId: "studio",
      remoteObservation: observedRemote,
      semanticObservation: { status: "exact" },
      nowMs: now,
    });
    const html = renderSection(snapshot);

    expect(snapshot.status).toBe("exact");
    expect(compatibilityStatusColor(snapshot.status)).toBe(GREEN);
    expect(html).toContain("Fully compatible");
    expect(html).toContain("v1");
    expect(html).toContain("Work backlog");
    expect(html).toContain("evidence unavailable");
  });

  it("Remote station face renders only the Main-supplied Doctor snapshot", () => {
    const baseReport = {
      checkedAt: observedAt,
      station: {
        name: "Junto",
        version: "0.1.14",
        userDataPath: "/tmp/junto",
      },
      services: [],
      recommendations: [],
    };
    const withoutSnapshotStats = statsFromDoctor(baseReport);
    const withoutSnapshot = renderToStaticMarkup(
      createElement(RemoteStationFaceView, {
        stats: { role: "remote", hostId: "studio", ...withoutSnapshotStats },
      }),
    );
    expect(withoutSnapshot).not.toContain("Compatibility</dt>");

    const snapshot = deriveFleetCompatibilitySnapshot({ hostId: "studio" });
    const withSnapshotStats = statsFromDoctor({
      ...baseReport,
      fleetCompatibility: snapshot,
    });
    const withSnapshot = renderToStaticMarkup(
      createElement(RemoteStationFaceView, {
        stats: { role: "remote", hostId: "studio", ...withSnapshotStats },
      }),
    );
    expect(withSnapshot).toContain("Compatibility</dt>");
    expect(withSnapshot).toContain("Checking compatibility");
  });

  it("renderer sources cannot derive a Fleet compatibility snapshot", () => {
    const sources = rendererSourceFiles("src/renderer").map((path) =>
      readFileSync(path, "utf8"),
    );

    for (const source of sources) {
      expect(source).not.toContain("deriveFleetCompatibilitySnapshot");
    }
    expect(
      readFileSync("src/renderer/lib/remote-station-face.ts", "utf8"),
    ).toContain("report.fleetCompatibility");
  });
});
