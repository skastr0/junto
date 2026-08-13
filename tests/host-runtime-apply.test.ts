import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { ConfigureRemoteOptions } from "../src/main/vellum/hosts/configure-remote";
import { applyDarwinHostRuntime } from "../src/main/vellum/hosts/host-runtime-darwin";
import { applyLinuxHostRuntime } from "../src/main/vellum/hosts/host-runtime-linux";
import type { HostRuntimeApplyContext } from "../src/main/vellum/hosts/host-runtime-platform";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import type { SshTransportShape } from "../src/main/vellum/ssh/service";

const installationId = Schema.decodeUnknownSync(InstallationId);
const commandCenterInstallationId = installationId("cc-installation");

const configure: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  appVersion: "0.1.0",
};

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const ssh = {
  warm: vi.fn(() => Effect.void),
  run: vi.fn(),
  forward: vi.fn(),
};

const context = (
  gap: HostRuntimeApplyContext["gap"],
  prior?: string,
): HostRuntimeApplyContext => ({
  ssh: ssh as unknown as SshTransportShape,
  host,
  gap,
  configure,
  ...(prior === undefined ? {} : { priorInstallationId: installationId(prior) }),
});

const successfulConfiguration = {
  ok: true,
  detail: "configured through Station API",
  stationInstallationId: installationId("station-installation"),
  configuredAt: "2026-07-27T12:00:02.000Z",
  station: {
    role: "remote" as const,
    hostId: "studio",
    supervisedPreferred: true,
  },
};

const readyPackage = {
  ok: true as const,
  detail: "package ready",
  stages: ["endpoint ok", "ssh warm ok"],
  disposition: "ready" as const,
  version: "1.2.3",
};

describe("Darwin HostRuntime apply", () => {
  it("configures and activates on first install, never claiming applied first", async () => {
    const states: string[] = [];
    const configureFn = vi.fn(() => Effect.succeed(successfulConfiguration as never));
    const activate = vi.fn(() =>
      Effect.succeed({
        ok: true,
        detail: "Vellum Command is running on this Mac",
        stages: [],
        disposition: "ready" as const,
      }),
    );
    const result = await Effect.runPromise(
      applyDarwinHostRuntime(context("needInstall"), {
        deploy: (input) => {
          states.push(input.stationConfiguration.state);
          expect(input.target.platform).toEqual({
            platform: "darwin",
            kernelName: "Darwin",
          });
          return Effect.succeed({
            ...readyPackage,
            disposition: "configuration-required" as const,
          });
        },
        configure: configureFn,
        activate,
      }),
    );
    expect(states).toEqual(["managed-externally"]);
    expect(configureFn).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.role).toBe("remote");
    expect(result.detail).toContain("Vellum Command is running on this Mac");
  });

  it("skips configure on needRestart and still activates", async () => {
    const configureFn = vi.fn(() => Effect.succeed(successfulConfiguration as never));
    const activate = vi.fn(() =>
      Effect.succeed({
        ok: true,
        detail: "supervised Remote runtime ready",
        stages: [],
        disposition: "ready" as const,
      }),
    );
    const result = await Effect.runPromise(
      applyDarwinHostRuntime(context("needRestart", "station-installation"), {
        deploy: (input) => {
          expect(input.stationConfiguration).toEqual({
            state: "applied",
            remoteHostId: "studio",
          });
          return Effect.succeed(readyPackage);
        },
        configure: configureFn,
        activate,
      }),
    );
    expect(configureFn).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.configuration.detail).toContain("configure skipped");
    expect(result.stationInstallationId).toBe("station-installation");
  });
});

describe("Linux HostRuntime apply", () => {
  it("builds the target from observed linux + parse + warm, then configures first install", async () => {
    const configureFn = vi.fn(() => Effect.succeed(successfulConfiguration as never));
    const result = await Effect.runPromise(
      applyLinuxHostRuntime(context("needConfigure"), {
        deploy: (input) => {
          expect(input.target.platform).toEqual({
            platform: "linux",
            kernelName: "Linux",
          });
          expect(input.target.progress).toEqual(["endpoint ok", "ssh warm ok"]);
          expect(input.stationConfiguration.state).toBe("managed-externally");
          expect(String(input.target.endpoint)).toBe(
            String(Effect.runSync(parseSshEndpoint("studio-box"))),
          );
          return Effect.succeed(readyPackage);
        },
        configure: configureFn,
      }),
    );
    expect(ssh.warm).toHaveBeenCalled();
    expect(configureFn).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("configured");
  });

  it("does not configure on needRestart", async () => {
    const configureFn = vi.fn(() => Effect.succeed(successfulConfiguration as never));
    const result = await Effect.runPromise(
      applyLinuxHostRuntime(context("needRestart", "station-box"), {
        deploy: (input) => {
          expect(input.stationConfiguration.state).toBe("applied");
          return Effect.succeed(readyPackage);
        },
        configure: configureFn,
      }),
    );
    expect(configureFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.configuration.detail).toContain("configure skipped");
  });
});
