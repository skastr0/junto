import { describe, expect, it } from "vitest";
import {
  REMOTE_UPDATE_IDLE_PRODUCT_COPY,
  REMOTE_UPDATE_STATUS_LABEL,
  decodeRemoteUpdateStatus,
  deriveRemoteUpdateStatus,
  remoteUpdatePhaseFromDeployJob,
  remoteUpdateStatusLabel,
  resolveRemoteAvailableForStatus,
  shouldAutoWalkRemoteUpdate,
} from "../src/shared/remote-update-status";

describe("remote update status schema", () => {
  it("decodes a strict fleet row", () => {
    expect(
      decodeRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
        updateStatus: "update-available",
      }),
    ).toEqual({
      installedVersion: "0.1.0",
      availableVersion: "0.1.1",
      updateStatus: "update-available",
    });
  });

  it("refuses unknown status or excess properties", () => {
    expect(
      decodeRemoteUpdateStatus({
        updateStatus: "mystery",
      }),
    ).toBeUndefined();
    expect(
      decodeRemoteUpdateStatus({
        updateStatus: "up-to-date",
        extra: true,
      }),
    ).toBeUndefined();
  });

  it("maps every status kind to the product label", () => {
    expect(remoteUpdateStatusLabel("up-to-date")).toBe("Up to date");
    expect(remoteUpdateStatusLabel("update-available")).toBe(
      "Update available",
    );
    expect(remoteUpdateStatusLabel("waiting-for-idle")).toBe(
      "Waiting for idle",
    );
    expect(remoteUpdateStatusLabel("downloading")).toBe("Downloading");
    expect(remoteUpdateStatusLabel("installing")).toBe("Installing");
    expect(remoteUpdateStatusLabel("restarting")).toBe("Restarting");
    expect(remoteUpdateStatusLabel("updated")).toBe("Updated");
    expect(remoteUpdateStatusLabel("failed-retry")).toBe("Failed — Retry");
    expect(Object.keys(REMOTE_UPDATE_STATUS_LABEL)).toHaveLength(8);
  });
});

