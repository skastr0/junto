import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { RemoteHostsError } from "../src/shared/remote-hosts";
import type { ConfigureRemoteOptions } from "../src/main/vellum/hosts/configure-remote";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployOperations,
} from "../src/main/vellum/hosts/deploy-configured-remote";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import {
  mintLinuxFirstInstallActivationContinuation,
} from "../src/main/vellum/hosts/linux-administrator-credential";
import {
  attachLinuxFirstInstallActivationContinuation,
} from "../src/main/vellum/hosts/remote-deployment";

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
  platform: { platform: "darwin", kernelName: "Darwin" },
  progress: ["target admitted"],
} as const;

const activationContinuation = () =>
  mintLinuxFirstInstallActivationContinuation({
    hostId: host.id,
    endpoint: Effect.runSync(parseSshEndpoint("studio-box")),
    version: "0.1.2",
    manifestSha256: "a".repeat(64),
    debSha256: "b".repeat(64),
    inventorySha256: "c".repeat(64),
  });

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
        expect(received.commandCenterInstallationId).toEqual(
          commandCenterInstallationId,
        );
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

  it("does not configure when package mutation never started", async () => {
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
              disposition: "not-started",
            }),
          configure,
        }),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "previous",
      role: "previous",
    });
    expect(configure).not.toHaveBeenCalled();
  });

  it("configures via enrollment bootstrap then retries activation when package is present without ready", async () => {
    const sequence: string[] = [];
    let packageCalls = 0;
    const deployPrepared = vi.fn(
      (_ssh, _target, _stationConfiguration, authorization, artifactSource) =>
        Effect.sync(() => {
          expect(artifactSource).toBe("verified-cache");
          packageCalls += 1;
          sequence.push(`package-${packageCalls}`);
          if (packageCalls === 1) {
            return attachLinuxFirstInstallActivationContinuation({
              ok: false,
              detail: "Station configuration is required next",
              code: "conflict" as const,
              stages: ["opaque operator progress that carries no control state"],
              disposition: "configuration-required" as const,
              version: "0.1.2",
            }, activationContinuation());
          }
          expect(authorization?.kind).toBe("linux-first-install-activation");
          return {
            ok: true,
            detail: "package ready after configuration",
            stages: ["systemd generation ready"],
            disposition: "ready" as const,
            version: "0.1.2",
          };
        }),
    );
    const configure = vi.fn(() =>
      Effect.sync(() => {
        sequence.push("configure");
        return successfulConfiguration;
      }),
    );
    const prepare = vi.fn(() =>
      Effect.sync(() => {
        sequence.push("prepare");
        return { ok: true as const, target } as never;
      }),
    );

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        unusedSsh,
        host,
        { ...options, artifactSource: "verified-cache" },
        operations({ prepare, deployPrepared, configure }),
      ),
    );

    expect(sequence).toEqual([
      "prepare",
      "package-1",
      "configure",
      "prepare",
      "package-2",
    ]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      stationInstallationId:
        successfulConfiguration.stationInstallationId,
    });
    expect(result.stages?.some((s) => /enrollment bootstrap/u.test(s))).toBe(
      true,
    );
  });

  it("never infers the enrollment continuation from human-readable progress", async () => {
    const configure = vi.fn(() =>
      Effect.die("configure must not run"),
    );
    const deployPrepared = vi.fn(() =>
      Effect.succeed({
        ok: false,
        detail: "package state could not be proven",
        code: "conflict" as const,
        stages: [
          "signed artifact admitted version=0.1.2",
          "first-install package 0.1.2 installed; custody present",
          "starting sealed adopt for 0.1.2",
          "root-owned transaction legacy committed",
        ],
        disposition: "indeterminate" as const,
        version: "0.1.2",
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

    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "previous",
    });
    expect(configure).not.toHaveBeenCalled();
    expect(deployPrepared).toHaveBeenCalledTimes(1);
  });

  it("never configures or retries an unsealed configuration-required result", async () => {
    const configure = vi.fn(() =>
      Effect.die("configure must not run"),
    );
    const deployPrepared = vi.fn(() =>
      Effect.succeed({
        ok: false,
        detail: "Station configuration is required next",
        code: "conflict" as const,
        stages: ["operator-readable but untrusted"],
        disposition: "configuration-required" as const,
        version: "0.1.2",
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

    expect(result).toMatchObject({
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "previous",
    });
    expect(result.stages).toContain(
      "first-install activation continuation was not retained",
    );
    expect(configure).not.toHaveBeenCalled();
    expect(deployPrepared).toHaveBeenCalledTimes(1);
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
