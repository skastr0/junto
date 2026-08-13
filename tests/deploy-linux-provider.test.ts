import { createHash } from "node:crypto";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { classifyHostRuntimeBlocker } from "../src/shared/host-runtime";
import {
  activateLinuxRemoteRuntimeForTarget,
  buildLinuxRemoteDeployCommand,
  buildLinuxRemotePreflightScript,
  decodeLinuxRemotePreflight,
  decodeLinuxRemoteRestart,
  makeLinuxRemoteDeploymentProvider,
  type LinuxRemoteArtifactAdmission,
  type LinuxRemoteArtifactCandidate,
  type LinuxRemoteLiveWorkAuthority,
} from "../src/main/vellum/hosts/deploy-linux";
import type {
  RemoteDeploymentProviderInput,
} from "../src/main/vellum/hosts/remote-deployment";
import {
  parseSshEndpoint,
  SshTimeoutError,
  type SshEndpoint,
} from "../src/main/vellum/ssh/domain";
import type { SshLease } from "../src/main/vellum/ssh/service";
import {
  compileLinuxUserlandDeploySource,
  compileLinuxUserlandPreflightSource,
} from "../src/main/vellum/ssh/remote-plan";

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const endpoint = Effect.runSync(parseSshEndpoint("studio-box"));
const archive = Buffer.from("signed-userland-runtime-archive");
const archiveSha256 = sha256(archive);

const makeAdmission = (): LinuxRemoteArtifactAdmission =>
  Object.freeze({
    version: "1.2.3",
    bytes: archive.byteLength,
    sha256: archiveSha256,
    open: async () =>
      (async function* () {
        yield Uint8Array.from(archive);
      })(),
  });

const makeCandidate = (): LinuxRemoteArtifactCandidate => {
  const admitted = makeAdmission();
  return Object.freeze({
    version: admitted.version,
    bytes: admitted.bytes,
    sha256: admitted.sha256,
    authorize: vi.fn(() => admitted),
  });
};

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: String(endpoint),
  capabilities: ["terminal", "browser"],
};

const preflightOk = "LINUX_USERLAND_PREFLIGHT_V1 ok=1 uid=1000 free=999999999\n";
const deployReady = (release: string) =>
  `LINUX_USERLAND_DEPLOY_V1 ok=1 state=ready release=${release}\n`;

const makeSsh = (input: {
  readonly preflightStdout?: string;
  readonly deployStdout?: string;
} = {}) => {
  const writes: Buffer[] = [];
  return {
    writes,
    ssh: {
      run: () =>
        Effect.succeed({
          stdout: input.preflightStdout ?? preflightOk,
          stderr: "",
          exitCode: 0,
        }),
      transact: (
        _program: unknown,
        body: (lease: SshLease) => Effect.Effect<string, Error>,
      ) =>
        Effect.gen(function* () {
          const chunks: Buffer[] = [];
          const lease = {
            write: (chunk: Buffer) => {
              chunks.push(Buffer.from(chunk));
              writes.push(Buffer.from(chunk));
              return Effect.void;
            },
            closeInput: Effect.void,
            stdout: Stream.fromIterable([
              Buffer.from(
                input.deployStdout ??
                  deployReady(`1.2.3-${archiveSha256}`),
              ),
            ]),
            stderr: Stream.empty,
            exitCode: Effect.succeed(0),
          } as unknown as SshLease;
          return yield* body(lease);
        }),
    },
  };
};

const providerInput = (
  ssh: ReturnType<typeof makeSsh>["ssh"],
): RemoteDeploymentProviderInput => ({
  target: {
    host: host as RemoteHost & {
      readonly kind: "remote";
      readonly sshEndpoint: string;
    },
    endpoint: endpoint as SshEndpoint,
    sshTarget: {
      endpoint,
      identity: undefined,
    } as never,
    platform: { platform: "linux", kernelName: "Linux" },
    progress: ["target admitted"],
  },
  ssh: ssh as never,
  stationConfiguration: {
    state: "applied",
    remoteHostId: host.id,
  },
  artifactSource: "stable-feed",
});

