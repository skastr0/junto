import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLEET_UI_ENABLED } from "../src/shared/features";
import { SHIP_FEATURES } from "../src/shared/feature-catalog";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";

describe("Fleet product gate", () => {
  it("keeps Fleet UI off in the ship catalog", () => {
    expect(SHIP_FEATURES.fleetUi).toBe(false);
  });

  it("freezes packaged darwin enroll/deploy", () => {
    expect(RELEASE_CAPABILITIES.freshRemoteEnrollment).toBe(false);
    expect(RELEASE_CAPABILITIES.managedRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.darwinRemoteDeploy).toBe(false);
  });

  it("gates main hosts IPC, fleet start, overlay import, preload, CLI, and remote occupy", () => {
    const ipc = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
    const app = readFileSync("src/renderer/App.tsx", "utf8");
    const fleetState = readFileSync("src/renderer/lib/fleet-state.ts", "utf8");
    const preload = readFileSync("src/preload/index.ts", "utf8");
    const cli = readFileSync("src/cli/main.ts", "utf8");
    const coordinator = readFileSync(
      "src/main/vellum-command/hosts/operator-coordinator.ts",
      "utf8",
    );
    const router = readFileSync("src/main/vellum-command/term/router.ts", "utf8");
    const doctor = readFileSync("src/main/vellum-command/hosts/doctor.ts", "utf8");
    const settings = readFileSync(
      "src/main/vellum-command/settings/service.ts",
      "utf8",
    );

    expect(ipc).toContain("if (FLEET_UI_ENABLED) {\n    registerHostsIpc(privilegedIpc);");
    expect(ipc).toContain(
      "if (FLEET_UI_ENABLED && stationForSeed.station.role === \"command-center\")",
    );
    expect(app).toContain(
      "const FleetOverlay = __VELLUM_COMMAND_FLEET_UI_ENABLED__",
    );
    expect(fleetState).toContain(
      "if (!__VELLUM_COMMAND_FLEET_UI_ENABLED__) return;",
    );
    expect(preload).toContain("...(FLEET_UI_ENABLED ? hostsApi : {})");
    expect(cli).toContain('dispatch.args[0] === "fleet"');
    expect(coordinator).toContain("if (!FLEET_UI_ENABLED)");
    expect(router).toContain("if (!FLEET_UI_ENABLED)");
    expect(doctor).toContain("const remoteHosts = FLEET_UI_ENABLED");
    expect(settings).toContain("ensureDefaultCommandCenter");
  });

  it.runIf(!FLEET_UI_ENABLED)(
    "does not open or prefetch fleet UI while disabled",
    async () => {
      const { state$ } = await import("../src/renderer/lib/state");
      const { openFleet, prefetchFleetChunk } = await import(
        "../src/renderer/lib/fleet-state"
      );
      state$.fleetOpen.set(false);
      prefetchFleetChunk();
      openFleet();
      expect(state$.fleetOpen.peek()).toBe(false);
    },
  );
});
