import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import type { CliResult } from "../src/main/vellum/adapters/exec";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type HostCliRunner,
} from "../src/main/vellum/hosts/doctor";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";

const localHost = defaultRemoteHostsDocument().hosts[0]!;
const unusedSsh = {} as Parameters<typeof testHostConnection>[0];

afterEach(() => {
  delete process.env.VELLUM_SSH_EXECUTABLE;
});

describe("remote hosts doctor binary probes", () => {
  it("executes exact Herdr and Hermes version argv", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    const run = vi.fn<HostCliRunner>(async (command): Promise<CliResult> => ({
      ok: true,
      stdout: `${command} 1.0.0\n`,
    }));
    const registry = {
      path: () => "/tmp/vellum-hosts-test.json",
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
    expect(report.metadata).toMatchObject({
      browserHostCount: "1",
      browserHostIds: "local",
    });
    expect(report.detail).toContain("browser capability declared");
  });

  it("keeps a local-only Command Center healthy without an SSH client", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/definitely/not/an/ssh-client";
    const run = vi.fn<HostCliRunner>(async (command): Promise<CliResult> => ({
      ok: true,
      stdout: `${command} 1.0.0\n`,
    }));
    const registry = {
      path: () => "/tmp/vellum-hosts-test.json",
      list: async () => [localHost],
    } as unknown as HostsRegistry;

    const snapshot = await Effect.runPromise(
      runRemoteHostsDoctorSnapshot(registry, unusedSsh, run),
    );

    expect(snapshot.check.status).toBe("ok");
    expect(snapshot.check.detail).toContain("no remote ssh hosts configured");
    expect(snapshot.observations).toEqual([]);
  });

  it("derives local connection success only from structured probe results", async () => {
    const failedRun: HostCliRunner = async (command) => command === "herdr"
      ? { ok: false, stdout: "", error: "probe exited unsuccessfully" }
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

  it("probes configured remote hosts concurrently", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    let active = 0;
    let maxActive = 0;
    const ssh = {
      warm: () =>
        Effect.gen(function* () {
          active += 1;
          maxActive = Math.max(maxActive, active);
          yield* Effect.sleep(20);
          active -= 1;
        }),
      run: () => Effect.succeed({ stdout: "/Users/test", stderr: "" }),
    } as unknown as Parameters<typeof runRemoteHostsDoctor>[1];
    const registry = {
      path: () => "/tmp/vellum-hosts-test.json",
      list: async () => ["a", "b", "c"].map((id) => ({
        id,
        label: id.toUpperCase(),
        kind: "remote" as const,
        endpoint: id,
        capabilities: ["herdr" as const],
      })),
    } as unknown as HostsRegistry;

    const report = await Effect.runPromise(
      runRemoteHostsDoctor(registry, ssh),
    );

    expect(maxActive).toBe(3);
    expect(report.status).toBe("warning");
    expect(report.detail).toContain("station settings unavailable");
  });

  it("returns typed live Remote station observations without raw status payloads", async () => {
    process.env.VELLUM_SSH_EXECUTABLE = "/usr/bin/ssh";
    let call = 0;
    const ssh = {
      warm: () => Effect.void,
      run: () => {
        call += 1;
        if (call === 1) {
          return Effect.succeed({ stdout: "/Users/test", stderr: "" });
        }
        if (call === 2) {
          return Effect.succeed({
            stdout: JSON.stringify({
              version: 1,
              station: {
                role: "remote",
                hostId: "studio",
              },
            }),
            stderr: "",
          });
        }
        return Effect.succeed({
          stdout: JSON.stringify({
            version: 1,
            lastPull: {
              at: "2026-07-23T11:45:00.000Z",
              status: "ok",
              ok: true,
              detail: "private pull detail",
              commandCenterRef: "private-cc",
              keptLocal: false,
              pulledCount: 1,
              failedCount: 0,
            },
            kernel: {
              observedAt: "2026-07-23T11:59:30.000Z",
              armedRegionCount: 1,
              lastFireAt: "2026-07-23T11:58:00.000Z",
              lastFireKind: "watcher",
              lastFireDry: false,
              orphanedArmingCount: 0,
            },
          }),
          stderr: "",
        });
      },
    } as unknown as Parameters<typeof runRemoteHostsDoctorSnapshot>[1];
    const registry = {
      path: () => "/tmp/vellum-hosts-test.json",
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
      runRemoteHostsDoctorSnapshot(registry, ssh),
    );

    expect(snapshot.check.status).toBe("ok");
    expect(snapshot.observations).toEqual([
      {
        hostId: "studio",
        endpoint: "studio-box",
        reachability: "reachable",
        settingsState: "observed",
        stationRole: "remote",
        stationHostId: "studio",
        statusState: "observed",
        status: expect.objectContaining({
          version: 1,
          kernel: expect.objectContaining({ armedRegionCount: 1 }),
        }),
      },
    ]);
    expect(snapshot.check.detail).not.toContain("private pull detail");
    expect(snapshot.check.detail).not.toContain("private-cc");
  });
});
