import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { RemoteHostsError } from "../src/shared/remote-hosts";
import { makeHostsService } from "../src/main/vellum/hosts/service";
import type { HostsRegistry } from "../src/main/vellum/hosts/registry";
import type { ConfiguredRemoteDeployResult } from "../src/main/vellum/hosts/deploy-configured-remote";

const remote = (id: string, endpoint = "shared-box"): RemoteHost => ({
  id,
  label: id,
  kind: "remote",
  endpoint,
  capabilities: [],
});

const registryFor = (
  hosts: ReadonlyArray<RemoteHost>,
): HostsRegistry =>
  ({
    path: () => "/tmp/hosts.json",
    get: async (id: string) => hosts.find((host) => host.id === id),
    list: async () => hosts,
    reload: async () => hosts,
  }) as HostsRegistry;

const failedResult = (host: RemoteHost): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail: "capture failed",
  code: "io",
  hostEndpoint: host.endpoint,
  stages: [],
  disposition: "not-started",
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  rollback: "not-required",
  configuration: { ok: false, detail: "capture failed" },
});

const unused = () => Effect.die(new Error("unexpected operation"));

describe("HostsService configured deploy admission", () => {
  it("runs the durable admission barrier before any remote mutation", async () => {
    const host = remote("studio");
    let admitted = false;
    const mutation = vi.fn((_ssh, target: RemoteHost) => {
      expect(admitted).toBe(true);
      return Effect.succeed(failedResult(target));
    });
    const service = makeHostsService(
      registryFor([host]),
      {} as never,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: mutation as never,
      },
    );

    await Effect.runPromise(
      service.deployConfiguredRemote("studio", {
        commandCenterRef: "local",
        onAdmitted: () =>
          Effect.sync(() => {
            admitted = true;
          }),
      }),
    );

    expect(mutation).toHaveBeenCalledOnce();
  });

  it("does not mutate when the durable admission receipt fails", async () => {
    const host = remote("studio");
    const mutation = vi.fn((_ssh, target: RemoteHost) =>
      Effect.succeed(failedResult(target)),
    );
    const service = makeHostsService(
      registryFor([host]),
      {} as never,
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: mutation as never,
      },
    );

    const result = await Effect.runPromise(
      service.deployConfiguredRemote("studio", {
        commandCenterRef: "local",
        onAdmitted: () =>
          Effect.fail(new RemoteHostsError("io", "disk unavailable")),
      }),
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "failed",
      disposition: "not-started",
      packageState: "previous",
    });
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
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: mutation as never,
      },
    );

    const firstRun = Effect.runPromise(
      service.deployConfiguredRemote("first", { commandCenterRef: "local" }),
    );
    await firstStarted;
    const secondRun = Effect.runPromise(
      service.deployConfiguredRemote("second", { commandCenterRef: "local" }),
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
      {
        configureRemoteHost: unused as never,
        deployRemoteHost: unused as never,
        deployConfiguredRemoteHost: ((_ssh: unknown, host: RemoteHost) =>
          Effect.succeed(failedResult(host))) as never,
      },
    );

    const firstRun = Effect.runPromise(
      service.deployConfiguredRemote("first", {
        commandCenterRef: "local",
        onAdmitted: () => Effect.sync(() => events.push("admit-first")),
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
        commandCenterRef: "local",
        onAdmitted: () => Effect.sync(() => events.push("admit-second")),
      }),
    );
    await Promise.resolve();
    expect(events).toEqual(["admit-first", "finalize-first"]);

    releaseFinalization?.();
    const [firstResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult.statusRecorded).toBe(true);
    expect(events).toEqual([
      "admit-first",
      "finalize-first",
      "admit-second",
    ]);
  });
});
