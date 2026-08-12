import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { InstallationId } from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  decodeRemotePlatformEvidence,
  makeRemoteDeploymentDispatcher,
} from "../src/main/vellum/hosts/deploy-remote";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployOperations,
} from "../src/main/vellum/hosts/deploy-configured-remote";
import type {
  RemoteDeploymentProvider,
  RemoteDeploymentProviderInput,
} from "../src/main/vellum/hosts/remote-deployment";

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const commandCenterInstallationId =
  Schema.decodeUnknownSync(InstallationId)("cc-installation");
const configuredDeployOptions = {
  commandCenterInstallationId,
  appVersion: "0.1.0",
};

type Ssh = Parameters<
  ReturnType<typeof makeRemoteDeploymentDispatcher>["deploy"]
>[0];

const makeSsh = (stdout: string): Ssh =>
  ({
    warm: vi.fn(() => Effect.void),
    run: vi.fn(() => Effect.succeed({ stdout, stderr: "" })),
  }) as unknown as Ssh;

const makeProvider = (
  platform: "darwin" | "linux",
  supportsBrowser = true,
) => {
  const deploy = vi.fn((input: RemoteDeploymentProviderInput) =>
    Effect.succeed({
      ok: true,
      detail: `${platform} ready`,
      stages: input.target.progress,
      disposition: "ready" as const,
      version: "0.1.0",
    }),
  );
  return { platform, supportsBrowser, deploy } satisfies RemoteDeploymentProvider;
};

describe("Remote deployment platform evidence", () => {
  it("accepts exactly one Darwin or Linux uname record", () => {
    expect(decodeRemotePlatformEvidence("Darwin\n")).toEqual({
      ok: true,
      platform: { platform: "darwin", kernelName: "Darwin" },
    });
    expect(decodeRemotePlatformEvidence("Linux\n")).toEqual({
      ok: true,
      platform: { platform: "linux", kernelName: "Linux" },
    });
  });

  it.each([
    "Darwin",
    "Darwin\r\n",
    "Darwin\n\n",
    " Darwin\n",
    "Darwin \n",
    "\n",
    "Darwin;touch-owned\n",
  ])("rejects malformed evidence %j", (evidence) => {
    expect(decodeRemotePlatformEvidence(evidence)).toEqual({
      ok: false,
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "malformed",
      },
    });
  });

  it("preserves one bounded unknown kernel token as unsupported evidence", () => {
    expect(decodeRemotePlatformEvidence("FreeBSD\n")).toEqual({
      ok: false,
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "unsupported",
        reportedKernel: "FreeBSD",
      },
    });
  });
});

