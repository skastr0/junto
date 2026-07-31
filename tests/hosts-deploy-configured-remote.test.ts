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
});
