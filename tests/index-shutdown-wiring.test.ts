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

  it("cuts admission before any main drain, and drains only what main runs", () => {
    const start = source.indexOf("const beginShutdownAdmission");
    const end = source.indexOf("const logUnfinishedDrain", start);
    const block = source.slice(start, end);
    const admissionCut = block.indexOf("shutdownAdmissionClosed = true");

    expect(admissionCut).toBeGreaterThanOrEqual(0);
    for (const teardown of [
      "browserComposition?.drainOnQuit(reason)",
      "hostOperationsShutdown.beginShutdown()",
      "appProcessPlane.beginShutdown()",
    ]) {
      expect(admissionCut).toBeLessThan(block.indexOf(teardown));
    }
    // The core's servers (operator control, the machine link, work control,
    // canvas control, the kernel, the terminal plane) are drained in the core
    // as it stops; main names none of them, so none is left holding a copy.
    for (const gone of [
      "termPlane",
      "kernelService",
      "machineLinkListener",
      "workControl",
      "canvasControl",
      "operatorControl",
      "overseerComposition",
    ]) {
      expect(source).not.toMatch(new RegExp(`\\b${gone}\\b`, "u"));
    }
  });
});
