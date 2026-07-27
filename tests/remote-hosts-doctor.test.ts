import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InstallationId,
  StationHostId,
  STATION_API_PROTOCOL,
  StatusResponse,
} from "../src/shared/station-api";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type HostCliRunner,
} from "../src/main/vellum/hosts/doctor";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";
import type { StationRemote } from "../src/main/vellum/hosts/configure-remote";
import { StationRemoteExecutionError } from "../src/main/vellum/station/remote-client";
import { SshEndpoint } from "../src/main/vellum/ssh/domain";

const installationId = Schema.decodeUnknownSync(InstallationId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const sshEndpoint = Schema.decodeUnknownSync(SshEndpoint);
const localHost = defaultRemoteHostsDocument().hosts[0]!;
const unusedSsh = {} as Parameters<typeof testHostConnection>[0];

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
            commandCenterRef: "local",
            supervisedPreferred: true,
          },
          configuredAt: "2026-07-27T12:00:00.000Z",
        }),
    receivedThrough: [],
    readiness: {
      database: true,
      workControl: input.ready ?? true,
      simulation: true,
    },
    observedAt: "2026-07-27T12:00:01.000Z",
  });

const remoteWithStatus = (
  status: StationRemote["status"],
): StationRemote =>
  ({
    status,
    pair: () => Effect.die("pair must not run"),
    configure: () => Effect.die("configure must not run"),
    project: () => Effect.die("project must not run"),
    report: () => Effect.die("report must not run"),
  }) as StationRemote;

afterEach(() => {
  delete process.env.VELLUM_SSH_EXECUTABLE;
});

describe("remote hosts doctor", () => {
  it("contains no remote settings or station-status file lane", () => {
    const source = readFileSync(
      new URL("../src/main/vellum/hosts/doctor.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /settings\.json|station-status\.json|remoteCat|homeDirectoryLookup/u,
    );
  });

  it("executes exact local Herdr and Hermes version argv", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
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
      runRemoteHostsDoctor(registry, unusedSsh, run),
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

  it("keeps a local-only Command Center healthy without an SSH client", async () => {
    process.env.VELLUM_SSH_EXECUTABLE =
      "/definitely/not/an/ssh-client";
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
      runRemoteHostsDoctorSnapshot(registry, unusedSsh, run),
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
      testHostConnection(unusedSsh, localHost, failedRun),
    );
    expect(failed.ok).toBe(false);

    const successfulRun: HostCliRunner = async (command) => ({
      ok: true,
      stdout: `${command} changelog: not found wording is harmless`,
    });
    const successful = await Effect.runPromise(
      testHostConnection(unusedSsh, localHost, successfulRun),
    );
    expect(successful.ok).toBe(true);
  });

  it("probes Station APIs concurrently", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    let active = 0;
    let maxActive = 0;
    const remote = remoteWithStatus((endpoint) =>
      Effect.gen(function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.sleep(20);
        active -= 1;
        return stationStatus(endpoint);
      }),
    );
    const registry = {
      list: async () =>
        ["a", "b", "c"].map((id) => ({
          id,
          label: id.toUpperCase(),
          kind: "remote" as const,
          endpoint: id,
          capabilities: [],
        })),
    } as unknown as HostsRegistry;

    const report = await Effect.runPromise(
      runRemoteHostsDoctor(
        registry,
        unusedSsh,
        async () => ({ ok: true, stdout: "" }),
        remote,
      ),
    );

    expect(maxActive).toBe(3);
    expect(report.status).toBe("ok");
    expect(report.detail).toContain("Station API ready");
  });

  it("returns typed observations from Station API status", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    const remote = remoteWithStatus(() =>
      Effect.succeed(stationStatus("studio")),
    );
    const registry = {
      list: async () => [
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          endpoint: "studio-box",
          capabilities: ["browser" as const],
        },
      ],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(
        registry,
        unusedSsh,
        async () => ({ ok: true, stdout: "" }),
        remote,
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
  });

  it("keeps failed Station API observations fleet-blind", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    const remote = remoteWithStatus(() =>
      Effect.fail(
        StationRemoteExecutionError.make({
          endpoint: sshEndpoint("studio-box"),
          operation: "status",
          exitCode: 1,
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
          endpoint: "studio-box",
          capabilities: [],
        },
      ],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(
        registry,
        unusedSsh,
        async () => ({ ok: true, stdout: "" }),
        remote,
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

  it("marks a reachable but unconfigured Station as warning", async () => {
    const remote = remoteWithStatus(() =>
      Effect.succeed(
        stationStatus("studio", {
          state: "unenrolled",
          configured: false,
        }),
      ),
    );
    const host = {
      id: "studio",
      label: "Studio",
      kind: "remote" as const,
      endpoint: "studio-box",
      capabilities: [],
    };

    const result = await Effect.runPromise(
      testHostConnection(
        unusedSsh,
        host,
        async () => ({ ok: true, stdout: "" }),
        remote,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      reachability: "reachable",
    });
    expect(result.detail).toContain("configuration absent");
  });
});
