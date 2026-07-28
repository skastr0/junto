import { readFileSync } from "node:fs";
import { Context, Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  InstallationId,
  LogicalSequence,
  StationHostId,
  STATION_API_PROTOCOL,
  StationSha256,
  StatusResponse,
} from "../src/shared/station-api";
import {
  defaultRemoteHostsDocument,
  HostId,
} from "../src/shared/remote-hosts";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type HostCliRunner,
} from "../src/main/vellum/hosts/doctor";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";
import {
  StationFleetPeerUnavailable,
  StationFleetPropagation,
  type StationFleetPropagationResult,
} from "../src/main/vellum/station/fleet-propagation";
import { OPENSSH_CLIENT_EXECUTABLE } from "../src/main/vellum/ssh/live";

const installationId = Schema.decodeUnknownSync(InstallationId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const hostId = Schema.decodeUnknownSync(HostId);
const sequence = Schema.decodeUnknownSync(LogicalSequence);
const sha256 = Schema.decodeUnknownSync(StationSha256);
const localHost = defaultRemoteHostsDocument().hosts[0]!;
const unusedSsh = {} as Parameters<typeof testHostConnection>[0];
type Fleet = Context.Tag.Service<typeof StationFleetPropagation>;
const unusedFleet = {} as Fleet;

const stationStatus = (
  id: string,
  input: {
    readonly state?: "unenrolled" | "ready" | "degraded";
    readonly configured?: boolean;
    readonly ready?: boolean;
  } = {},
) =>
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId: installationId(`station-${id}`),
    state: input.state ?? "ready",
    ...(input.configured === false
      ? {}
      : {
          configuration: {
            role: "remote" as const,
            hostId: stationHostId(id),
            agentHostId: stationHostId(id),
            commandCenterInstallationId:
              installationId("cc-installation"),
            supervisedPreferred: true,
          },
          configuredAt: "2026-07-27T12:00:00.000Z",
        }),
    receivedThrough: [],
    peerAcknowledgedThrough: [],
    readiness: {
      database: true,
      workControl: input.ready ?? true,
      simulation: true,
      session: true,
    },
    ...(input.configured === false
      ? {}
      : {
          projection: {
            generation: sequence("1"),
            contentSha256: sha256("a".repeat(64)),
            receivedAt: "2026-07-27T12:00:00.000Z",
          },
        }),
    observedAt: "2026-07-27T12:00:01.000Z",
  });

const successfulResult = (
  id: string,
  remoteStatus: StatusResponse,
): StationFleetPropagationResult => {
  const active = remoteStatus.projection;
  if (active === undefined) {
    throw new Error("successful fleet observation requires a projection");
  }
  const receipt = {
    stationInstallationId: remoteStatus.installationId,
    remoteStatus,
    projection: {
      decision: "unchanged" as const,
      active,
    },
    report: {
      rounds: 1,
      outboundSent: 0,
      inboundReceived: 0,
      inboundAccepted: 0,
      inboundIdempotent: 0,
      inboundRejected: 0,
      receivedThrough: [],
      hasMoreOutbound: false,
      hasMoreInbound: false,
    },
  };
  const status = {
    hostId: hostId(id),
    stationInstallationId: remoteStatus.installationId,
    phase: "ready" as const,
    sessionOpen: true,
    attempt: 1,
    updatedAt: "2026-07-27T12:00:01.000Z",
    lastReceipt: receipt,
  };
  return {
    ok: true,
    hostId: hostId(id),
    stationInstallationId: remoteStatus.installationId,
    receipt,
    status,
  };
};

const fleetWithStatus = (
  read: (
    id: string,
  ) => Effect.Effect<StatusResponse, StationFleetPeerUnavailable>,
): Fleet =>
  StationFleetPropagation.of({
    start: () => Effect.void,
    request: () => Effect.void,
    synchronize: (selected) => {
      if (selected === undefined) return Effect.succeed([]);
      return read(selected).pipe(
        Effect.map((status) => [successfulResult(selected, status)]),
        Effect.catchAll((error) =>
          Effect.succeed([
            {
              ok: false as const,
              hostId: selected,
              ...(error.stationInstallationId === undefined
                ? {}
                : {
                    stationInstallationId:
                      error.stationInstallationId,
                  }),
              error,
            },
          ])
        ),
      );
    },
    status: () => Effect.succeed(undefined),
    statuses: Effect.succeed([]),
    stop: Effect.void,
  });

