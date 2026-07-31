import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteDeployScript,
  darwinLiveWorkRefusalResult,
  makeDarwinRemoteDeploymentProvider,
  type DarwinDeployArtifactAdmission,
  type DarwinRemoteLiveWorkAuthority,
  validateReleaseZipArtifactInput,
} from "../src/main/vellum/hosts/deploy-darwin";
import type { RemoteDeploymentProviderInput } from "../src/main/vellum/hosts/remote-deployment";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshExitError, SshTimeoutError } from "../src/main/vellum/ssh/domain";
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "../src/shared/remote-update-status";

const TEST_CDHASH = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);

const endpoint = Effect.runSync(parseSshEndpoint("remote-a"));

const admittedArtifact = (): DarwinDeployArtifactAdmission => ({
  kind: "live-app",
  localApp: {
    appPath: "/Applications/Vellum Command.app",
    bundleIdentifier: "skastr0.vellumcommand",
    bundleExecutable: "Vellum Command",
    version: "0.1.6",
    teamIdentifier: "EXAMP12345",
    signingAuthority: "Developer ID Application: Example Maintainer (EXAMP12345)",
    cdHash: TEST_CDHASH,
  },
  dispose: async () => undefined,
});

const deploymentInput = (
  run: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>,
): RemoteDeploymentProviderInput => ({
  target: {
    host: {
      id: "remote-a",
      label: "Mac Mini",
      kind: "remote",
      sshEndpoint: "remote-a",
      capabilities: ["terminal", "browser"],
    },
    endpoint,
    sshTarget: { endpoint, identity: undefined } as never,
    platform: { platform: "darwin", kernelName: "Darwin" },
    progress: ["endpoint ok", "ssh warm ok", "remote uname Darwin"],
  },
  ssh: { run } as never,
  stationConfiguration: { state: "applied", remoteHostId: "remote-a" },
  artifactSource: "stable-feed",
});

const providerWith = (
  liveWorkAuthority: DarwinRemoteLiveWorkAuthority,
) => {
  const streamArtifact = vi.fn((..._args: readonly unknown[]) =>
    Effect.succeed({ ok: true, detail: "first generation ready" }),
  );
  return {
    streamArtifact,
    provider: makeDarwinRemoteDeploymentProvider({
      artifactAuthority: { resolve: async () => admittedArtifact() },
      liveWorkAuthority,
      streamArtifact,
      localPlatform: "darwin",
    }),
  };
};

describe("validateReleaseZipArtifactInput", () => {
  it("admits a canonical absolute zip path + sha256", () => {
    expect(
      validateReleaseZipArtifactInput({
        zipPath: "/tmp/release/Vellum Command-0.1.0-arm64-mac.zip",
        sha256: SHA,
        version: "0.1.0",
      }),
    ).toEqual({
      zipPath: "/tmp/release/Vellum Command-0.1.0-arm64-mac.zip",
      sha256: SHA,
      version: "0.1.0",
    });
  });

  it.each([
    ["relative path", { zipPath: "rel.zip", sha256: SHA }],
    ["not zip", { zipPath: "/tmp/app.dmg", sha256: SHA }],
    ["bad digest", { zipPath: "/tmp/a.zip", sha256: "nope" }],
    ["empty version pin", { zipPath: "/tmp/a.zip", sha256: SHA, version: "  " }],
  ])("refuses %s", (_label, input) => {
    expect(() => validateReleaseZipArtifactInput(input)).toThrow();
  });

  it("normalizes sha256 to lowercase", () => {
    const upper = "B".repeat(64);
    expect(
      validateReleaseZipArtifactInput({
        zipPath: "/tmp/a.zip",
        sha256: upper,
      }).sha256,
    ).toBe(upper.toLowerCase());
  });
});

describe("buildRemoteDeployScript release-zip transfer", () => {
  it("emits app-tar without archive digest vars", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "app-tar",
      expectedPackageState: "present",
    });
    expect(script).toContain("ARTIFACT_KIND=app-tar");
    expect(script).toContain("EXPECTED_PACKAGE_STATE='present'");
    expect(script).not.toContain("EXPECTED_ARCHIVE_SHA256=");
    expect(script).toContain('"$TAR" -C "$IN/$BUNDLE" -xf -');
  });

  it("binds a first-install decision to the serialized remote transaction", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "app-tar",
      expectedPackageState: "absent",
    });
    expect(script).toContain("EXPECTED_PACKAGE_STATE='absent'");
    expect(script).toContain("PACKAGE_STATE_CHANGED_BEFORE_DEPLOY");
    expect(
      script.indexOf('if [ "$EXPECTED_PACKAGE_STATE" = "absent" ]'),
    ).toBeGreaterThan(script.indexOf("LOCK_HELD=1"));
  });

  it("emits release-zip extract path with expected archive digest", () => {
    const script = buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
      kind: "release-zip",
      expectedArchiveSha256: SHA,
      expectedPackageState: "present",
    });
    expect(script).toContain("ARTIFACT_KIND=release-zip");
    expect(script).toContain(`EXPECTED_ARCHIVE_SHA256='${SHA}'`);
    expect(script).toContain('"$DITTO" -x -k "$ARCHIVE" "$IN"');
    expect(script).toContain("INCOMING_ARCHIVE_DIGEST_MISMATCH");
    expect(script).toContain(`EXPECTED_CDHASH='${TEST_CDHASH}'`);
  });

  it("refuses malformed archive sha256", () => {
    expect(() =>
      buildRemoteDeployScript("/Users/op", TEST_CDHASH, {
        kind: "release-zip",
        expectedArchiveSha256: "zz",
        expectedPackageState: "present",
      }),
    ).toThrow(/sha256/i);
  });
});

