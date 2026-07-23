import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureRecordFromResult,
  deployRecordFromResult,
} from "../src/shared/station-status";
import {
  readStationStatus,
  recordStationConfigure,
  recordStationDeployment,
} from "../src/main/vellum/station-status-store";

describe("station status deployment persistence", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vellum-station-status-"));
    process.env.VELLUM_STATION_STATUS_PATH = join(root, "station-status.json");
  });

  afterEach(() => {
    delete process.env.VELLUM_STATION_STATUS_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps per-host deploy receipts and the matching configure outcome atomically", async () => {
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
      deployments: { studio: deployment },
    });
  });

  it("serializes concurrent status updates instead of losing a deploy receipt", async () => {
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
    const failedConfigure = configureRecordFromResult({
      ok: false,
      hostId: "studio",
      detail: "rollback unproven",
    });
    const otherConfigure = configureRecordFromResult({
      ok: true,
      hostId: "lab",
      detail: "configured separately",
    });

    await Promise.all([
      recordStationDeployment(deployment, failedConfigure),
      recordStationConfigure(otherConfigure),
    ]);

    const status = await readStationStatus();
    expect(status.deployments?.studio).toEqual(deployment);
    expect(status.lastConfigure).toEqual(otherConfigure);
  });

  it("keeps the last observed package across an admitted or rolled-back attempt", async () => {
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

  it("does not carry observations across a repointed registry endpoint", async () => {
    const previous = deployRecordFromResult({
      hostId: "studio",
      endpoint: "old-box",
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
    const newAttempt = deployRecordFromResult({
      hostId: "studio",
      endpoint: "new-box",
      ok: false,
      outcome: "indeterminate",
      packageState: "previous",
      role: "previous",
      rollback: "not-required",
      configurationOk: false,
      detail: "pending",
    });
    await recordStationDeployment(
      previous,
      configureRecordFromResult({ ok: true, hostId: "studio", detail: "ready" }),
    );
    await recordStationDeployment(
      newAttempt,
      configureRecordFromResult({ ok: false, hostId: "studio", detail: "pending" }),
    );

    const recorded = (await readStationStatus()).deployments?.studio;
    expect(recorded).toMatchObject({
      endpoint: "new-box",
      packageState: "previous",
      role: "previous",
      version: "unknown",
    });
    expect(recorded?.lastSeen).toBeUndefined();
  });
});
