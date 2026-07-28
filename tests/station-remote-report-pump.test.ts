import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";
import {
  startStationRemoteReportPump,
} from "../src/main/vellum/station/remote-report-pump";

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const remote = installation("remote-report-pump");
const commandCenter = installation("cc-report-pump");
const remoteHost = Schema.decodeUnknownSync(StationHostId)("remote");
const localHost = Schema.decodeUnknownSync(StationHostId)("local");

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition did not settle");
};

const fixture = (
  role: "remote" | "command-center",
  options: { readonly firstPageHasMore?: boolean } = {},
) => {
  const workListeners = new Set<
    (canvasName: string, nodeId: string) => void
  >();
  const sessionListeners = new Set<(ready: boolean) => void>();
  let sessionReady = false;
  let prepared = 0;
  let reported = 0;
  let accepted = 0;

  const api = {
    prepareReport: () => {
      prepared += 1;
      return Effect.succeed(
        ReportRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          senderInstallationId: remote,
          targetInstallationId: commandCenter,
          batch: {
            records: [],
            acknowledge: [],
            hasMore:
              options.firstPageHasMore === true && prepared === 1,
          },
        }),
      );
    },
    acceptReportResponse: () => {
      accepted += 1;
      return Effect.succeed({
        accepted: 0,
        idempotent: 0,
        rejected: 0,
        receivedThrough: [],
        peerHasMore: false,
      });
    },
  };
  const stations = {
    configuration: Effect.succeed({
      configuration:
        role === "remote"
          ? {
              role: "remote" as const,
              hostId: remoteHost,
              agentHostId: remoteHost,
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            }
          : {
              role: "command-center" as const,
              hostId: localHost,
              supervisedPreferred: true,
            },
      configuredAt: "2026-07-27T23:00:00.000Z",
    }),
    pairing: Effect.succeed(
      role === "remote"
        ? {
            commandCenterInstallationId: commandCenter,
            stationLabel: "Remote",
            appVersion: "0.0.0-test",
            pairedAt: "2026-07-27T23:00:00.000Z",
          }
        : undefined,
    ),
  };
  const work = {
    subscribeChanges: (
      listener: (canvasName: string, nodeId: string) => void,
    ) => {
      workListeners.add(listener);
      return () => {
        workListeners.delete(listener);
      };
    },
  };
  const control = {
    report: async () => {
      reported += 1;
      return ReportResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "report",
        senderInstallationId: commandCenter,
        targetInstallationId: remote,
        batch: {
          records: [],
          acknowledge: [],
          hasMore: false,
        },
      });
    },
    sessionReady: () => sessionReady,
    subscribeSession: (listener: (ready: boolean) => void) => {
      sessionListeners.add(listener);
      listener(sessionReady);
      return () => sessionListeners.delete(listener);
    },
  };

  return {
    input: { api, stations, work, control },
    counts: () => ({ prepared, reported, accepted }),
    connect: () => {
      sessionReady = true;
      for (const listener of sessionListeners) listener(true);
    },
    changeWork: () => {
      for (const listener of workListeners) {
        listener("factory", "sink");
      }
    },
    listenerCounts: () => ({
      work: workListeners.size,
      session: sessionListeners.size,
    }),
  };
};

describe("Remote Station report pump", () => {
  it("wakes on the admitted session and drains every durable report page", async () => {
    const state = fixture("remote", { firstPageHasMore: true });
    const pump = startStationRemoteReportPump(state.input);

    expect(state.counts()).toEqual({
      prepared: 0,
      reported: 0,
      accepted: 0,
    });
    state.connect();
    await waitFor(() => state.counts().accepted === 2);

    expect(state.counts()).toEqual({
      prepared: 2,
      reported: 2,
      accepted: 2,
    });
    expect(pump.status()).toMatchObject({
      running: false,
      pending: false,
    });
    await pump.close();
    expect(state.listenerCounts()).toEqual({ work: 0, session: 0 });
  });

  it("coalesces offline work and reports it on the next session", async () => {
    const state = fixture("remote");
    const pump = startStationRemoteReportPump(state.input);

    state.changeWork();
    state.changeWork();
    await waitFor(() => pump.status().running === false);
    expect(state.counts().reported).toBe(0);

    state.connect();
    await waitFor(() => state.counts().accepted === 1);
    expect(state.counts().reported).toBe(1);
    await pump.close();
  });

  it("never originates a report from a Command Center listener", async () => {
    const state = fixture("command-center");
    const pump = startStationRemoteReportPump(state.input);

    state.connect();
    state.changeWork();
    await waitFor(() => pump.status().running === false);
    expect(state.counts()).toEqual({
      prepared: 0,
      reported: 0,
      accepted: 0,
    });
    await pump.close();
  });
});
