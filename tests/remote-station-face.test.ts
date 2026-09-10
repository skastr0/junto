import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "@shared/contracts";
import { PRODUCT_NAME } from "@shared/product-name";
import { RemoteStationFaceView } from "../src/renderer/components/remote/RemoteStationFace";
import {
  formatRemoteProjection,
  identityFromStation,
  loadRemoteStationFaceStats,
  pickRemoteStationFaceApi,
  readRemoteLastCheckIn,
  statsFromDoctor,
  statsFromTerminals,
} from "../src/renderer/lib/remote-station-face";

const doctorReport = (
  patch: Partial<DoctorReport> & {
    readonly stationMeta?: Readonly<Record<string, string>>;
  } = {},
): DoctorReport => ({
  checkedAt: "2026-08-13T00:00:00.000Z",
  station: {
    name: "box",
    version: "0.1.13",
    userDataPath: "/tmp",
    ...patch.station,
  },
  services: patch.services ?? [
    {
      id: "station",
      label: "Station",
      status: "ok",
      detail: "installation inst-1",
      metadata: {
        installationId: "inst-1",
        projectionGeneration: "7",
        projectionReceivedAt: "2026-08-13T01:00:00.000Z",
        lastCheckInAt: "2026-08-13T01:05:00.000Z",
        ...patch.stationMeta,
      },
    },
    {
      id: "work",
      label: "Work",
      status: "warning",
      detail: "work control not ready",
    },
  ],
  recommendations: [],
});

describe("pickRemoteStationFaceApi", () => {
  it("prefers vellumCommand.doctor and otherwise uses chassis.doctor", () => {
    const fromVellum = async () => doctorReport();
    const fromChassis = async () => doctorReport();
    expect(
      pickRemoteStationFaceApi({ doctor: fromVellum }, { doctor: fromChassis })
        .doctor,
    ).toBeTypeOf("function");
    expect(pickRemoteStationFaceApi({}, { doctor: fromChassis }).doctor).toBeTypeOf(
      "function",
    );
    expect(pickRemoteStationFaceApi({}, {}).doctor).toBeUndefined();
  });

  it("skips terminal counts when terminalList is absent", () => {
    expect(pickRemoteStationFaceApi({ terminalGet: async () => undefined }).terminalList)
      .toBeUndefined();
    expect(
      pickRemoteStationFaceApi({ terminalList: async () => [] }).terminalList,
    ).toBeTypeOf("function");
  });
});

describe("remote station face stats", () => {
  it("keeps role and host from settings even when doctor is absent", () => {
    expect(identityFromStation({ role: "remote", hostId: "mac-studio" })).toEqual({
      role: "remote",
      hostId: "mac-studio",
    });
  });

  it("reads version, installation, projection, and last check-in from doctor", () => {
    const stats = statsFromDoctor(doctorReport());
    expect(stats.appVersion).toBe("0.1.13");
    expect(stats.installationId).toBe("inst-1");
    expect(stats.projection).toBe("7, received 2026-08-13T01:00:00.000Z");
    expect(stats.lastCheckIn).toBe("2026-08-13T01:05:00.000Z");
    expect(stats.services).toEqual([
      { label: "Station", status: "ok", detail: "installation inst-1" },
      { label: "Work", status: "warning", detail: "work control not ready" },
    ]);
  });

  it("omits unknown projection and check-in metadata", () => {
    expect(
      formatRemoteProjection({
        projectionGeneration: "unknown",
        projectionReceivedAt: "unknown",
      }),
    ).toBeUndefined();
    expect(readRemoteLastCheckIn({ lastCheckInAt: "unknown" })).toBeUndefined();
    expect(
      readRemoteLastCheckIn({ "remote.box.lastCheckInAt": "2026-08-13T02:00:00.000Z" }),
    ).toBe("2026-08-13T02:00:00.000Z");
  });

  it("counts terminals only from a successful list", async () => {
    expect(
      statsFromTerminals([
        { status: "running" },
        { status: "exited" },
        { status: "starting" },
      ]),
    ).toEqual({ terminalCount: 3, runningTerminalCount: 1 });

    const loaded = await loadRemoteStationFaceStats(
      { role: "remote", hostId: "box" },
      {},
    );
    expect(loaded.terminalCount).toBeUndefined();
    expect(loaded.services).toBeUndefined();
    expect(loaded.role).toBe("remote");

    const withApis = await loadRemoteStationFaceStats(
      { role: "remote", hostId: "box" },
      {
        doctor: async () => doctorReport(),
        terminalList: async () =>
          [
            { status: "running" },
            { status: "missing" },
          ] as never,
      },
    );
    expect(withApis.terminalCount).toBe(2);
    expect(withApis.runningTerminalCount).toBe(1);
    expect(withApis.installationId).toBe("inst-1");
  });

  it("drops doctor and terminal sections when those calls fail", async () => {
    const stats = await loadRemoteStationFaceStats(
      { role: "remote", hostId: "box" },
      {
        doctor: async () => {
          throw new Error("doctor down");
        },
        terminalList: async () => {
          throw new Error("term down");
        },
      },
    );
    expect(stats).toEqual({ role: "remote", hostId: "box" });
  });
});

