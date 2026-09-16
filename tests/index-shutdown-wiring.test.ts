import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("index shutdown wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("routes packaged startup through the selected bounded supervisor", () => {
    expect(source).toContain('import { loadStationSupervisor } from "./junto/supervision/select";');
    expect(source).toContain("const supervisor = await loadStationSupervisor();");
    expect(source).toContain("const handoff = await supervisor.requestHandoff();");
    expect(source).not.toContain("kickstartLaunchAgent(");
  });

  it("binds browser control shutdown into the browser composition", () => {
    const start = source.indexOf("browserComposition = await startBrowserComposition(");
    const end = source.indexOf("if (!headless) createWindow();", start);
    const block = source.slice(start, end);

    expect(block).toContain("browserControl = await startBrowserControlServer(");
    expect(block).toContain("composition.bindControlShutdown(browserControl)");
  });

  it("suspends kernel admission before normal product teardown begins", () => {
    const start = source.indexOf("const beginShutdownAdmission");
    const end = source.indexOf("const logUnfinishedDrain", start);
    const block = source.slice(start, end);
    const admissionCut = block.indexOf("shutdownAdmissionClosed = true");
    const kernelCut = block.indexOf("kernelService?.suspend()");

    expect(admissionCut).toBeGreaterThanOrEqual(0);
    expect(kernelCut).toBeGreaterThan(admissionCut);
    for (const teardown of [
      "browserComposition?.drainOnQuit(reason)",
      "beginStationFleetPropagationShutdown()",
      "workControl?.beginShutdown()",
      "stationControl?.beginShutdown()",
      "hostOperationsShutdown.beginShutdown()",
      "termPlane.beginShutdown(reason)",
      "appProcessPlane.beginShutdown()",
    ]) {
      expect(kernelCut).toBeLessThan(block.indexOf(teardown));
    }
  });
});
