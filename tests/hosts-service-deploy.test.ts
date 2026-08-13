import { Context, Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { InstallationId } from "../src/shared/station-api";
import type { ConfigureRemoteOptions } from "../src/main/vellum/hosts/configure-remote";

// Admission/serialization tests need the managed-deploy path open. Product
// RELEASE_CAPABILITIES freezes managed deploy for beta — override here only.
vi.mock("@shared/release-capabilities", () => ({
  RELEASE_CAPABILITIES: Object.freeze({
    freshRemoteEnrollment: true,
    managedRemoteDeploy: true,
    darwinRemoteDeploy: false,
    linuxRemoteDeploy: true,
    boxFleet: true,
    commandCenterTransfer: false,
  }),
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL: "managed deploy disabled (test mock)",
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL: "darwin deploy disabled (test mock)",
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL: "linux deploy disabled (test mock)",
  BOX_FLEET_DISABLED_DETAIL: "box fleet disabled (test mock)",
}));

import { makeHostsService } from "../src/main/vellum/hosts/service";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";
import type {
  ConfiguredRemoteDeployOptions,
  ConfiguredRemoteDeployResult,
} from "../src/main/vellum/hosts/deploy-configured-remote";
import { StationFleetPropagation } from "../src/main/vellum/station/fleet-propagation";

const remote = (id: string, endpoint = "shared-box"): RemoteHost => ({
  id,
  label: id,
  kind: "remote",
  sshEndpoint: endpoint,
  capabilities: [],
});

const registryFor = (
  hosts: ReadonlyArray<RemoteHost>,
): HostsRegistry =>
  ({
    get: async (id: string) => hosts.find((host) => host.id === id),
    list: async () => hosts,
    reload: async () => hosts,
  }) as HostsRegistry;

const commandCenterInstallationId =
  Schema.decodeUnknownSync(InstallationId)("command-center");
const configureOptions: ConfigureRemoteOptions = {
  commandCenterInstallationId,
  appVersion: "0.1.0",
};

const failedResult = (host: RemoteHost): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail: "capture failed",
  code: "io",
  hostEndpoint: host.sshEndpoint,
  stages: [],
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  configuration: { ok: false, detail: "capture failed" },
});

const unused = () => Effect.die(new Error("unexpected operation"));
const unusedFleet = {} as Context.Service.Shape<
  typeof StationFleetPropagation
>;

describe("HostsService configured deploy admission", () => {
  it("forwards artifact source into the configured deploy mutation", async () => {
    const host = remote("studio");
    const mutation = vi.fn(
      (
        _ssh: unknown,
        target: RemoteHost,
        received: ConfiguredRemoteDeployOptions,
      ) =>
        Effect.sync(() => {
          expect(received.artifactSource).toBe("verified-cache");
          return failedResult(target);
        }),
    );
    const service = makeHostsService(
      registryFor([host]),
      {} as never,
      unusedFleet,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: mutation as never,
      },
    );

    await Effect.runPromise(
      service.deployConfiguredRemote("studio", {
        ...configureOptions,
        artifactSource: "verified-cache",
      }),
    );

    expect(mutation).toHaveBeenCalledOnce();
  });

  it("serializes aliases that resolve to the same remote endpoint", async () => {
    const first = remote("first");
    const second = remote("second");
    const starts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const mutation = vi.fn((_ssh, target: RemoteHost) =>
      Effect.promise(async () => {
        starts.push(target.id);
        if (target.id === "first") {
          signalFirstStarted?.();
          await firstReleased;
        }
        return failedResult(target);
      }),
    );
    const service = makeHostsService(
      registryFor([first, second]),
      {} as never,
      unusedFleet,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: mutation as never,
      },
    );

    const firstRun = Effect.runPromise(
      service.deployConfiguredRemote("first", configureOptions),
    );
    await firstStarted;
    const secondRun = Effect.runPromise(
      service.deployConfiguredRemote("second", configureOptions),
    );
    await Promise.resolve();
    expect(starts).toEqual(["first"]);

    releaseFirst?.();
    await Promise.all([firstRun, secondRun]);
    expect(starts).toEqual(["first", "second"]);
  });

  it("finalizes one receipt before admitting the next endpoint-alias attempt", async () => {
    const first = remote("first");
    const second = remote("second");
    const events: string[] = [];
    let signalFinalizing: (() => void) | undefined;
    const finalizing = new Promise<void>((resolve) => {
      signalFinalizing = resolve;
    });
    let releaseFinalization: (() => void) | undefined;
    const finalizationReleased = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    const service = makeHostsService(
      registryFor([first, second]),
      {} as never,
      unusedFleet,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: ((_ssh: unknown, host: RemoteHost) =>
          Effect.succeed(failedResult(host))) as never,
      },
    );

    const firstRun = Effect.runPromise(
      service.deployConfiguredRemote("first", {
        ...configureOptions,
        onCompleted: () =>
          Effect.promise(async () => {
            events.push("finalize-first");
            signalFinalizing?.();
            await finalizationReleased;
          }),
      }),
    );
    await finalizing;
    const secondRun = Effect.runPromise(
      service.deployConfiguredRemote("second", {
        ...configureOptions,
        onCompleted: () =>
          Effect.sync(() => {
            events.push("finalize-second");
          }),
      }),
    );
    await Promise.resolve();
    expect(events).toEqual(["finalize-first"]);

    releaseFinalization?.();
    const [firstResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult.statusRecorded).toBe(true);
    expect(events).toEqual(["finalize-first", "finalize-second"]);
  });
});
