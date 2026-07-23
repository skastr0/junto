import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("index shutdown wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("routes packaged startup through the selected bounded supervisor", () => {
    expect(source).toContain('import { loadStationSupervisor } from "./vellum/supervision/select";');
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
});
