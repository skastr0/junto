import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("index shutdown wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("routes launchd supervision through the bounded launchctl runner", () => {
    expect(source).toContain("launchAgentTargetForCurrentUser()");
    expect(source).toContain("printLaunchAgent(target)");
    expect(source).toContain("kickstartLaunchAgent(target)");
    expect(source).not.toContain('execFile("/bin/launchctl"');
  });

  it("binds browser control shutdown into the browser composition", () => {
    const start = source.indexOf("browserComposition = await startBrowserComposition(");
    const end = source.indexOf("if (!headless) createWindow();", start);
    const block = source.slice(start, end);

    expect(block).toContain("browserControl = await startBrowserControlServer(");
    expect(block).toContain("composition.bindControlShutdown(browserControl)");
  });
});
