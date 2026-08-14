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
import { HostRuntime } from "../src/main/vellum/hosts/host-runtime";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";
import type { ConfiguredRemoteDeployResult } from "../src/main/vellum/hosts/deploy-configured-remote";
import { StationFleetPropagation } from "../src/main/vellum/station/fleet-propagation";
import { Layer } from "effect";

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

const withRuntime = <A>(
  serviceEffect: Effect.Effect<A, never, HostRuntime>,
  reconcile: Context.Service.Shape<typeof HostRuntime>["reconcile"],
): Promise<A> =>
  Effect.runPromise(
    serviceEffect.pipe(
      Effect.provide(
        Layer.succeed(
          HostRuntime,
          HostRuntime.of({
            observe: () => Effect.die("observe unused"),
            reconcile,
          }),
        ),
      ),
    ),
  );

describe("HostsService configured deploy admission", () => {
  it("forwards artifact source into HostRuntime.reconcile", async () => {
    const host = remote("studio");
    const mutation = vi.fn(
      (_id: string, received: { readonly artifactSource?: string }) =>
        Effect.sync(() => {
          expect(received.artifactSource).toBe("verified-cache");
          return failedResult(host);
        }),
    );
    const service = makeHostsService(
      registryFor([host]),
      {} as never,
      unusedFleet,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
      },
    );

    await withRuntime(
      service.deployConfiguredRemote("studio", {
        ...configureOptions,
        artifactSource: "verified-cache",
      }),
      mutation as never,
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
    const mutation = vi.fn((id: string) =>
      Effect.promise(async () => {
        starts.push(id);
        if (id === "first") {
          signalFirstStarted?.();
          await firstReleased;
        }
        return failedResult(id === "first" ? first : second);
      }),
    );
    const service = makeHostsService(
      registryFor([first, second]),
      {} as never,
      unusedFleet,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
      },
    );
    const runtime = Layer.succeed(
      HostRuntime,
      HostRuntime.of({
        observe: () => Effect.die("observe unused"),
        reconcile: mutation as never,
      }),
    );

    const firstRun = Effect.runPromise(
      service.deployConfiguredRemote("first", configureOptions).pipe(
        Effect.provide(runtime),
      ),
    );
    await firstStarted;
    const secondRun = Effect.runPromise(
      service.deployConfiguredRemote("second", configureOptions).pipe(
        Effect.provide(runtime),
      ),
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
      },
    );
    const runtime = Layer.succeed(
      HostRuntime,
      HostRuntime.of({
        observe: () => Effect.die("observe unused"),
        reconcile: (_id, input) =>
          Effect.gen(function* () {
            const deployed = failedResult(
              _id === "first" ? first : second,
            );
            if (input.onCompleted === undefined) return deployed;
            const host = _id === "first" ? first : second;
            const completion = yield* input.onCompleted(host, deployed).pipe(
              Effect.result,
            );
            return completion._tag === "Success"
              ? { ...deployed, statusRecorded: true }
              : deployed;
          }),
      }),
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
      }).pipe(Effect.provide(runtime)),
    );
    await finalizing;
    const secondRun = Effect.runPromise(
      service.deployConfiguredRemote("second", {
        ...configureOptions,
        onCompleted: () =>
          Effect.sync(() => {
            events.push("finalize-second");
          }),
      }).pipe(Effect.provide(runtime)),
    );
    await Promise.resolve();
    expect(events).toEqual(["finalize-first"]);

    releaseFinalization?.();
    const [firstResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult.statusRecorded).toBe(true);
    expect(events).toEqual(["finalize-first", "finalize-second"]);
  });
});
