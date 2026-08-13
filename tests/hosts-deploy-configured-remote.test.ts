import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { ConfigureRemoteOptions } from "../src/main/vellum/hosts/configure-remote";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployOperations,
} from "../src/main/vellum/hosts/deploy-configured-remote";

const installationId = Schema.decodeUnknownSync(InstallationId);
const commandCenterInstallationId = installationId("cc-installation");

const options: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  appVersion: "0.1.0",
};

const host: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["herdr", "hermes", "browser"],
};

type Ssh = Parameters<typeof deployConfiguredRemoteHost>[0];
const unusedSsh = {} as Ssh;

const target = {
  host: host as RemoteHost & {
    readonly kind: "remote";
    readonly sshEndpoint: string;
  },
  endpoint: "studio-box",
  platform: { platform: "linux", kernelName: "Linux" },
  progress: ["target admitted"],
} as const;

const successfulConfiguration = {
  ok: true,
  detail: "configured through Station API",
  stationInstallationId: installationId("station-installation"),
  configuredAt: "2026-07-27T12:00:02.000Z",
  station: {
    role: "remote" as const,
    hostId: "studio",
    agentHostId: "fleet-studio",
    supervisedPreferred: true,
  },
};

const operations = (
  overrides: Partial<ConfiguredRemoteDeployOperations> = {},
): ConfiguredRemoteDeployOperations => ({
  prepare: () => Effect.succeed({ ok: true, target } as never),
  deployPrepared: () =>
    Effect.succeed({
      ok: true,
      detail: "userland runtime ready",
      stages: ["target admitted", "deployed"],
      disposition: "ready" as const,
      version: "1.2.3",
    }),
  configure: () => Effect.succeed(successfulConfiguration as never),
  activateRuntime: () =>
    Effect.succeed({
      ok: true,
      detail: "runtime already admitted by package deploy",
    }),
  ...overrides,
});

describe("configured remote deploy (userland)", () => {
  it("configures after a ready userland deploy without administrator credentials", async () => {
    const ops = operations();
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(unusedSsh, host, options, ops),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("configured");
  });

  it("stops before configure when deploy is not ready", async () => {
    const configure = vi.fn(() => Effect.succeed(successfulConfiguration as never));
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          deployPrepared: () =>
            Effect.succeed({
              ok: false,
              detail: "signed userland runtime archive is invalid",
              stages: ["target admitted"],
              disposition: "not-started" as const,
              code: "validation" as const,
            }),
          configure,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });

  it("does not admit or package-mutate when prepare refuses the target", async () => {
    let admitted = false;
    let packageMutated = false;
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        {
          ...options,
          onAdmitted: () =>
            Effect.sync(() => {
              admitted = true;
            }),
        },
        operations({
          prepare: () =>
            Effect.succeed({
              ok: false,
              result: {
                ok: false,
                detail: "Linux Remote managed deployment is not available",
                code: "validation",
                stages: ["uname"],
                disposition: "not-started",
              },
            } as never),
          deployPrepared: () =>
            Effect.sync(() => {
              packageMutated = true;
              return {
                ok: true,
                detail: "should not run",
                stages: [],
                disposition: "ready" as const,
                version: "1.0.0",
              };
            }),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(admitted).toBe(false);
    expect(packageMutated).toBe(false);
  });

  it("enrollment package admits configure then supervised runtime activate", async () => {
    const activate = vi.fn(() =>
      Effect.succeed({
        ok: true,
        detail: "supervised Remote runtime ready; term + browser control sockets",
      }),
    );
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          deployPrepared: () =>
            Effect.succeed({
              ok: true,
              detail: "app installed; enrollment-only station control ready",
              stages: ["target admitted", "enrollment"],
              disposition: "configuration-required" as const,
              version: "1.2.3",
            }),
          activateRuntime: activate,
        }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.role).toBe("remote");
    expect(result.disposition).toBe("ready");
    expect(result.detail).toContain("supervised Remote runtime ready");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("fails closed when enrollment configure succeeds but runtime activate fails", async () => {
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          deployPrepared: () =>
            Effect.succeed({
              ok: true,
              detail: "enrollment-only station control ready",
              stages: ["enrollment"],
              disposition: "configuration-required" as const,
              version: "1.2.3",
            }),
          activateRuntime: () =>
            Effect.succeed({
              ok: false,
              detail: "runtime activate did not prove term + browser sockets",
            }),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.packageState).toBe("present");
    expect(result.role).toBe("remote");
    expect(result.configuration.ok).toBe(true);
    expect(result.detail).toContain("runtime activate failed");
  });

  it("skips configure on an already-configured Remote and activates", async () => {
    const configure = vi.fn(() =>
      Effect.succeed(successfulConfiguration as never),
    );
    const activate = vi.fn(() =>
      Effect.succeed({
        ok: true,
        detail: "supervised Remote runtime ready; replace-package stays Remote",
      }),
    );
    const prior = installationId("station-installation");
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        { ...options, stationInstallationId: prior },
        operations({ configure, activateRuntime: activate }),
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.role).toBe("remote");
    expect(result.disposition).toBe("ready");
    expect(result.stationInstallationId).toBe(prior);
    expect(result.configuration.ok).toBe(true);
    expect(result.configuration.detail).toContain("configure skipped");
    expect(result.detail).toContain("configure skipped");
    expect(configure).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("does not bootstrap when an already-configured activate fails", async () => {
    const configure = vi.fn(() =>
      Effect.succeed(successfulConfiguration as never),
    );
    const prior = installationId("station-installation");
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        { ...options, stationInstallationId: prior },
        operations({
          configure,
          activateRuntime: () =>
            Effect.succeed({
              ok: false,
              detail: "runtime activate did not prove term + browser sockets",
            }),
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.role).toBe("remote");
    expect(result.stationInstallationId).toBe(prior);
    expect(result.configuration.ok).toBe(true);
    expect(configure).not.toHaveBeenCalled();
  });

  it("does not activate when package never reaches enrollment readiness", async () => {
    const activate = vi.fn(() =>
      Effect.succeed({ ok: true, detail: "should not run" }),
    );
    const configure = vi.fn(() =>
      Effect.succeed(successfulConfiguration as never),
    );
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          deployPrepared: () =>
            Effect.succeed({
              ok: false,
              detail: "enrollment socket timeout",
              stages: ["target admitted"],
              disposition: "indeterminate" as const,
            }),
          configure,
          activateRuntime: activate,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });
});