describe("Remote deployment dispatcher", () => {
  it("has one mandatory provider result contract without a compatibility projection", () => {
    const contract = readFileSync(
      new URL("../src/main/vellum/hosts/remote-deployment.ts", import.meta.url),
      "utf8",
    );
    const dispatcher = readFileSync(
      new URL("../src/main/vellum/hosts/deploy-remote.ts", import.meta.url),
      "utf8",
    );
    const linuxProvider = readFileSync(
      new URL("../src/main/vellum/hosts/deploy-linux.ts", import.meta.url),
      "utf8",
    );

    expect(contract).toContain(
      "readonly disposition: RemoteDeploymentDisposition;",
    );
    expect(contract).not.toContain("RemoteDeploymentProviderReceipt");
    expect(contract).not.toContain("readonly disposition?:");
    expect(dispatcher).not.toContain("receipt.result");
    expect(linuxProvider).not.toContain("makeProviderReceipt");
  });

  it("contains no platform installer policy", () => {
    const source = readFileSync(
      new URL("../src/main/vellum/hosts/deploy-remote.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /\/Applications|LaunchAgent|launchctl|\.app\b|\.plist\b|\bdpkg\b|\bsystemd\b|\bsudo\b|\bAppArmor\b|\bXvfb\b/u,
    );
  });

  it("selects exactly the provider named by admitted platform evidence", async () => {
    const darwin = makeProvider("darwin");
    const linux = makeProvider("linux");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin, linux],
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Darwin\n"), host, {
        state: "managed-externally",
      }),
    );

    expect(result).toEqual({
      ok: true,
      detail: "darwin ready",
      stages: ["endpoint ok", "ssh warm ok", "remote uname Darwin"],
      disposition: "ready",
      version: "0.1.0",
    });
    expect(darwin.deploy).toHaveBeenCalledOnce();
    expect(linux.deploy).not.toHaveBeenCalled();
    expect(darwin.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          platform: { platform: "darwin", kernelName: "Darwin" },
          progress: ["endpoint ok", "ssh warm ok", "remote uname Darwin"],
        }),
      }),
    );
  });

  it("never threads administrator credentials into the Darwin provider", async () => {
    const darwin = makeProvider("darwin");
    const linux = makeProvider("linux");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin, linux],
    });

    await Effect.runPromise(
      dispatcher.deploy(
        makeSsh("Darwin\n"),
        host,
        { state: "managed-externally" },
      ),
    );

    expect(linux.deploy).not.toHaveBeenCalled();
    expect(darwin.deploy).toHaveBeenCalledWith(
      expect.not.objectContaining({ authorization: expect.anything() }),
    );
    expect(JSON.stringify(linux.deploy.mock.calls)).not.toContain(
      "linux-administrator-password",
    );
  });

  it("refuses Linux artifact sources while Linux deployment is outside the release surface", async () => {
    const linux = makeProvider("linux");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [linux],
    });

    for (const artifactSource of [
      undefined,
      "verified-cache" as const,
      "qualification-candidate" as const,
    ]) {
      const result = await Effect.runPromise(
        dispatcher.deploy(
          makeSsh("Linux\n"),
          host,
          { state: "managed-externally" },
          artifactSource,
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        code: "validation",
        disposition: "not-started",
        message: expect.stringContaining("Linux Remote managed deployment is not available"),
      });
    }
    expect(linux.deploy).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid or non-Linux release source", async () => {
    const darwin = makeProvider("darwin");
    const linux = makeProvider("linux");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin, linux],
    });

    const invalid = await Effect.runPromise(
      dispatcher.deploy(
        makeSsh("Linux\n"),
        host,
        { state: "managed-externally" },
        "caller-path" as never,
      ),
    );
    const wrongPlatform = await Effect.runPromise(
      dispatcher.deploy(
        makeSsh("Darwin\n"),
        host,
        { state: "managed-externally" },
        "verified-cache",
      ),
    );

    expect(invalid).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      message: expect.stringContaining(
        "Linux Remote managed deployment is not available in this release",
      ),
    });
    expect(wrongPlatform).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      message: "Linux release source requires a Linux target",
    });
    expect(linux.deploy).not.toHaveBeenCalled();
    expect(darwin.deploy).not.toHaveBeenCalled();
  });

  it("rejects a declared browser capability the selected provider cannot satisfy", async () => {
    const terminalOnly = makeProvider("darwin", false);
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [terminalOnly],
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(
        makeSsh("Darwin\n"),
        { ...host, capabilities: ["terminal", "browser"] },
        { state: "managed-externally" },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      message: "remote browser capability unsupported by deployment provider",
      stages: ["endpoint ok", "ssh warm ok", "remote uname Darwin"],
    });
    expect(terminalOnly.deploy).not.toHaveBeenCalled();
  });

  it("refuses a supported descriptor with no provider before provider mutation", async () => {
    const darwin = makeProvider("darwin");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin],
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Linux\n"), host, {
        state: "managed-externally",
      }),
    );

    expect(darwin.deploy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      stages: ["endpoint ok", "ssh warm ok", "remote uname Linux"],
      message: expect.stringContaining(
        "Linux Remote managed deployment is not available in this release",
      ),
    });
  });

  it.each(["FreeBSD\n", "Darwin\r\n"])(
    "refuses unknown or malformed evidence before any provider runs: %j",
    async (evidence) => {
      const darwin = makeProvider("darwin");
      const dispatcher = makeRemoteDeploymentDispatcher({
        commandCenterPlatform: "darwin",
        providers: [darwin],
      });

      const result = await Effect.runPromise(
        dispatcher.deploy(makeSsh(evidence), host, {
          state: "managed-externally",
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.disposition).toBe("not-started");
      expect(result.unsupportedTarget).toBeDefined();
      expect(darwin.deploy).not.toHaveBeenCalled();
    },
  );

  it("refuses a target object not minted by its own admission pass", async () => {
    const darwin = makeProvider("darwin");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin],
    });

    const result = await Effect.runPromise(
      dispatcher.dispatch(
        {
          host,
          endpoint: "studio-box",
          platform: { platform: "darwin", kernelName: "Darwin" },
          progress: [],
        } as never,
        makeSsh("Darwin\n"),
        { state: "managed-externally" },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
    });
    expect(result.detail).toMatch(/not admitted by this dispatcher/u);
    expect(darwin.deploy).not.toHaveBeenCalled();
  });

  it("consumes an admitted target after one provider execution", async () => {
    const darwin = makeProvider("darwin");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin],
    });
    const ssh = makeSsh("Darwin\n");
    const preparation = await Effect.runPromise(dispatcher.prepare(ssh, host));
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) throw new Error("expected admitted Darwin target");

    const first = await Effect.runPromise(
      dispatcher.dispatch(preparation.target, ssh, {
        state: "managed-externally",
      }),
    );
    const replay = await Effect.runPromise(
      dispatcher.dispatch(preparation.target, ssh, {
        state: "managed-externally",
      }),
    );

    expect(first.ok).toBe(true);
    expect(replay).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
    });
    expect(replay.detail).toMatch(/not admitted by this dispatcher/u);
    expect(darwin.deploy).toHaveBeenCalledOnce();
  });

  it("refuses a non-Darwin Command Center before touching SSH", async () => {
    const darwin = makeProvider("darwin");
    const ssh = makeSsh("Darwin\n");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "linux",
      providers: [darwin],
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(ssh, host, { state: "managed-externally" }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
    });
    expect(ssh.warm).not.toHaveBeenCalled();
    expect(ssh.run).not.toHaveBeenCalled();
    expect(darwin.deploy).not.toHaveBeenCalled();
  });

  it("gates configured deploy and Station API mutation on target admission", async () => {
    const darwin = makeProvider("darwin");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin],
    });
    const configure = vi.fn(() => Effect.die("configure must not run"));
    const deployPrepared = vi.fn(() =>
      Effect.die("prepared deploy must not run"),
    );
    const operations: ConfiguredRemoteDeployOperations = {
      prepare: dispatcher.prepare,
      deployPrepared,
      configure,
      activateRuntime: () =>
        Effect.succeed({
          ok: true,
          detail: "runtime already admitted by package deploy",
        }),
    };

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        makeSsh("Linux\n"),
        host,
        configuredDeployOptions,
        operations,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "previous",
      role: "previous",
      disposition: "not-started",
      message: expect.stringContaining(
        "Linux Remote managed deployment is not available in this release",
      ),
    });
    expect(configure).not.toHaveBeenCalled();
    expect(deployPrepared).not.toHaveBeenCalled();
    expect(darwin.deploy).not.toHaveBeenCalled();
  });
});
