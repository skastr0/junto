import { describe, expect, it } from "vitest";
import {
  planFleetRemoteUpdates,
  remotesMayReceiveFeedVersion,
  sequentialAutoDeployHostIds,
} from "../src/main/junto/update/fleet-reconciler";

describe("planFleetRemoteUpdates", () => {
  it("requires CC version match and operator toggle for auto-walk", () => {
    const plan = planFleetRemoteUpdates({
      commandCenterVersion: "0.1.1",
      availableReleaseVersion: "0.1.1",
      remoteManagedInstalls: true,
      remotes: [
        {
          hostId: "mac-a",
          platform: "darwin",
          installedVersion: "0.1.0",
        },
        {
          hostId: "busy",
          platform: "darwin",
          installedVersion: "0.1.0",
          phase: { kind: "waiting-for-idle", activeTerminalSessions: 1 },
        },
        {
          hostId: "current",
          platform: "linux",
          installedVersion: "0.1.1",
        },
      ],
    });
    expect(plan.autoWalk).toBe(true);
    expect(sequentialAutoDeployHostIds(plan)).toEqual(["mac-a"]);
    expect(plan.items.find((i) => i.hostId === "busy")?.eligibleForAutoDeploy).toBe(
      false,
    );
    expect(plan.items.find((i) => i.hostId === "current")?.status.updateStatus).toBe(
      "up-to-date",
    );
  });

  it("blocks Remote walk when feed is ahead of running CC", () => {
    expect(
      remotesMayReceiveFeedVersion({
        commandCenterVersion: "0.1.0",
        availableReleaseVersion: "0.1.1",
      }),
    ).toBe(false);
    const plan = planFleetRemoteUpdates({
      commandCenterVersion: "0.1.0",
      availableReleaseVersion: "0.1.1",
      remoteManagedInstalls: true,
      remotes: [
        {
          hostId: "mac-a",
          platform: "darwin",
          installedVersion: "0.1.0",
        },
      ],
    });
    expect(plan.autoWalk).toBe(false);
    expect(sequentialAutoDeployHostIds(plan)).toEqual([]);
  });

  it("respects remoteManagedInstalls off", () => {
    const plan = planFleetRemoteUpdates({
      commandCenterVersion: "0.1.1",
      availableReleaseVersion: "0.1.1",
      remoteManagedInstalls: false,
      remotes: [
        {
          hostId: "mac-a",
          platform: "darwin",
          installedVersion: "0.1.0",
        },
      ],
    });
    expect(plan.autoWalk).toBe(false);
    expect(plan.items[0]?.status.updateStatus).toBe("update-available");
    expect(sequentialAutoDeployHostIds(plan)).toEqual([]);
  });
});
