import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureRecordFromResult,
  deployRecordFromResult,
  projectionRecordFromResult,
  pullRecordFromResult,
} from "../src/shared/station-status";
import { canvasPullResult } from "../src/shared/canvas-pull";
import {
  readStationStatus,
  recordStationConfigure,
  recordStationDeployment,
  recordStationKernel,
  recordStationProjection,
  recordStationPull,
  StationStatusService,
  StationStatusStoreError,
  makeStationStatusLive,
  subscribeStationStatus,
} from "../src/main/vellum/station-status-store";
import {
  makeStateEngineLive,
} from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";

const HASH_A = "a".repeat(64);

const makeTestLayer = (databasePath: string) => {
  const engine = makeStateEngineLive(databasePath);
  return Layer.provideMerge(
    makeStationStatusLive(),
    engine,
  );
};

const makeTestRuntime = (databasePath: string) =>
  ManagedRuntime.make(makeTestLayer(databasePath));

describe("SQLite station status receipts", () => {
  let root = "";
  let databasePath = "";
  let runtime: ReturnType<typeof makeTestRuntime>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vellum-station-status-"));
    databasePath = join(root, "vellum.db");
    runtime = makeTestRuntime(databasePath);
    // Acquiring the app-owned service installs the Promise compatibility seam.
    await runtime.runPromise(StationStatusService);
  });

  afterEach(async () => {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps deploy and configure facts in one transaction", async () => {
    const configure = configureRecordFromResult({
      ok: true,
      hostId: "studio",
      detail: "configured",
      at: "2026-07-22T20:00:00.000Z",
    });
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.1.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
      stages: ["signed package admitted", "station ready"],
      at: "2026-07-22T20:00:00.000Z",
    });

    await recordStationDeployment(deployment, configure);

    await expect(readStationStatus()).resolves.toMatchObject({
      version: 1,
      lastConfigure: configure,
      configures: { studio: configure },
      deployments: { studio: deployment },
    });
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("rehydrates committed receipts after the app-owned engine restarts", async () => {
    const configure = configureRecordFromResult({
      ok: true,
      hostId: "studio",
      detail: "configured",
    });
    await recordStationConfigure(configure);
    await runtime.dispose();

    runtime = makeTestRuntime(databasePath);
    await runtime.runPromise(StationStatusService);

    await expect(readStationStatus()).resolves.toMatchObject({
      lastConfigure: configure,
      configures: { studio: configure },
    });
  });

  it("cannot lose unrelated host rows under concurrent updates", async () => {
    const failedConfigure = configureRecordFromResult({
      ok: false,
      hostId: "studio",
      detail: "rollback unproven",
    });
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "unknown",
      role: "unknown",
      rollback: "failed",
      configurationOk: false,
      detail: "manual inspection required",
    });
    const labConfigure = configureRecordFromResult({
      ok: true,
      hostId: "lab",
      detail: "configured separately",
    });

    await Promise.all([
      recordStationDeployment(deployment, failedConfigure),
      recordStationConfigure(labConfigure),
    ]);

    const status = await readStationStatus();
    expect(status.deployments?.studio).toEqual(deployment);
    expect(status.configures?.studio).toEqual(failedConfigure);
    expect(status.configures?.lab).toEqual(labConfigure);
  });

  it("rejects a deployment paired with another host's configure receipt", async () => {
    const deployment = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
    });
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.either(
          status.recordDeployment(
            deployment,
            configureRecordFromResult({
              ok: true,
              hostId: "lab",
              detail: "wrong host",
            }),
          ),
        );
      }),
    );

    expect(result._tag).toBe("Left");
    await expect(readStationStatus()).resolves.toEqual({ version: 1 });
  });

  it("notifies observers only after the committed facts are readable", async () => {
    const committedReads: Array<Promise<string>> = [];
    const seenKinds: string[] = [];
    const unsubscribe = subscribeStationStatus((change) => {
      seenKinds.push(change.kind);
      committedReads.push(
        readStationStatus().then(
          (status) =>
            `${status.lastPull?.status ?? "none"}:${status.kernel?.armedRegionCount ?? "none"}`,
        ),
      );
    });
    try {
      await recordStationPull(
        pullRecordFromResult(
          canvasPullResult({
            ok: false,
            status: "unreachable",
            detail: "offline",
            commandCenterRef: "command",
            pulled: [],
            failed: [],
            keptLocal: true,
          }),
        ),
      );
      await recordStationKernel({
        observedAt: "2026-07-23T12:00:00.000Z",
        armedRegionCount: 2,
        orphanedArmingCount: 0,
      });
    } finally {
      unsubscribe();
    }

    expect(seenKinds).toEqual(["pull", "kernel"]);
    await expect(Promise.all(committedReads)).resolves.toEqual([
      "unreachable:none",
      "unreachable:2",
    ]);
  });

  it("orders projection receipts by logical generation, never timestamp", async () => {
    await recordStationProjection(
      projectionRecordFromResult({
        hostId: "studio",
        generation: "9007199254740993",
        manifestSha256: HASH_A,
        status: "applied",
        detail: "new authority",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await recordStationProjection(
      projectionRecordFromResult({
        hostId: "studio",
        generation: "9007199254740992",
        manifestSha256: HASH_A,
        status: "unreachable",
        detail: "late stale receipt",
        at: "2027-01-01T00:00:00.000Z",
      }),
    );

    const status = await readStationStatus();
    expect(status.lastProjection).toMatchObject({
      generation: "9007199254740993",
      status: "applied",
    });
    expect(status.projections?.studio).toMatchObject({
      generation: "9007199254740993",
      status: "applied",
    });
  });

  it("stores a lower generation for a new host without regressing the global pointer", async () => {
    await recordStationProjection(
      projectionRecordFromResult({
        hostId: "studio",
        generation: "10",
        manifestSha256: HASH_A,
        status: "applied",
        detail: "studio current",
      }),
    );
    await recordStationProjection(
      projectionRecordFromResult({
        hostId: "lab",
        generation: "9",
        manifestSha256: HASH_A,
        status: "staged",
        detail: "lab catching up",
      }),
    );

    const status = await readStationStatus();
    expect(status.lastProjection?.generation).toBe("10");
    expect(status.lastProjection?.hostId).toBe("studio");
    expect(status.projections?.lab?.generation).toBe("9");
  });

  it("permits same-content status progress but rejects same-generation content conflicts", async () => {
    const pending = projectionRecordFromResult({
      hostId: "studio",
      generation: "12",
      manifestSha256: HASH_A,
      status: "pending",
      detail: "scheduled",
    });
    await recordStationProjection(pending);
    await recordStationProjection({
      ...pending,
      status: "applied",
      ok: true,
      detail: "installed",
    });

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.either(
          status.recordProjection({
            ...pending,
            manifestSha256: "b".repeat(64),
            status: "rejected",
            ok: false,
            detail: "conflicting frame",
          }),
        );
      }),
    );
    expect(result._tag).toBe("Left");
    await expect(readStationStatus()).resolves.toMatchObject({
      projections: {
        studio: {
          generation: "12",
          manifestSha256: HASH_A,
          status: "applied",
        },
      },
    });
  });

  it("rolls back a transition that violates the shared status contract", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.either(
          status.recordKernel({
            observedAt: "2026-07-23T12:00:00.000Z",
            armedRegionCount: -1,
            orphanedArmingCount: 0,
          }),
        );
      }),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(StationStatusStoreError);
    }
    await expect(readStationStatus()).resolves.toEqual({ version: 1 });
  });

  it("rejects an invalid projection even when it would compare as stale", async () => {
    await recordStationProjection(
      projectionRecordFromResult({
        hostId: "studio",
        generation: "1000",
        manifestSha256: HASH_A,
        status: "applied",
        detail: "current",
      }),
    );
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.either(
          status.recordProjection(
            projectionRecordFromResult({
              hostId: "studio",
              generation: "bad",
              manifestSha256: HASH_A,
              status: "unreachable",
              detail: "invalid and shorter",
            }),
          ),
        );
      }),
    );
    expect(result._tag).toBe("Left");
    await expect(readStationStatus()).resolves.toMatchObject({
      projections: {
        studio: { generation: "1000", status: "applied" },
      },
    });
  });

  it("fails typed and closed when SQLite facts violate the shared contract", async () => {
    await recordStationKernel({
      observedAt: "2026-07-23T12:00:00.000Z",
      armedRegionCount: 2,
      orphanedArmingCount: 0,
    });
    await runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        yield* state.transaction("test.corrupt-station-status", (writer) => {
          writer.run(
            `
              UPDATE station_status_facts
              SET record_json = '{}'
              WHERE kind = 'kernel' AND host_id = ''
            `,
          );
        });
      }),
    );

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.either(status.read);
      }),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(StationStatusStoreError);
    }
  });

  it("preserves the last observed package across an admitted retry", async () => {
    const ready = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: true,
      outcome: "ready",
      packageState: "present",
      role: "remote",
      version: "0.9.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      rollback: "not-required",
      configurationOk: true,
      detail: "ready",
    });
    await recordStationDeployment(
      ready,
      configureRecordFromResult({
        ok: true,
        hostId: "studio",
        detail: "ready",
      }),
    );

    const admitted = deployRecordFromResult({
      hostId: "studio",
      endpoint: "studio-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "previous",
      role: "previous",
      rollback: "not-required",
      configurationOk: false,
      detail: "completion receipt pending",
    });
    await recordStationDeployment(
      admitted,
      configureRecordFromResult({
        ok: false,
        hostId: "studio",
        detail: "pending",
      }),
    );

    expect((await readStationStatus()).deployments?.studio).toMatchObject({
      outcome: "indeterminate",
      packageState: "present",
      role: "remote",
      version: "0.9.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
    });
  });
});
