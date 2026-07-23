import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";

const providerEvaluations = vi.hoisted(() => ({
  darwin: 0,
  linux: 0,
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
          result: {
            ok: true,
            detail: "darwin ready",
            stages: input.target.progress,
            disposition: "ready",
            version: "0.1.0",
          },
          targetPlatform: "darwin",
          artifact: {
            identity: "Vellum Command",
            version: "0.1.0",
            source: "command-center",
          },
          stationConfiguration: input.stationConfiguration,
          authorizationRequirement: "none",
          readiness: "ready",
          rollback: "not-required",
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
          result: {
            ok: true,
            detail: "linux ready",
            stages: input.target.progress,
            disposition: "ready",
            version: "0.1.0",
          },
          targetPlatform: "linux",
          artifact: {
            identity: "Vellum Command",
            version: "0.1.0",
            source: "command-center",
          },
          stationConfiguration: input.stationConfiguration,
          authorizationRequirement: "none",
          readiness: "ready",
          rollback: "not-required",
        }),
    },
  };
});

const host: RemoteHost = {
  id: "studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio-box",
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

  it.each([
    ["Linux\n", "linux", "linux ready"],
    ["Darwin\n", "darwin", "darwin ready"],
  ] as const)(
    "evaluates only the admitted %s provider branch",
    async (uname, selected, detail) => {
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
        dispatcher.deploy(makeSsh(uname) as never, host, {
          state: "managed-externally",
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        detail,
        disposition: "ready",
      });
      expect(providerEvaluations.darwin).toBe(selected === "darwin" ? 1 : 0);
      expect(providerEvaluations.linux).toBe(selected === "linux" ? 1 : 0);
    },
  );

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
