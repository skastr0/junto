import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  percentFromStages,
  type HostDeployJobStatus,
} from "../src/shared/deploy-job";
import {
  appendDeployJobStage,
  beginDeployJob,
  finishDeployJob,
  getDeployJob,
  setActiveDeployJobHost,
  reportDeployStage,
} from "../src/main/vellum/hosts/deploy-job-registry";

describe("percentFromStages", () => {
  it("maps known milestones", () => {
    expect(
      percentFromStages(
        ["endpoint ok", "signed artifact admitted version=1.0.0"],
        "running",
      ),
    ).toBe(20);
    expect(
      percentFromStages(
        ["first-install package 0.1.2 installed; custody present"],
        "running",
      ),
    ).toBe(55);
  });

  it("caps running below 100 and completes on success", () => {
    const stages = [
      "endpoint ok",
      "root-owned transaction abc committed operation=install",
      "systemd generation gen work control ready",
    ];
    expect(percentFromStages(stages, "running")).toBe(95);
    expect(percentFromStages(stages, "succeeded")).toBe(100);
  });
});

describe("deploy-job-registry", () => {
  it("tracks stages for active host and finishes terminal status", () => {
    const hostId = `test-host-${Date.now()}`;
    beginDeployJob(hostId);
    setActiveDeployJobHost(hostId);
    reportDeployStage("endpoint ok");
    appendDeployJobStage(hostId, "preflight ok");
    setActiveDeployJobHost(undefined);

    const mid = getDeployJob(hostId);
    expect(mid?.status).toBe("running");
    expect(mid?.stages).toContain("endpoint ok");
    expect(mid?.stages).toContain("preflight ok");
    expect(mid?.percent).toBeGreaterThanOrEqual(5);

    finishDeployJob(hostId, {
      status: "failed",
      detail: "release session failed: unit exit 70",
      stages: [...(mid?.stages ?? []), "adopt/release session error: unit exit 70"],
      recoveryHint: "repair-linux-release-transaction",
    });
    const done = getDeployJob(hostId);
    expect(done?.status).toBe("failed" satisfies HostDeployJobStatus);
    expect(done?.detail).toContain("exit 70");
    expect(done?.finishedAt).toBeDefined();
    expect(done?.recoveryHint).toBe("repair-linux-release-transaction");
  });
});

describe("fleet deploy chip", () => {
  it("labels a succeeded job Installed, not ready", () => {
    const panel = readFileSync(
      new URL(
        "../src/renderer/components/fleet/FleetDeployJobPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(panel).toContain('succeeded: "Installed"');
    expect(panel).not.toMatch(/succeeded:\s*"ready"/u);
    const nodes = readFileSync(
      new URL(
        "../src/renderer/components/fleet/FleetNodes.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(nodes).toContain("On the network");
    expect(nodes).not.toMatch(/return "Ready"/u);
  });
});
