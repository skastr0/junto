import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_RUNTIME_REMEDY_STAGE,
  copyProgressLabel,
  formatDeployBytes,
  mergeDeployJobStages,
  percentFromDeployProgress,
  percentFromStages,
  type HostDeployJobStatus,
} from "../src/shared/deploy-job";
import {
  appendDeployJobStage,
  beginDeployJob,
  finishDeployJob,
  getDeployJob,
  setActiveDeployJobHost,
  reportDeployCopyProgress,
  reportDeployStage,
} from "../src/main/vellum/hosts/deploy-job-registry";
import { estimateDirectoryBytes } from "../src/main/vellum/hosts/deploy-copy-stream";

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
    expect(
      percentFromStages([HOST_RUNTIME_REMEDY_STAGE.copy], "running"),
    ).toBe(40);
    expect(
      percentFromStages([HOST_RUNTIME_REMEDY_STAGE.wait], "running"),
    ).toBe(90);
  });

  it("fills the copy milestone from live bytes", () => {
    const stages = [HOST_RUNTIME_REMEDY_STAGE.copy];
    expect(percentFromDeployProgress(stages, "running")).toBe(40);
    expect(
      percentFromDeployProgress(stages, "running", {
        bytesSent: 0,
        bytesTotal: 100,
        startedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    ).toBe(40);
    expect(
      percentFromDeployProgress(stages, "running", {
        bytesSent: 50,
        bytesTotal: 100,
        startedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:01.000Z",
      }),
    ).toBe(47);
    expect(
      percentFromDeployProgress(stages, "running", {
        bytesSent: 100,
        bytesTotal: 100,
        startedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:02.000Z",
        payloadComplete: true,
      }),
    ).toBe(54);
    expect(
      percentFromDeployProgress(
        [HOST_RUNTIME_REMEDY_STAGE.copy, HOST_RUNTIME_REMEDY_STAGE.sign],
        "running",
        {
          bytesSent: 100,
          bytesTotal: 100,
          startedAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:02.000Z",
          payloadComplete: true,
        },
      ),
    ).toBe(58);
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

describe("mergeDeployJobStages", () => {
  it("keeps live remedy stages in front of package receipts", () => {
    expect(
      mergeDeployJobStages(
        [
          "deploy accepted — running in Command Center main process",
          HOST_RUNTIME_REMEDY_STAGE.copy,
          HOST_RUNTIME_REMEDY_STAGE.restart,
        ],
        ["endpoint ok", HOST_RUNTIME_REMEDY_STAGE.copy],
      ),
    ).toEqual([
      "deploy accepted — running in Command Center main process",
      HOST_RUNTIME_REMEDY_STAGE.copy,
      HOST_RUNTIME_REMEDY_STAGE.restart,
      "endpoint ok",
    ]);
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

  it("keeps live remedy stages when finish supplies package stages", () => {
    const hostId = `merge-host-${Date.now()}`;
    beginDeployJob(hostId);
    setActiveDeployJobHost(hostId);
    reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.copy);
    reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.sign);
    reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.restart);
    reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.wait);
    setActiveDeployJobHost(undefined);
    finishDeployJob(hostId, {
      status: "succeeded",
      detail: "installed",
      stages: ["endpoint ok", "ssh warm ok"],
    });
    const done = getDeployJob(hostId);
    expect(done?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.copy);
    expect(done?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.sign);
    expect(done?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.restart);
    expect(done?.stages).toContain(HOST_RUNTIME_REMEDY_STAGE.wait);
    expect(done?.stages).toContain("endpoint ok");
  });
});

describe("copy progress copy", () => {
  it("formats bytes and names a finished payload as installing", () => {
    expect(formatDeployBytes(900)).toBe("900 B");
    expect(formatDeployBytes(1536)).toBe("1.5 KB");
    expect(formatDeployBytes(10 * 1024 * 1024)).toBe("10 MB");
    const startedAt = new Date(0).toISOString();
    expect(
      copyProgressLabel(
        {
          bytesSent: 50 * 1024 * 1024,
          bytesTotal: 100 * 1024 * 1024,
          startedAt,
          updatedAt: new Date(10_000).toISOString(),
        },
        10_000,
      ),
    ).toBe("50 MB / 100 MB — 5.0 MB/s — about 10s left");
    expect(
      copyProgressLabel(
        {
          bytesSent: 100 * 1024 * 1024,
          bytesTotal: 100 * 1024 * 1024,
          startedAt,
          updatedAt: new Date(10_000).toISOString(),
          payloadComplete: true,
        },
        10_000,
      ),
    ).toBe("100 MB copied — installing on the Remote");
  });

  it("estimates a local tree without following symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-du-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "a.bin"), Buffer.alloc(2048));
    writeFileSync(join(root, "b.bin"), Buffer.alloc(512));
    expect(estimateDirectoryBytes(root)).toBe(2560);
  });
});

describe("deploy-job-registry copy", () => {
  it("publishes live copy bytes onto the active job", () => {
    const hostId = `copy-host-${Date.now()}`;
    beginDeployJob(hostId);
    setActiveDeployJobHost(hostId);
    reportDeployStage(HOST_RUNTIME_REMEDY_STAGE.copy);
    reportDeployCopyProgress({
      bytesSent: 20,
      bytesTotal: 100,
      startedAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
    });
    const mid = getDeployJob(hostId);
    expect(mid?.copy?.bytesSent).toBe(20);
    expect(mid?.copy?.bytesTotal).toBe(100);
    expect(mid?.percent).toBeGreaterThanOrEqual(40);
    expect(mid?.percent).toBeLessThan(55);
    setActiveDeployJobHost(undefined);
    finishDeployJob(hostId, { status: "succeeded", detail: "installed" });
    expect(getDeployJob(hostId)?.copy).toBeUndefined();
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
    expect(panel).toContain("fleet-deploy-job__copy");
    expect(panel).toContain("copyProgressLabel");
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
    const detail = readFileSync(
      new URL(
        "../src/renderer/components/fleet/FleetDetailPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(detail).toContain("On the network is SSH");
    expect(detail).toContain("A finished Deploy is Installed");
    expect(detail).toContain(
      "On the network — Vellum Command is not answering",
    );
    expect(nodes).toContain(
      "On the network — Vellum Command is not answering",
    );
  });
});
