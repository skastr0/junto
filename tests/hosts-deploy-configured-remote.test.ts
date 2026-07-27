import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import type { StationBrowserPinnedTrustRecord } from "../src/shared/station-browser";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { RemoteHostsError } from "../src/shared/remote-hosts";
import type { ConfigureRemoteOptions } from "../src/main/vellum/hosts/configure-remote";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployOperations,
} from "../src/main/vellum/hosts/deploy-configured-remote";

const installationId = Schema.decodeUnknownSync(InstallationId);
const commandCenterInstallationId = installationId("cc-installation");

const browserTrust: StationBrowserPinnedTrustRecord = {
  version: 1,
  generation: 1,
  keyId: "ed25519-command-center",
  originInstallationId: commandCenterInstallationId,
  status: "active",
  publicKeySpki: Buffer.from(
    "bounded-public-key-material",
    "utf8",
  ).toString("base64"),
  replacesKeyId: null,
  updatedAt: 1_774_780_400_000,
};

const options: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  commandCenterRef: "local",
  appVersion: "0.1.0",
  browserTrust,
};

const host: RemoteHost = {
  id: "studio",
  hermesId: "fleet-studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio-box",
  capabilities: ["herdr", "hermes", "browser"],
};

type Ssh = Parameters<typeof deployConfiguredRemoteHost>[0];
const unusedSsh = {} as Ssh;

const target = {
  host: host as RemoteHost & {
    readonly kind: "remote";
    readonly endpoint: string;
  },
  endpoint: "studio-box",
  platform: { platform: "darwin", kernelName: "Darwin" },
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
    commandCenterRef: "local",
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
      detail: "package ready",
      stages: ["target admitted", "package installed"],
      disposition: "ready",
      version: "0.1.0",
    }),
  configure: () => Effect.succeed(successfulConfiguration),
  ...overrides,
});

describe("configured Remote deploy", () => {
  it("contains no remote settings, seal, snapshot, or trust side lane", () => {
    const source = readFileSync(
      new URL(
        "../src/main/vellum/hosts/deploy-configured-remote.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(
      /settings\.json|topology\.(?:key|seal)|captureRemote|restoreRemote|provisionBrowserTrust/u,
    );
  });

  it("installs the package before the one Station API configuration", async () => {
    const sequence: string[] = [];
    const deployPrepared = vi.fn((_ssh, _target, stationConfiguration) =>
      Effect.sync(() => {
        sequence.push("package");
        expect(stationConfiguration).toEqual({
          state: "applied",
          remoteHostId: "studio",
          commandCenterRef: "local",
        });
        return {
          ok: true,
          detail: "package ready",
          stages: ["ready"],
          disposition: "ready" as const,
          version: "0.1.0",
        };
      }),
    );
    const configure = vi.fn((_ssh, _host, received) =>
      Effect.sync(() => {
        sequence.push("configure");
        expect(received.browserTrust).toEqual(browserTrust);
        return successfulConfiguration;
      }),
    );

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({ deployPrepared, configure }),
      ),
    );

    expect(sequence).toEqual(["package", "configure"]);
    expect(result).toMatchObject({
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      station: successfulConfiguration.station,
      stationInstallationId:
        successfulConfiguration.stationInstallationId,
    });
  });

  it("stops before package and configuration when target admission fails", async () => {
    const deployPrepared = vi.fn(() =>
      Effect.die("package must not run"),
    );
    const configure = vi.fn(() =>
      Effect.die("configure must not run"),
    );
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          prepare: () =>
            Effect.succeed({
              ok: false,
              result: {
                ok: false,
                detail: "unsupported target",
                code: "validation",
                stages: ["target refused"],
                disposition: "not-started",
              },
            }),
          deployPrepared,
          configure,
        }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "previous",
      role: "previous",
      disposition: "not-started",
    });
    expect(deployPrepared).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it("does not configure when package readiness is not proven", async () => {
    const configure = vi.fn(() =>
      Effect.die("configure must not run"),
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
              detail: "package readiness is indeterminate",
              code: "io",
              stages: ["activation began", "readiness failed"],
              disposition: "indeterminate",
            }),
          configure,
        }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "previous",
    });
    expect(configure).not.toHaveBeenCalled();
  });

  it("keeps a ready package and reports indeterminate when API configuration fails", async () => {
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        options,
        operations({
          configure: () =>
            Effect.fail(
              new RemoteHostsError(
                "io",
                "Station control socket unavailable",
              ),
            ),
        }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "io",
      disposition: "indeterminate",
      outcome: "indeterminate",
      packageState: "present",
      role: "unknown",
      configuration: {
        ok: false,
        detail: "Station control socket unavailable",
      },
    });
  });

  it("rejects non-remote targets before running operations", async () => {
    const prepare = vi.fn(() => Effect.die("prepare must not run"));
    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        {
          id: "local",
          label: "Local",
          kind: "local",
          capabilities: ["terminal"],
        },
        options,
        operations({ prepare }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      outcome: "failed",
      packageState: "previous",
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
