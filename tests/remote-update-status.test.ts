import { describe, expect, it } from "vitest";
import {
  REMOTE_UPDATE_IDLE_PRODUCT_COPY,
  REMOTE_UPDATE_STATUS_LABEL,
  decodeRemoteUpdateStatus,
  deriveRemoteUpdateStatus,
  mapIdleGateToUpdateStatus,
  remoteUpdateStatusLabel,
  shouldAutoWalkRemoteUpdate,
  waitingForIdleUpdateStatus,
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

describe("idle gate and phase derivation", () => {
  it("maps active terminal sessions to waiting-for-idle only", () => {
    expect(mapIdleGateToUpdateStatus("active-terminal-sessions")).toBe(
      "waiting-for-idle",
    );
    expect(mapIdleGateToUpdateStatus("maintenance-held")).toBe("failed-retry");
    expect(mapIdleGateToUpdateStatus("shutting-down")).toBe("failed-retry");
  });

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
      waitingForIdleUpdateStatus({
        installedVersion: "0.1.0",
        availableVersion: "0.1.1",
        activeTerminalSessions: 2,
      }),
    ).toEqual({
      installedVersion: "0.1.0",
      availableVersion: "0.1.1",
      updateStatus: "waiting-for-idle",
    });
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
