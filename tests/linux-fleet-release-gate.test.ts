import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeDeployCapabilities } from "../src/shared/deploy-capabilities";
import {
  BOX_FLEET_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
  resolveReleaseCapabilities,
} from "../src/shared/release-capabilities";

/**
 * Narrow production gates for the macOS-only managed-host release surface.
 * Does not mock RELEASE_CAPABILITIES — these are the ship defaults.
 */
describe("linux fleet release gate (production defaults)", () => {
  it("defaults freeze Linux deploy and Box fleet", () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.boxFleet).toBe(false);
    expect(RELEASE_CAPABILITIES.darwinRemoteDeploy).toBe(false);
  });

  it("computeDeployCapabilities refuses Linux targets (pure formula)", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "linux",
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toBe(MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL);
    expect(caps.effective.boxFleet).toBe(false);
    expect(caps.detail.boxFleet).toBe(BOX_FLEET_DISABLED_DETAIL);
  });

  it("packaged builds ignore the dev Linux re-enable env path", () => {
    const caps = resolveReleaseCapabilities({
      packaged: true,
      enableLinuxFleet: true,
    });
    expect(caps.linuxRemoteDeploy).toBe(false);
    expect(caps.boxFleet).toBe(false);
  });

  it("unpackaged explicit override re-opens Linux and Box for local work", () => {
    const caps = resolveReleaseCapabilities({
      packaged: false,
      enableLinuxFleet: true,
    });
    expect(caps.linuxRemoteDeploy).toBe(true);
    expect(caps.boxFleet).toBe(true);
  });

  it("Fleet machine gate closes Configure and Deploy, not only the Deploy button", () => {
    const source = readFileSync(
      new URL(
        "../src/renderer/components/fleet/FleetDetailPanel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("machineMutateEnabled");
    expect(source).toContain('kind === "configure" && !machineMutateEnabled');
    expect(source).toContain("|| !machineMutateEnabled");
    expect(source).toContain("Linux Remotes stay enrolled/read-only");
  });
});