describe("shouldAutoWalkRemoteUpdate", () => {
  it("requires operator toggle and exact CC version match", () => {
    expect(
      shouldAutoWalkRemoteUpdate({
        availableRemoteReleaseVersion: "0.1.0",
        commandCenterVersion: "0.1.0",
        remoteManagedInstalls: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoWalkRemoteUpdate({
        availableRemoteReleaseVersion: "0.1.0",
        commandCenterVersion: "0.1.0",
        remoteManagedInstalls: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoWalkRemoteUpdate({
        availableRemoteReleaseVersion: "0.2.0",
        commandCenterVersion: "0.1.0",
        remoteManagedInstalls: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoWalkRemoteUpdate({
        availableRemoteReleaseVersion: undefined,
        commandCenterVersion: "0.1.0",
        remoteManagedInstalls: true,
      }),
    ).toBe(false);
  });
});

describe("resolveRemoteAvailableForStatus", () => {
  it("compares against CC while feed waits (CC-first)", () => {
    expect(
      resolveRemoteAvailableForStatus({
        feedVersion: "0.2.0",
        commandCenterVersion: "0.1.0",
      }),
    ).toEqual({
      feedVersion: "0.2.0",
      feedAhead: true,
      availableForStatus: "0.1.0",
      availableRemoteReleaseVersion: undefined,
    });
    // Lagging Remote vs CC still surfaces update-available while feed waits.
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.0.9",
        availableVersion: resolveRemoteAvailableForStatus({
          feedVersion: "0.2.0",
          commandCenterVersion: "0.1.0",
        }).availableForStatus,
      }).updateStatus,
    ).toBe("update-available");
  });

  it("uses feed when it matches CC, else falls back to CC", () => {
    expect(
      resolveRemoteAvailableForStatus({
        feedVersion: "0.1.0",
        commandCenterVersion: "0.1.0",
      }),
    ).toEqual({
      feedVersion: "0.1.0",
      feedAhead: false,
      availableForStatus: "0.1.0",
      availableRemoteReleaseVersion: "0.1.0",
    });
    expect(
      resolveRemoteAvailableForStatus({
        commandCenterVersion: "0.1.0",
      }),
    ).toEqual({
      feedVersion: undefined,
      feedAhead: false,
      availableForStatus: "0.1.0",
      availableRemoteReleaseVersion: "0.1.0",
    });
  });
});

describe("remoteUpdatePhaseFromDeployJob", () => {
  it("returns no phase without a job", () => {
    expect(
      remoteUpdatePhaseFromDeployJob({ job: undefined, availableVersion: "0.1.1" }),
    ).toBeUndefined();
    expect(remoteUpdatePhaseFromDeployJob({ job: null })).toBeUndefined();
  });

  it("projects a running job into downloading, restarting, or installing", () => {
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: {
          status: "running",
          stages: ["Copying Junto"],
          copy: { payloadComplete: false },
        },
      }),
    ).toEqual({ kind: "downloading" });
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: {
          status: "running",
          stages: ["Remote runtime relaunch admitted for /home/x"],
          copy: { payloadComplete: true },
        },
      }),
    ).toEqual({ kind: "restarting" });
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "running", stages: ["configure remote"] },
      }),
    ).toEqual({ kind: "installing" });
  });

  it("maps the close-active-junto-terminals refusal to waiting-for-idle", () => {
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: {
          status: "failed",
          stages: [],
          recoveryHint: "close-active-junto-terminals",
        },
        availableVersion: "0.1.1",
      }),
    ).toEqual({ kind: "waiting-for-idle" });
  });

  it("maps finished jobs to updated or failed", () => {
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "succeeded", stages: [], version: "0.1.1" },
        availableVersion: "0.1.1",
      }),
    ).toEqual({ kind: "updated" });
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "failed", stages: [] },
        availableVersion: "0.1.1",
      }),
    ).toEqual({ kind: "failed" });
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "auth_required", stages: [] },
      }),
    ).toEqual({ kind: "failed" });
  });

  it("never lets a stale finished job speak for a newer release", () => {
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "succeeded", stages: [], version: "0.1.0" },
        availableVersion: "0.1.1",
      }),
    ).toBeUndefined();
    expect(
      remoteUpdatePhaseFromDeployJob({
        job: { status: "failed", stages: [], version: "0.1.0" },
        availableVersion: "0.1.1",
      }),
    ).toBeUndefined();
  });
});

describe("phase derivation", () => {
  it("derives version comparison when phase is quiet", () => {
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.0",
      }).updateStatus,
    ).toBe("up-to-date");
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
      }).updateStatus,
    ).toBe("update-available");
    // Incomplete pair: helper keeps closed-set default; UI shows "unknown"
    // when installedVersion is absent (do not claim product parity).
    expect(
      deriveRemoteUpdateStatus({
        availableVersion: "0.1.0",
      }),
    ).toEqual({
      availableVersion: "0.1.0",
      updateStatus: "up-to-date",
    });
    expect(
      deriveRemoteUpdateStatus({
        availableVersion: "0.1.0",
      }).installedVersion,
    ).toBeUndefined();
  });

  it("lets live phase override version comparison", () => {
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
        phase: { kind: "installing" },
      }).updateStatus,
    ).toBe("installing");
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
        phase: { kind: "waiting-for-idle", activeTerminalSessions: 2 },
      }),
    ).toEqual({
      installedVersion: "0.1.0",
      availableVersion: "0.1.1",
      updateStatus: "waiting-for-idle",
    });
    // The real deploy job pipeline reaches every phase state end to end.
    expect(
      deriveRemoteUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
        phase: remoteUpdatePhaseFromDeployJob({
          job: {
            status: "failed",
            stages: [],
            recoveryHint: "close-active-junto-terminals",
          },
          availableVersion: "0.1.1",
        }),
      }).updateStatus,
    ).toBe("waiting-for-idle");
  });

  it("ships the product idle copy for busy remotes", () => {
    expect(REMOTE_UPDATE_IDLE_PRODUCT_COPY).toContain(
      "never force-closes an active Remote terminal",
    );
    expect(REMOTE_UPDATE_IDLE_PRODUCT_COPY).toContain(
      "wait until their terminal sessions have ended",
    );
  });
});