describe("Linux userland remote deployment provider", () => {
  it("declares browser intentionally unavailable for displayless Remote beta", () => {
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: {
        resolve: async () => makeCandidate(),
      },
      liveWorkAuthority: {
        acquire: () =>
          Effect.succeed({
            acquired: true,
            evidence: { activeTerminalSessions: 0, observationId: "test" },
            release: Effect.void,
          }),
      },
    });
    expect(provider.supportsBrowser).toBe(false);
    expect(provider.platform).toBe("linux");
  });

  it("exposes only userland preflight/deploy surface labels", () => {
    expect(buildLinuxRemotePreflightScript()).toBe("userland runtime preflight");
    expect(buildLinuxRemoteDeployCommand()).toEqual({
      executable: "/bin/sh",
      args: [],
    });
    expect(compileLinuxUserlandPreflightSource()).toContain(
      "LINUX_USERLAND_PREFLIGHT_V1",
    );
    expect(compileLinuxUserlandDeploySource()).toContain(
      "LINUX_USERLAND_DEPLOY_V1",
    );
    expect(compileLinuxUserlandDeploySource()).not.toMatch(
      /dpkg|apt-get|sudo|\/opt\/|vellum-release-bridge|vellum-release-installer|admin-password/u,
    );
    expect(compileLinuxUserlandPreflightSource()).not.toMatch(
      /dpkg|apt-get|sudo|\/opt\/|vellum-release-bridge|vellum-release-installer/u,
    );
  });

  it("decodes owner-home preflight evidence and rejects privileged residue", () => {
    expect(decodeLinuxRemotePreflight(preflightOk)).toEqual({
      ok: true,
      uid: 1000,
      availableBytes: 999999999,
    });
    expect(
      decodeLinuxRemotePreflight(
        "LINUX_RELEASE_PREFLIGHT_V1 helper=1 bridge=1 passwordless_sudo=1\n",
      ),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      decodeLinuxRemotePreflight(
        "LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=disk\n",
      ),
    ).toEqual({ ok: false, reason: "disk" });
    expect(
      decodeLinuxRemotePreflight(
        "LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=systemd-user\n",
      ),
    ).toEqual({ ok: false, reason: "systemd-user" });
    expect(decodeLinuxRemoteRestart("LINUX_USERLAND_RESTART_V1 ok=1\n")).toEqual(
      { ok: true },
    );
    expect(
      decodeLinuxRemoteRestart("LINUX_USERLAND_RESTART_V1 ok=0 reason=restart\n"),
    ).toEqual({ ok: false, reason: "restart" });
  });

  it("deploys a signed userland archive without elevation or package manager", async () => {
    const { ssh, writes } = makeSsh();
    const candidate = makeCandidate();
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: { resolve: async () => candidate },
      liveWorkAuthority: {
        acquire: () =>
          Effect.succeed({
            acquired: true,
            evidence: {
              activeTerminalSessions: 0,
              observationId: "test",
            },
            release: Effect.void,
          }),
      } satisfies LinuxRemoteLiveWorkAuthority,
    });

    const result = await Effect.runPromise(
      provider.deploy(providerInput(ssh)),
    );

    expect(result.ok).toBe(true);
    expect(result.disposition).toBe("ready");
    expect(result.version).toBe("1.2.3");
    expect(result.detail).toContain("userland runtime ready");
    expect(candidate.authorize).toHaveBeenCalledOnce();
    const transcript = Buffer.concat(writes).toString("utf8");
    expect(transcript.startsWith(
      `LINUX_USERLAND_DEPLOY_V1 version=1.2.3 sha256=${archiveSha256} bytes=${archive.byteLength}\n`,
    )).toBe(true);
    expect(transcript).toContain("signed-userland-runtime-archive");
    expect(transcript).not.toMatch(
      /dpkg|apt-get|sudo|admin-password|vellum-release-bridge/u,
    );
  });

  it("deploys a first install without claiming station applied", async () => {
    const { ssh } = makeSsh();
    const candidate = makeCandidate();
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: { resolve: async () => candidate },
      liveWorkAuthority: {
        acquire: () =>
          Effect.succeed({
            acquired: true,
            evidence: {
              activeTerminalSessions: 0,
              observationId: "test",
            },
            release: Effect.void,
          }),
      } satisfies LinuxRemoteLiveWorkAuthority,
    });
    const input = providerInput(ssh);
    const result = await Effect.runPromise(
      provider.deploy({
        ...input,
        stationConfiguration: { state: "managed-externally" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe("ready");
  });

  it("fails closed when preflight or deploy evidence is not userland-ready", async () => {
    const candidate = makeCandidate();
    const liveWorkAuthority: LinuxRemoteLiveWorkAuthority = {
      acquire: () =>
        Effect.succeed({
          acquired: true,
          evidence: {
            activeTerminalSessions: 0,
            observationId: "test",
          },
          release: Effect.void,
        }),
    };
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: { resolve: async () => candidate },
      liveWorkAuthority,
    });

    const preflightFail = makeSsh({
      preflightStdout: "LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=systemd-user\n",
    });
    const preflightResult = await Effect.runPromise(
      provider.deploy(providerInput(preflightFail.ssh)),
    );
    expect(preflightResult.ok).toBe(false);
    expect(preflightResult.code).toBe("validation");
    expect(preflightResult.detail).toContain(
      "owner-local systemd user service is unavailable",
    );
    expect(classifyHostRuntimeBlocker(preflightResult.detail)?.kind).toBe(
      "login-session",
    );
    expect(candidate.authorize).not.toHaveBeenCalled();

    const diskFail = makeSsh({
      preflightStdout: "LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=disk\n",
    });
    const diskResult = await Effect.runPromise(
      provider.deploy(providerInput(diskFail.ssh)),
    );
    expect(diskResult.ok).toBe(false);
    expect(diskResult.detail).toContain("no space left on device");
    expect(classifyHostRuntimeBlocker(diskResult.detail)?.kind).toBe("disk");

    const malformedFail = makeSsh({ preflightStdout: "not a preflight banner\n" });
    const malformedResult = await Effect.runPromise(
      provider.deploy(providerInput(malformedFail.ssh)),
    );
    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.detail).toContain(
      "userland runtime preflight failed",
    );
    expect(classifyHostRuntimeBlocker(malformedResult.detail)).toBeUndefined();

    const sshFail = {
      run: () =>
        Effect.fail(
          new SshTimeoutError({
            endpoint: "studio-box",
            operation: "preflight",
            timeoutMs: 1_000,
          }),
        ),
      transact: () => Effect.die("deploy must not run"),
    };
    const sshResult = await Effect.runPromise(
      provider.deploy(providerInput(sshFail as never)),
    );
    expect(sshResult.ok).toBe(false);
    expect(sshResult.detail).toContain("timed out");
    expect(classifyHostRuntimeBlocker(sshResult.detail)).toBeUndefined();

    const deployFail = makeSsh({
      deployStdout: "LINUX_USERLAND_DEPLOY_V1 ok=0 state=hash\n",
    });
    const deployResult = await Effect.runPromise(
      provider.deploy(providerInput(deployFail.ssh)),
    );
    expect(deployResult.ok).toBe(false);
    expect(deployResult.detail).toContain("candidate failed before activation");

    const missingBanner = makeSsh({ deployStdout: "" });
    const missingResult = await Effect.runPromise(
      provider.deploy(providerInput(missingBanner.ssh)),
    );
    expect(missingResult.ok).toBe(false);
    expect(missingResult.disposition).toBe("indeterminate");
    expect(missingResult.detail).toContain(
      "LINUX_USERLAND_DEPLOY_V1 ok=1",
    );
  });

  it("rejects invalid artifact authority without opening a remote transaction", async () => {
    const { ssh, writes } = makeSsh();
    const provider = makeLinuxRemoteDeploymentProvider({
      artifactAuthority: {
        resolve: async () => {
          throw new Error("missing archive");
        },
      },
      liveWorkAuthority: {
        acquire: () =>
          Effect.succeed({
            acquired: true,
            evidence: {
              activeTerminalSessions: 0,
              observationId: "test",
            },
          }),
      },
    });
    const result = await Effect.runPromise(provider.deploy(providerInput(ssh)));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("validation");
    expect(result.detail).toContain("signed userland runtime archive is invalid");
    expect(writes).toEqual([]);
  });

  it("restarts the systemd user service as the HostRuntime restart act", async () => {
    const { ssh } = makeSsh({
      preflightStdout: "LINUX_USERLAND_RESTART_V1 ok=1\n",
    });
    const result = await Effect.runPromise(
      activateLinuxRemoteRuntimeForTarget(ssh as never, providerInput(ssh).target),
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("systemd user service restarted");
  });

  it("does not label a failed systemd restart as a missing login session", async () => {
    const { ssh } = makeSsh({
      preflightStdout: "LINUX_USERLAND_RESTART_V1 ok=0 reason=restart\n",
    });
    const result = await Effect.runPromise(
      activateLinuxRemoteRuntimeForTarget(ssh as never, providerInput(ssh).target),
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("systemd user service restart failed");
    expect(classifyHostRuntimeBlocker(result.detail)).toBeUndefined();
  });
});
