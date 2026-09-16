import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StationHostId } from "../src/shared/station-api";
import {
  refusedBeforeApplyDeployRecord,
  STATION_STATUS_VERSION,
  type StationDeployRecord,
  type StationKernelRecord,
} from "../src/shared/station-status";
import {
  makeStationStatusLive,
  StationStatusService,
  StationStatusStoreError,
} from "../src/main/vellum-command/station-status-store";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StateEngine } from "../src/main/vellum-command/state/service";

const decodeHostId = Schema.decodeUnknownSync(StationHostId);
const STUDIO_HOST = decodeHostId("studio");
const LAB_HOST = decodeHostId("lab");

const kernelRecord = (
  overrides: Partial<StationKernelRecord> = {},
): StationKernelRecord => ({
  observedAt: "2026-07-23T12:00:00.000Z",
  armedRegionCount: 2,
  orphanedArmingCount: 0,
  ...overrides,
});

const deploymentRecord = (
  overrides: Partial<StationDeployRecord> = {},
): StationDeployRecord => ({
  at: "2026-07-22T20:00:00.000Z",
  hostId: STUDIO_HOST,
  endpoint: "studio-box",
  ok: true,
  outcome: "ready",
  packageState: "present",
  role: "remote",
  version: "0.9.0",
  lastSeen: "2026-07-22T20:00:00.000Z",
  configurationOk: true,
  detail: "ready",
  stages: ["signed package admitted", "station ready"],
  ...overrides,
});

const makeTestLayer = (databasePath: string) => {
  const engine = makeStateEngineLive(databasePath);
  return Layer.provideMerge(makeStationStatusLive(), engine);
};

const makeTestRuntime = (databasePath: string) =>
  ManagedRuntime.make(makeTestLayer(databasePath));

type TestRuntime = ReturnType<typeof makeTestRuntime>;

const acquireStatus = (runtime: TestRuntime) =>
  runtime.runPromise(StationStatusService);

const readStatus = (runtime: TestRuntime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const status = yield* StationStatusService;
      return yield* status.read;
    }),
  );

const recordKernel = (
  runtime: TestRuntime,
  kernel: StationKernelRecord,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const status = yield* StationStatusService;
      yield* status.recordKernel(kernel);
    }),
  );

const recordDeployment = (
  runtime: TestRuntime,
  deployment: StationDeployRecord,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const status = yield* StationStatusService;
      yield* status.recordDeployment(deployment);
    }),
  );

describe("SQLite station status receipts", () => {
  let root = "";
  let databasePath = "";
  let runtime: TestRuntime;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "vellum-command-station-status-"));
    databasePath = join(root, "junto.db");
    runtime = makeTestRuntime(databasePath);
    await acquireStatus(runtime);
  });

  afterEach(async () => {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("rehydrates kernel and per-host deployment facts after restart", async () => {
    const kernel = kernelRecord();
    const deployment = deploymentRecord();

    await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        yield* status.recordKernel(kernel);
        yield* status.recordDeployment(deployment);
      }),
    );

    await expect(readStatus(runtime)).resolves.toEqual({
      version: STATION_STATUS_VERSION,
      kernel,
      deployments: { studio: deployment },
    });
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    await runtime.dispose();
    runtime = makeTestRuntime(databasePath);
    await acquireStatus(runtime);

    await expect(readStatus(runtime)).resolves.toEqual({
      version: STATION_STATUS_VERSION,
      kernel,
      deployments: { studio: deployment },
    });
  });

  it("cannot lose an unrelated host under concurrent deployment updates", async () => {
    const studio = deploymentRecord();
    const lab = deploymentRecord({
      hostId: LAB_HOST,
      endpoint: "lab-box",
      version: "1.0.0",
      detail: "lab ready",
    });

    await Promise.all([
      recordDeployment(runtime, studio),
      recordDeployment(runtime, lab),
    ]);

    await expect(readStatus(runtime)).resolves.toEqual({
      version: STATION_STATUS_VERSION,
      deployments: { lab, studio },
    });
  });

  it("rolls back an invalid kernel transition with a typed error", async () => {
    const committed = kernelRecord();
    await recordKernel(runtime, committed);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const status = yield* StationStatusService;
        return yield* Effect.result(
          status.recordKernel(
            kernelRecord({
              observedAt: "2026-07-23T12:01:00.000Z",
              armedRegionCount: -1,
            }),
          ),
        );
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(StationStatusStoreError);
    }
    await expect(readStatus(runtime)).resolves.toEqual({
      version: STATION_STATUS_VERSION,
      kernel: committed,
    });
  });

  it("fails typed and closed when a durable fact is corrupt", async () => {
    await recordKernel(runtime, kernelRecord());
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
        return yield* Effect.result(status.read);
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(StationStatusStoreError);
    }
  });

  it("preserves observed package, role, and version across an admitted retry", async () => {
    const ready = deploymentRecord();
    await recordDeployment(runtime, ready);

    const retry: StationDeployRecord = {
      at: "2026-07-22T20:05:00.000Z",
      hostId: STUDIO_HOST,
      endpoint: "studio-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "previous",
      role: "previous",
      version: "unknown",
      configurationOk: false,
      detail: "completion receipt pending",
      stages: ["signed package admitted"],
    };
    await recordDeployment(runtime, retry);

    await expect(readStatus(runtime)).resolves.toEqual({
      version: STATION_STATUS_VERSION,
      deployments: {
        studio: {
          ...retry,
          packageState: "present",
          role: "remote",
          version: "0.9.0",
          lastSeen: "2026-07-22T20:00:00.000Z",
        },
      },
    });
  });

  it("keeps a healthy Remote's observed truth across a never-applied executor refusal", async () => {
    // A sleeping Remote refused with "io" during a managed-update pass: the
    // deploy never reached apply, so the durable refusal receipt must not
    // clobber the machine's last observed package, role, version or lastSeen
    // with a version that was never installed.
    const ready = deploymentRecord();
    await recordDeployment(runtime, ready);

    const refusal = refusedBeforeApplyDeployRecord({
      hostId: "studio",
      endpoint: "studio-box",
      detail: "Can't reach Studio on the network.",
      stages: [],
      at: "2026-07-22T20:10:00.000Z",
    });
    expect(refusal).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "previous",
      role: "previous",
      version: "unknown",
      recoveryKind: "retryable",
    });
    await recordDeployment(runtime, refusal);

    const status = await readStatus(runtime);
    expect(status.deployments?.[STUDIO_HOST]).toMatchObject({
      ok: false,
      outcome: "failed",
      packageState: "present",
      role: "remote",
      version: "0.9.0",
      lastSeen: "2026-07-22T20:00:00.000Z",
      recoveryKind: "retryable",
    });
  });

});
