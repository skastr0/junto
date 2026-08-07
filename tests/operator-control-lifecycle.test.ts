import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATOR_CONTROL_SWITCH,
  operatorControlEnabledFromInitialArgv,
} from "../src/main/vellum/operator-control";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(import.meta.dirname, "..", "src/main/index.ts"),
  "utf8",
);

describe("operator control main lifecycle", () => {
  it("enables only from the frozen initial argv", () => {
    expect(
      operatorControlEnabledFromInitialArgv(
        ["vellum-command", OPERATOR_CONTROL_SWITCH],
      ),
    ).toBe(true);
    expect(operatorControlEnabledFromInitialArgv(["vellum-command"])).toBe(false);

    const freeze = source.indexOf("const operatorControlEnabledAtLaunch =");
    const singleton = source.indexOf("app.requestSingleInstanceLock()");
    expect(freeze).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeLessThan(singleton);
    const secondInstanceStart = source.indexOf('app.on("second-instance"');
    const secondInstanceEnd = source.indexOf(
      'app.on("activate"',
      secondInstanceStart,
    );
    const secondInstance = source.slice(secondInstanceStart, secondInstanceEnd);
    expect(secondInstance).not.toContain("operatorControl");
    expect(secondInstance).not.toContain(OPERATOR_CONTROL_SWITCH);
  });

  it("opens explicit bootstrap before the unconfigured headless return", () => {
    const coordinatorStart = source.indexOf(
      "const coordinator = makeOperatorCoordinator",
    );
    const operatorStart = source.indexOf(
      "operatorControl = await startOperatorControlServer",
    );
    const bootstrapReturn = source.indexOf(
      "stationConfiguration === undefined",
      operatorStart,
    );
    expect(coordinatorStart).toBeGreaterThanOrEqual(0);
    expect(operatorStart).toBeGreaterThanOrEqual(0);
    expect(operatorStart).toBeLessThan(bootstrapReturn);
    expect(source.slice(coordinatorStart, bootstrapReturn)).toContain(
      "fleetReady:",
    );
  });

  it("cuts operator admission on hard denial and ordinary shutdown", () => {
    const hardStart = source.indexOf(
      "const suspendProductRuntimeForLicenseRevocation",
    );
    const hardEnd = source.indexOf("const enterLicenseMaintenance", hardStart);
    const hardDenial = source.slice(hardStart, hardEnd);
    expect(hardDenial).toContain("operatorFleetReady = false");
    expect(hardDenial).toContain("operatorControl?.beginShutdown()");

    const shutdownStart = source.indexOf("const beginShutdownAdmission");
    const shutdownEnd = source.indexOf(
      "const logUnfinishedDrain",
      shutdownStart,
    );
    const shutdown = source.slice(shutdownStart, shutdownEnd);
    expect(shutdown).toContain("operatorFleetReady = false");
    expect(shutdown).toContain("operatorControl?.beginShutdown()");
    expect(shutdown.indexOf("operatorControl?.beginShutdown()")).toBeLessThan(
      shutdown.indexOf("hostOperationsShutdown.beginShutdown()"),
    );
  });

  it("drains the operator listener before runtime and host teardown", () => {
    const drainStart = source.indexOf("const drainRuntimeOnQuit");
    const drainEnd = source.indexOf("const disposeRuntime", drainStart);
    const drain = source.slice(drainStart, drainEnd);
    expect(drain).toContain("await requireCleanOperatorControlShutdown()");
    expect(drain.indexOf("requireCleanOperatorControlShutdown")).toBeLessThan(
      drain.indexOf("requireCleanHostOperationsShutdown"),
    );

    const disposeStart = source.indexOf("const disposeRuntime =");
    const disposeEnd = source.indexOf(
      "const disposeRuntimeFailClosed",
      disposeStart,
    );
    expect(source.slice(disposeStart, disposeEnd)).toContain(
      ".then(() => AppRuntime.dispose())",
    );
  });
});