describe("darwinLiveWorkRefusalResult", () => {
  it("defers with product copy when terminal sessions are active", () => {
    const result = darwinLiveWorkRefusalResult({
      hostLabel: "studio",
      stages: ["probed"],
      version: "0.1.0",
      refusal: {
        acquired: false,
        reason: "active-terminal-sessions",
        evidence: {
          activeTerminalSessions: 2,
          observationId: "obs-1",
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("not-started");
    expect(result.code).toBe("conflict");
    expect(result.detail).toContain(REMOTE_UPDATE_IDLE_PRODUCT_COPY);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-vellum-terminals",
      activeTerminalSessions: 2,
    });
  });

  it("does not claim force-close for maintenance-held", () => {
    const result = darwinLiveWorkRefusalResult({
      hostLabel: "studio",
      stages: [],
      refusal: {
        acquired: false,
        reason: "maintenance-held",
        evidence: {
          activeTerminalSessions: 0,
          observationId: "obs-2",
        },
      },
    });
    expect(result.recoveryAction).toEqual({
      kind: "restore-terminal-live-work-observation",
    });
    expect(result.detail).toContain("terminal route cut");
  });
});

describe("Darwin deployment first-install boundary", () => {
  it("admits exact package absence without touching terminal-route maintenance", async () => {
    const acquire = vi.fn(() =>
      Effect.dieMessage("first install must not acquire terminal maintenance"),
    );
    const { provider, streamArtifact } = providerWith({ acquire });
    const run = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({ stdout: "/Users/operator\n", stderr: "" }),
      )
      .mockReturnValueOnce(
        Effect.fail(
          new SshExitError({
            endpoint: String(endpoint),
            operation: "probe installed package",
            code: 1,
          }),
        ),
      );

    const result = await Effect.runPromise(
      provider.deploy(deploymentInput(run)),
    );

    expect(result.ok).toBe(true);
    expect(result.stages).toContain("remote package absent; first install admitted");
    expect(acquire).not.toHaveBeenCalled();
    expect(streamArtifact).toHaveBeenCalledOnce();
    expect(streamArtifact.mock.calls[0]?.[2]).toMatchObject({
      expectedPackageState: "absent",
    });
  });

  it("requires terminal maintenance for an existing installation", async () => {
    const acquire = vi.fn(() =>
      Effect.succeed({
        acquired: false as const,
        reason: "active-terminal-sessions" as const,
        evidence: { activeTerminalSessions: 2, observationId: "obs-existing" },
      }),
    );
    const { provider, streamArtifact } = providerWith({ acquire });
    const run = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({ stdout: "/Users/operator\n", stderr: "" }),
      )
      .mockReturnValueOnce(Effect.succeed({ stdout: "", stderr: "" }));

    const result = await Effect.runPromise(
      provider.deploy(deploymentInput(run)),
    );

    expect(result.ok).toBe(false);
    expect(result.recoveryAction).toEqual({
      kind: "close-active-vellum-terminals",
      activeTerminalSessions: 2,
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(streamArtifact).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-not-found exit",
      new SshExitError({
        endpoint: String(endpoint),
        operation: "probe installed package",
        code: 255,
      }),
    ],
    [
      "a timeout",
      new SshTimeoutError({
        endpoint: String(endpoint),
        operation: "probe installed package",
        timeoutMs: 5_000,
      }),
    ],
  ])("fails before mutation when the package probe reports %s", async (_label, error) => {
    const acquire = vi.fn(() =>
      Effect.dieMessage("ambiguous probe must not acquire maintenance"),
    );
    const { provider, streamArtifact } = providerWith({ acquire });
    const run = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({ stdout: "/Users/operator\n", stderr: "" }),
      )
      .mockReturnValueOnce(Effect.fail(error));

    const result = await Effect.runPromise(
      provider.deploy(deploymentInput(run)),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "io",
      disposition: "not-started",
    });
    expect(result.detail).toContain(
      "could not determine whether Vellum Command is installed",
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(streamArtifact).not.toHaveBeenCalled();
  });
});

describe("hash fixture for release zip shape", () => {
  it("hashes a temp file to 64 hex for authority tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "vellum-darwin-zip-"));
    try {
      const path = join(dir, "payload.zip");
      writeFileSync(path, "zip-bytes");
      const digest = createHash("sha256").update("zip-bytes").digest("hex");
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(path.endsWith(".zip")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
