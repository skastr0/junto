import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { HostDeployJobSnapshot } from "../src/shared/deploy-job";
import { DoctorReport } from "../src/shared/contracts";
import { OperatorFleetTestData } from "../src/shared/operator-control";
import { composeMainFleetCompatibilitySnapshot } from "../src/main/vellum/hosts/fleet-compatibility";

const job = (
  status: HostDeployJobSnapshot["status"],
  recoveryHint?: string,
): HostDeployJobSnapshot => ({
  jobId: `job-${status}`,
  hostId: "remote-a",
  status,
  stages: ["real deploy stage"],
  percent: status === "running" ? 40 : 80,
  detail: `deploy ${status}`,
  startedAt: "2026-08-18T12:00:00.000Z",
  updatedAt: "2026-08-18T12:01:00.000Z",
  ...(recoveryHint === undefined ? {} : { recoveryHint }),
});

describe("Main Fleet compatibility IPC projection", () => {
  it("maps real deploy phases without inventing idle, success, or recovery", () => {
    const missing = composeMainFleetCompatibilitySnapshot({
      hostId: "remote-a",
    });
    expect(missing.update).toEqual({ state: "missing" });
    expect(missing.status).toBe("checking");

    const running = composeMainFleetCompatibilitySnapshot({
      hostId: "remote-a",
      deployJob: job("running"),
    });
    expect(running.update).toMatchObject({
      state: "known",
      phase: "running",
    });
    expect(running.update.recovery).toBeUndefined();

    const failed = composeMainFleetCompatibilitySnapshot({
      hostId: "remote-a",
      deployJob: job("failed", "Restore the prior package"),
    });
    expect(failed.update).toMatchObject({
      state: "known",
      phase: "failed",
      recovery: {
        required: true,
        hint: "Restore the prior package",
      },
    });

    const succeeded = composeMainFleetCompatibilitySnapshot({
      hostId: "remote-a",
      deployJob: job("succeeded"),
    });
    expect(succeeded.update).toMatchObject({
      state: "known",
      phase: "succeeded",
    });
  });

  it("round-trips the Main snapshot through existing Doctor and operator-control schemas", () => {
    const snapshot = composeMainFleetCompatibilitySnapshot({
      hostId: "remote-a",
      deployJob: job("failed"),
    });

    const operatorResult = Schema.decodeUnknownSync(OperatorFleetTestData)({
      hostId: "remote-a",
      ok: false,
      detail: "Station probe failed",
      compatibility: snapshot,
    });
    expect(operatorResult.compatibility?.update.phase).toBe("failed");

    const doctor = Schema.decodeUnknownSync(DoctorReport)({
      checkedAt: "2026-08-18T12:00:00.000Z",
      station: {
        name: "Vellum Command",
        version: "0.1.14",
        userDataPath: "/tmp/vellum-command",
      },
      services: [],
      recommendations: [],
      fleetCompatibility: snapshot,
    });
    expect(doctor.fleetCompatibility?.status).toBe("checking");

    const ipcSource = readFileSync("src/main/vellum/hosts/ipc.ts", "utf8");
    const operatorSource = readFileSync(
      "src/main/vellum/hosts/operator-coordinator.ts",
      "utf8",
    );
    expect(ipcSource).toContain("compatibility: result.success.compatibility");
    expect(operatorSource).toContain(
      "compatibility: result.success.compatibility",
    );
  });
});