describe("remote hosts doctor", () => {
  it("contains no alternate store or SSH executable authority", () => {
    const doctorSource = readFileSync(
      new URL("../src/main/vellum/hosts/doctor.ts", import.meta.url),
      "utf8",
    );
    const liveSource = readFileSync(
      new URL("../src/main/vellum/ssh/live.ts", import.meta.url),
      "utf8",
    );
    expect(doctorSource).not.toMatch(
      /settings\.json|station-status\.json|remoteCat|homeDirectoryLookup/u,
    );
    expect(liveSource).toContain(
      "sshExecutable: OPENSSH_CLIENT_EXECUTABLE",
    );
    expect(OPENSSH_CLIENT_EXECUTABLE).toBe("/usr/bin/ssh");
  });

  it("executes exact local Herdr and Hermes version argv", async () => {
    const run = vi.fn<HostCliRunner>(
      async (command): Promise<CliResult> => ({
        ok: true,
        stdout: `${command} 1.0.0\n`,
      }),
    );
    const registry = {
      list: async () => [localHost],
    } as unknown as HostsRegistry;

    const report = await Effect.runPromise(
      runRemoteHostsDoctor(registry, unusedSsh, unusedFleet, run),
    );

    expect(run.mock.calls).toEqual([
      ["herdr", ["--version"], 5_000],
      ["hermes", ["version"], 5_000],
    ]);
    expect(report.status).toBe("ok");
    expect(report.metadata).toEqual({
      hostCount: "1",
      remoteHostCount: "0",
      hermesKeys: "local",
      browserHostCount: "1",
      browserHostIds: "local",
    });
  });

  it("keeps a local-only Command Center independent of remote transport", async () => {
    const run = vi.fn<HostCliRunner>(
      async (command): Promise<CliResult> => ({
        ok: true,
        stdout: `${command} 1.0.0\n`,
      }),
    );
    const registry = {
      list: async () => [localHost],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(
        registry,
        unusedSsh,
        unusedFleet,
        run,
      ),
    );

    expect(snapshot.check.status).toBe("ok");
    expect(snapshot.check.detail).toContain(
      "no remote ssh hosts configured",
    );
    expect(snapshot.observations).toEqual([]);
  });

  it("derives local connection success only from structured probes", async () => {
    const failedRun: HostCliRunner = async (command) =>
      command === "herdr"
        ? {
            ok: false,
            stdout: "",
            error: "probe exited unsuccessfully",
          }
        : { ok: true, stdout: "hermes ready" };

    const failed = await Effect.runPromise(
      testHostConnection(
        unusedSsh,
        unusedFleet,
        localHost,
        failedRun,
      ),
    );
    expect(failed.ok).toBe(false);

    const successfulRun: HostCliRunner = async (command) => ({
      ok: true,
      stdout: `${command} changelog: not found wording is harmless`,
    });
    const successful = await Effect.runPromise(
      testHostConnection(
        unusedSsh,
        unusedFleet,
        localHost,
        successfulRun,
      ),
    );
    expect(successful.ok).toBe(true);
  });

  it("probes Station APIs concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const fleet = fleetWithStatus((id) =>
      Effect.gen(function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.sleep(20);
        active -= 1;
        return stationStatus(id);
      }),
    );
    const registry = {
      list: async () =>
        ["a", "b", "c"].map((id) => ({
          id,
          label: id.toUpperCase(),
          kind: "remote" as const,
          sshEndpoint: id,
          capabilities: [],
        })),
    } as unknown as HostsRegistry;

    const report = await Effect.runPromise(
      runRemoteHostsDoctor(
        registry,
        unusedSsh,
        fleet,
        async () => ({ ok: true, stdout: "" }),
      ),
    );

    expect(maxActive).toBe(3);
    expect(report.status).toBe("ok");
    expect(report.detail).toContain("Station API ready");
  });

  it("returns typed observations from Station API status", async () => {
    const fleet = fleetWithStatus(() =>
      Effect.succeed(stationStatus("studio")),
    );
    const registry = {
      list: async () => [
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          sshEndpoint: "studio-box",
          capabilities: ["browser" as const],
        },
      ],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(
        registry,
        unusedSsh,
        fleet,
        async () => ({ ok: true, stdout: "" }),
      ),
    );

    expect(snapshot.check.status).toBe("ok");
    expect(snapshot.observations).toEqual([
      {
        hostId: "studio",
        endpoint: "studio-box",
        reachability: "reachable",
        station: stationStatus("studio"),
      },
    ]);
    expect(snapshot.check.detail).toContain(
      "readiness database=true work=true simulation=true",
    );
    expect(snapshot.observations[0]?.station?.readiness.session).toBe(true);
  });

  it("keeps failed Station API observations fleet-blind", async () => {
    const fleet = fleetWithStatus(() =>
      Effect.fail(
        StationFleetPeerUnavailable.make({
          hostId: hostId("studio"),
          stationInstallationId: installationId("station-studio"),
          reason: "connection-failed",
          causeTag: "StationPeerSessionClosedError",
          message: "station runtime down",
        }),
      ),
    );
    const registry = {
      list: async () => [
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          sshEndpoint: "studio-box",
          capabilities: [],
        },
      ],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(
        registry,
        unusedSsh,
        fleet,
        async () => ({ ok: true, stdout: "" }),
      ),
    );

    expect(snapshot.check.status).toBe("error");
    expect(snapshot.observations).toEqual([
      {
        hostId: "studio",
        endpoint: "studio-box",
        reachability: "unreachable",
        reachabilityError: "station runtime down",
        observationError: "station runtime down",
      },
    ]);
    expect(snapshot.observations[0]).not.toHaveProperty("station");
    expect(snapshot.observations[0]).not.toHaveProperty("settingsState");
    expect(snapshot.observations[0]).not.toHaveProperty("statusState");
  });

  it("does not use bootstrap status as a Doctor fallback for an unenrolled host", async () => {
    const fleet = fleetWithStatus(() =>
      Effect.fail(
        StationFleetPeerUnavailable.make({
          hostId: hostId("studio"),
          reason: "not-enrolled",
          message: "Station host is not an enrolled fleet target",
        }),
      ),
    );
    const host = {
      id: "studio",
      label: "Studio",
      kind: "remote" as const,
      sshEndpoint: "studio-box",
      capabilities: [],
    };

    const result = await Effect.runPromise(
      testHostConnection(
        unusedSsh,
        fleet,
        host,
        async () => ({ ok: true, stdout: "" }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      reachability: "unknown",
    });
    expect(result.detail).toContain(
      "not enrolled in the persistent fleet",
    );
  });
});
