import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser startup recovery gate", () => {
  const root = join(import.meta.dirname, "..");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const browserIpcSrc = readFileSync(
    join(root, "src/main/vellum/browser/ipc.ts"),
    "utf8",
  );
  const vellumIpcSrc = readFileSync(join(root, "src/main/vellum/ipc.ts"), "utf8");

  it("keeps browser handlers inside the post-recovery activation boundary", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const composition = ready.indexOf("startBrowserComposition(");
    const activation = ready.indexOf("async (composition) =>", composition);
    const control = ready.indexOf("startBrowserControlServer(", activation);
    const agentIpc = ready.indexOf("registerBrowserAgentIpc(", activation);
    const browserIpc = ready.indexOf("registerBrowserIpcHandlers(", activation);
    const window = ready.indexOf("if (!headless) createWindow()", composition);

    expect(composition).toBeGreaterThanOrEqual(0);
    expect(activation).toBeGreaterThan(composition);
    expect(control).toBeGreaterThan(activation);
    expect(agentIpc).toBeGreaterThan(control);
    expect(browserIpc).toBeGreaterThan(agentIpc);
    expect(window).toBeGreaterThan(browserIpc);
    expect(ready.slice(composition, window)).not.toContain("session.fromPartition");
  });

  it("preserves non-browser IPC before recovery without registering browser IPC", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    expect(ready.indexOf("registerIpcHandlers();")).toBeLessThan(
      ready.indexOf("startBrowserComposition("),
    );
    const ordinaryVellumIpc = vellumIpcSrc.slice(
      vellumIpcSrc.indexOf("export const registerVellumIpc"),
      vellumIpcSrc.indexOf("export const registerVellumBrowserIpc"),
    );
    expect(ordinaryVellumIpc).not.toContain("registerBrowserIpc(");
  });

  it("has no eager session singleton and requires injected recovered sessions", () => {
    expect(browserIpcSrc).not.toMatch(/new BrowserSessionService/);
    expect(browserIpcSrc).not.toContain("electronViewAdapter");
    expect(browserIpcSrc).toMatch(
      /registerBrowserIpc = \([\s\S]*browserSessions: BrowserSessionService/,
    );
  });

  it("exits nonzero with the fixed diagnostic and no window on startup failure", () => {
    const ready = indexSrc.slice(indexSrc.indexOf("app.whenReady().then"));
    const failure = ready.slice(
      ready.indexOf("} catch {", ready.indexOf("startBrowserComposition(")),
      ready.indexOf("if (!headless) createWindow()"),
    );
    expect(failure).toContain("BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE");
    expect(failure).toContain(
      'exitAfterDetach(1, "browser-composition-startup-failure")',
    );
    expect(failure).toMatch(
      /exitAfterDetach\(1, "browser-composition-startup-failure"\);\s*return;/,
    );
    expect(failure).not.toContain("createWindow(");
  });
});
