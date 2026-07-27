import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeStationFleetTargetRepositoryLive,
  StationFleetTargetRepository,
  type StationFleetTargetIdentity,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  makeStateEngineLive,
  type StateEngineError,
} from "../src/main/vellum/state/engine";
import { HostId } from "../src/shared/remote-hosts";
import { InstallationId } from "../src/shared/station-api";

type FleetRuntime = ManagedRuntime.ManagedRuntime<
  StationFleetTargetRepository,
  StateEngineError
>;

const decodeHostId = Schema.decodeUnknownSync(HostId);
const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);

const roots: string[] = [];
const runtimes: FleetRuntime[] = [];

const makeRuntime = async (
  path?: string,
): Promise<Readonly<{ path: string; runtime: FleetRuntime }>> => {
  const root = path === undefined
    ? await mkdtemp(join(tmpdir(), "vellum-fleet-targets-"))
    : undefined;
  if (root !== undefined) roots.push(root);
  const databasePath = path ?? join(root!, "state", "vellum.db");
  const runtime = ManagedRuntime.make(
    makeStationFleetTargetRepositoryLive({
      now: () => "2026-07-27T12:00:00.000Z",
    }).pipe(Layer.provide(makeStateEngineLive(databasePath))),
  );
  runtimes.push(runtime);
  return { path: databasePath, runtime };
};

const repository = (
  runtime: FleetRuntime,
): Promise<Context.Tag.Service<typeof StationFleetTargetRepository>> =>
  runtime.runPromise(StationFleetTargetRepository);

const identity = (
  hostId: string,
  installationId: string,
): StationFleetTargetIdentity => ({
  hostId: decodeHostId(hostId),
  stationInstallationId: decodeInstallationId(installationId),
});

const disposeRuntime = async (runtime: FleetRuntime): Promise<void> => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
  await runtime.dispose();
};

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("StationFleetTargetRepository", () => {
  it("persists canonical targets and lists them in host order", async () => {
    const { path, runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const mini = identity("mini", "station-mini");
    const studio = identity("studio", "station-studio");

    await runtime.runPromise(fleet.bind(studio));
    const boundMini = await runtime.runPromise(fleet.bind(mini));

    expect(boundMini).toEqual({
      ...mini,
      boundAt: "2026-07-27T12:00:00.000Z",
    });
    expect(await runtime.runPromise(fleet.get(mini.hostId))).toEqual(
      boundMini,
    );
    expect(
      (await runtime.runPromise(fleet.list)).map((target) => target.hostId),
    ).toEqual(["mini", "studio"]);

    await disposeRuntime(runtime);
    const reopened = await makeRuntime(path);
    const persisted = await repository(reopened.runtime);
    expect(await reopened.runtime.runPromise(persisted.list)).toEqual([
      boundMini,
      {
        ...studio,
        boundAt: "2026-07-27T12:00:00.000Z",
      },
    ]);
  });

  it("makes exact retries idempotent without rewriting identity metadata", async () => {
    const { runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const target = identity("mini", "station-mini");

    const first = await runtime.runPromise(
      fleet.bind(target, "2026-07-27T12:30:00.000Z"),
    );
    const retry = await runtime.runPromise(
      fleet.bind(target, "2026-07-28T15:00:00.000Z"),
    );

    expect(retry).toEqual(first);
    expect(retry.boundAt).toBe("2026-07-27T12:30:00.000Z");
    expect(await runtime.runPromise(fleet.list)).toHaveLength(1);
  });

  it("fails closed when one installation is presented as another host", async () => {
    const { runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const admitted = await runtime.runPromise(
      fleet.bind(identity("mini", "station-mini")),
    );
    const rejected = identity("studio", "station-mini");

    expect(
      await runtime.runPromise(
        fleet.bind(rejected).pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationFleetTargetConflictError",
        admitted,
        rejected,
      },
    });
    expect(await runtime.runPromise(fleet.list)).toEqual([admitted]);
  });

  it("retires an active target without erasing its immutable host binding", async () => {
    const { path, runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const first = identity("mini", "station-mini");
    const replacement = identity("mini", "station-new-mini");

    expect(await runtime.runPromise(fleet.remove(first.hostId))).toBe(false);
    const admitted = await runtime.runPromise(fleet.bind(first));
    expect(await runtime.runPromise(fleet.remove(first.hostId))).toBe(true);
    expect(await runtime.runPromise(fleet.remove(first.hostId))).toBe(false);
    expect(await runtime.runPromise(fleet.get(first.hostId))).toBeUndefined();
    expect(await runtime.runPromise(fleet.list)).toEqual([]);

    await disposeRuntime(runtime);
    const reopened = await makeRuntime(path);
    const persisted = await repository(reopened.runtime);
    expect(
      await reopened.runtime.runPromise(
        persisted.bind(replacement).pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationFleetTargetHostBindingImmutableError",
        hostId: first.hostId,
        boundStationInstallationId: first.stationInstallationId,
        rejectedStationInstallationId:
          replacement.stationInstallationId,
        message: expect.stringContaining(
          "use a new host identity or a future explicit Station transfer ceremony",
        ),
      },
    });
    expect(await reopened.runtime.runPromise(persisted.list)).toEqual([]);

    expect(await reopened.runtime.runPromise(persisted.bind(first))).toEqual(
      admitted,
    );
    expect(await reopened.runtime.runPromise(persisted.list)).toEqual([
      admitted,
    ]);
  });

  it("rejects direct host replacement without mutating the admitted row", async () => {
    const { runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const first = identity("mini", "station-mini");
    const replacement = identity("mini", "station-new-mini");
    const admitted = await runtime.runPromise(
      fleet.bind(first, "2026-07-27T12:30:00.000Z"),
    );

    expect(
      await runtime.runPromise(
        fleet.bind(
          replacement,
          "2026-07-28T15:00:00.000Z",
        ).pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationFleetTargetHostBindingImmutableError",
        hostId: first.hostId,
        boundStationInstallationId: first.stationInstallationId,
        rejectedStationInstallationId:
          replacement.stationInstallationId,
        message: expect.stringContaining(
          "use a new host identity or a future explicit Station transfer ceremony",
        ),
      },
    });
    expect(await runtime.runPromise(fleet.get(first.hostId))).toEqual(
      admitted,
    );
    expect(await runtime.runPromise(fleet.list)).toEqual([admitted]);
  });

  it("rejects invalid display timestamps before opening a write", async () => {
    const { runtime } = await makeRuntime();
    const fleet = await repository(runtime);
    const target = identity("mini", "station-mini");

    expect(
      await runtime.runPromise(
        fleet.bind(target, "").pipe(Effect.either),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationFleetTargetMetadataError",
        operation: "bind",
        field: "boundAt",
      },
    });
    expect(await runtime.runPromise(fleet.list)).toEqual([]);
  });
});
