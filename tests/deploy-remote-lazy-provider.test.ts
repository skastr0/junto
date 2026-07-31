import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";

// Mutable counters shared with the runtime mock (no vi.hoisted — bun).
const providerEvaluations = {
  darwin: 0,
  linux: 0,
};

// Default open surface so provider-branch tests still prove lazy selection.
// Production freezes linuxRemoteDeploy — covered by a dedicated refusal case.
vi.mock("@shared/release-capabilities", () => ({
  RELEASE_CAPABILITIES: Object.freeze({
    freshRemoteEnrollment: true,
    managedRemoteDeploy: true,
    darwinRemoteDeploy: true,
    linuxRemoteDeploy: true,
    boxFleet: true,
    commandCenterTransfer: true,
  }),
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL: "darwin deploy disabled (test mock)",
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL: "linux deploy disabled (test mock)",
}));

vi.mock("../src/main/vellum/hosts/deploy-darwin", async () => {
  providerEvaluations.darwin += 1;
  const { Effect: MockEffect } = await import("effect");
  return {
    darwinRemoteDeploymentProvider: {
      platform: "darwin",
      supportsBrowser: true,
      deploy: (input: {
        readonly target: { readonly progress: readonly string[] };
        readonly stationConfiguration: unknown;
      }) =>
        MockEffect.succeed({
          ok: true,
          detail: "darwin ready",
          stages: input.target.progress,
          disposition: "ready",
          version: "0.1.0",
        }),
    },
  };
});

vi.mock("../src/main/vellum/hosts/deploy-linux", async () => {
  providerEvaluations.linux += 1;
  const { Effect: MockEffect } = await import("effect");
  return {
    linuxRemoteDeploymentProvider: {
      platform: "linux",
      supportsBrowser: true,
      deploy: (input: {
        readonly target: { readonly progress: readonly string[] };
        readonly stationConfiguration: unknown;
      }) =>
        MockEffect.succeed({
          ok: true,
          detail: "linux ready",
          stages: input.target.progress,
          disposition: "ready",
          version: "0.1.0",
        }),
    },
  };
});

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio-box",
  capabilities: ["terminal"],
};

const makeSsh = (stdout: string) => ({
  warm: vi.fn(() => Effect.void),
  run: vi.fn(() => Effect.succeed({ stdout, stderr: "" })),
});

beforeEach(() => {
  vi.resetModules();
  providerEvaluations.darwin = 0;
  providerEvaluations.linux = 0;
});

describe("Remote deployment provider evaluation", () => {
  it("does not evaluate either deployment provider through the startup hosts barrel", async () => {
    const hosts = await import("../src/main/vellum/hosts/index");

    expect(hosts.HostsService).toBeDefined();
    expect(providerEvaluations).toEqual({ darwin: 0, linux: 0 });
  });

  it("evaluates only the admitted Linux provider branch", async () => {
    const {
      loadRemoteDeploymentProvider,
      makeRemoteDeploymentDispatcher,
    } = await import("../src/main/vellum/hosts/deploy-remote");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      loadProvider: loadRemoteDeploymentProvider,
    });

    expect(providerEvaluations).toEqual({ darwin: 0, linux: 0 });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Linux\n") as never, host, {
        state: "managed-externally",
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      detail: "linux ready",
      disposition: "ready",
    });
    expect(providerEvaluations).toEqual({ darwin: 0, linux: 1 });
  });

  it("loads Darwin provider under full product surface without evaluating linux", async () => {
    const {
      loadRemoteDeploymentProvider,
      makeRemoteDeploymentDispatcher,
    } = await import("../src/main/vellum/hosts/deploy-remote");

    const provider = await loadRemoteDeploymentProvider("darwin");
    expect(provider?.platform).toBe("darwin");
    expect(providerEvaluations).toEqual({ darwin: 1, linux: 0 });

    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      loadProvider: loadRemoteDeploymentProvider,
    });
    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Darwin\n") as never, host, {
        state: "managed-externally",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      detail: "darwin ready",
      disposition: "ready",
    });
    // Selector may load again on deploy; never touch the linux branch.
    expect(providerEvaluations.linux).toBe(0);
    expect(providerEvaluations.darwin).toBeGreaterThanOrEqual(1);
  });

  it("fails closed on an unsupported target without evaluating a provider", async () => {
    const {
      loadRemoteDeploymentProvider,
      makeRemoteDeploymentDispatcher,
    } = await import("../src/main/vellum/hosts/deploy-remote");
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      loadProvider: loadRemoteDeploymentProvider,
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("FreeBSD\n") as never, host, {
        state: "managed-externally",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      disposition: "not-started",
      unsupportedTarget: {
        kind: "unsupported-target",
        evidence: "unsupported",
        reportedKernel: "FreeBSD",
      },
    });
    expect(providerEvaluations).toEqual({ darwin: 0, linux: 0 });
  });

  it("has no provider fallback for an unsupported local platform", async () => {
    const { loadRemoteDeploymentProvider } = await import(
      "../src/main/vellum/hosts/deploy-remote"
    );

    await expect(
      loadRemoteDeploymentProvider("freebsd"),
    ).resolves.toBeUndefined();
    expect(providerEvaluations).toEqual({ darwin: 0, linux: 0 });
  });

  it("turns a selected-provider load failure into a closed result", async () => {
    const { makeRemoteDeploymentDispatcher } = await import(
      "../src/main/vellum/hosts/deploy-remote"
    );
    const loadProvider = vi.fn(async () => {
      throw new Error("provider failed during evaluation");
    });
    const dispatcher = makeRemoteDeploymentDispatcher({
      commandCenterPlatform: "darwin",
      loadProvider,
    });

    const result = await Effect.runPromise(
      dispatcher.deploy(makeSsh("Linux\n") as never, host, {
        state: "managed-externally",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "validation",
      disposition: "not-started",
      message: "remote deployment provider unavailable",
    });
    expect(loadProvider).toHaveBeenCalledExactlyOnceWith("linux");
    expect(providerEvaluations).toEqual({ darwin: 0, linux: 0 });
  });
});
