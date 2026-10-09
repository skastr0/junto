import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIP_FEATURES } from "../src/shared/feature-catalog";

describe("Fleet product gate", () => {
  it("keeps Fleet UI off in the ship catalog", () => {
    expect(SHIP_FEATURES.fleetUi).toBe(false);
  });

  it("gates main hosts IPC, overlay import, preload, and remote occupy, with no fleet CLI or operator op", () => {
    const ipc = readFileSync("src/main/junto/ipc.ts", "utf8");
    const app = readFileSync("src/renderer/App.tsx", "utf8");
    const machinesWindow = readFileSync("src/renderer/lib/machines-window.ts", "utf8");
    const preload = readFileSync("src/preload/index.ts", "utf8");
    const cli = readFileSync("src/cli/main.ts", "utf8");
    const coordinator = readFileSync(
      "src/main/junto/hosts/operator-coordinator.ts",
      "utf8",
    );
    const router = readFileSync("src/main/junto/term/router.ts", "utf8");
    const doctor = readFileSync("src/main/junto/hosts/doctor.ts", "utf8");

    expect(ipc).toContain("if (FLEET_UI_ENABLED) {\n    registerHostsIpc(privilegedIpc);");
    // Remote stations are switched off: the fleet supervisor is never started.
    expect(ipc).not.toContain("fleetPropagation.start()");
    expect(ipc).not.toContain("startLiveFleetUpdateExecutor");
    expect(app).toContain(
      "const MachinesWindow = __JUNTO_FLEET_UI_ENABLED__",
    );
    expect(machinesWindow).toContain(
      "if (!__JUNTO_FLEET_UI_ENABLED__) return;",
    );
    expect(preload).toContain("...(FLEET_UI_ENABLED ? hostsApi : {})");
    // The fleet CLI group, the operator's fleet ops and the fleet doctor are gone.
    expect(cli).not.toMatch(/fleet/iu);
    expect(coordinator).not.toMatch(/fleet/iu);
    expect(doctor).not.toMatch(/fleet/iu);
    expect(router).toContain("if (!FLEET_UI_ENABLED)");
  });
});