describe("RemoteStationFaceView", () => {
  it("renders the Remote title and identity without Command Center chrome", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteStationFaceView, {
        stats: {
          role: "remote",
          hostId: "mac-studio",
          installationId: "inst-1",
          appVersion: "0.1.13",
          projection: "7, received 2026-08-13T01:00:00.000Z",
          lastCheckIn: "2026-08-13T01:05:00.000Z",
          terminalCount: 2,
          runningTerminalCount: 1,
          services: [
            { label: "Station", status: "ok", detail: "database ready" },
          ],
        },
      }),
    );
    expect(html).toContain(`${PRODUCT_NAME} Remote`);
    expect(html).toContain("data-remote-station-face");
    expect(html).toContain("mac-studio");
    expect(html).toContain("inst-1");
    expect(html).toContain("0.1.13");
    expect(html).toContain("2 total, 1 running");
    expect(html).toContain("database ready");
    expect(html).not.toContain("Command Fleet");
    expect(html).not.toContain("WorkFocusShell");
    expect(html).not.toContain("add-item");
    expect(html).not.toMatch(/\u00B7/);
    expect(html).not.toMatch(/\bVellum\b(?! Command)/);
  });

  it("omits optional rows when stats only have identity", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteStationFaceView, {
        stats: { role: "remote", hostId: "box" },
      }),
    );
    expect(html).toContain("Role");
    expect(html).not.toContain("Installation");
    expect(html).not.toContain("Doctor");
    expect(html).not.toContain("Terminals");
    expect(html).not.toContain("Projection");
    expect(html).not.toContain("Last check-in");
  });
});

describe("App remote mount", () => {
  const app = readFileSync(
    join(import.meta.dirname, "..", "src/renderer/App.tsx"),
    "utf8",
  );

  it("mounts RemoteStationFace only for role remote, leaving the Command Center tree intact", () => {
    expect(app).toContain(
      'import { RemoteStationFace } from "./components/remote/RemoteStationFace"',
    );
    const remoteBranch = app.indexOf('if (stationRole === "remote")');
    const remoteMount = app.indexOf("<RemoteStationFace");
    const ccShell = app.indexOf('className="vellum-app');
    expect(remoteBranch).toBeGreaterThan(-1);
    expect(remoteMount).toBeGreaterThan(remoteBranch);
    expect(remoteMount).toBeLessThan(ccShell);
    expect(app).toContain("<TopBar");
    expect(app).toContain("<Canvas");
    expect(app).toContain("<WorkFocusShell");
    expect(app).toContain("isCommandCenterFleetUi(stationRole)");
  });
});
