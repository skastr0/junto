import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
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
  endpoint: "studio-box",
  capabilities: ["terminal"],
};

type Ssh = Parameters<
  ReturnType<typeof makeRemoteDeploymentDispatcher>["deploy"]
>[0];

const makeSsh = (stdout: string): Ssh =>
  ({
    warm: vi.fn(() => Effect.void),
    run: vi.fn(() => Effect.succeed({ stdout, stderr: "" })),
  }) as unknown as Ssh;

const makeProvider = (platform: "darwin" | "linux") => {
  const deploy = vi.fn((input: RemoteDeploymentProviderInput) =>
    Effect.succeed({
      result: {
        ok: true,
        detail: `${platform} ready`,
        stages: input.target.progress,
        disposition: "ready" as const,
        version: "0.1.0",
      },
      targetPlatform: platform,
      artifact: {
        identity: "Vellum Command",
        version: "0.1.0",
        source: "command-center" as const,
      },
      stationConfiguration: input.stationConfiguration,
      authorizationRequirement: "none" as const,
      readiness: "ready" as const,
      rollback: "not-required" as const,
    }),
  );
  return { platform, deploy } satisfies RemoteDeploymentProvider;
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
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "unsupported",
        reportedKernel: "Linux",
        platform: "linux",
      },
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

  it("gates configured-deploy settings mutation on target admission", async () => {
    const darwin = makeProvider("darwin");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      providers: [darwin],
    });
    const capture = vi.fn(() => Effect.die("capture must not run"));
    const stamp = vi.fn(() => Effect.die("stamp must not run"));
    const restore = vi.fn(() => Effect.die("restore must not run"));
    const deploy = vi.fn(() => Effect.die("legacy deploy must not run"));
    const deployPrepared = vi.fn(() =>
      Effect.die("prepared deploy must not run"),
    );
    const operations: ConfiguredRemoteDeployOperations = {
      prepare: dispatcher.prepare,
      deployPrepared,
      capture,
      stamp,
      restore,
      deploy,
    };

    const result = await Effect.runPromise(
      deployConfiguredRemoteHost(
        makeSsh("Linux\n"),
        host,
        { commandCenterRef: "local" },
        operations,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "previous",
      role: "previous",
      rollback: "not-required",
      disposition: "not-started",
      unsupportedTarget: { platform: "linux" },
    });
    expect(capture).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(deployPrepared).not.toHaveBeenCalled();
    expect(darwin.deploy).not.toHaveBeenCalled();
  });
});
