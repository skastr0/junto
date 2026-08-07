import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static product-lock wiring for Task 4 (background continuity).
 * Does not replace canvas-quit-flush / herdr-detach / process-signal suites —
 * only asserts the new gate + windowless darwin stay beside them.
 */
describe("background continuity wiring", () => {
  const root = join(import.meta.dirname, "..");
  const indexSrc = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const terminationSrc = readFileSync(
    join(root, "src/main/vellum/process-signal-termination.ts"),
    "utf8",
  );

  it("macOS window-all-closed does not quit; non-darwin does", () => {
    const start = indexSrc.indexOf('app.on("window-all-closed"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = indexSrc.slice(start, indexSrc.indexOf("});", start) + 3);
    expect(block).toContain("quitWhenNoOperatorWindow()");
    const quit = indexSrc.slice(indexSrc.indexOf("const quitWhenNoOperatorWindow"));
    expect(quit).toMatch(/process\.platform\s*!==\s*["']darwin["']/);
    expect(quit).toMatch(/app\.quit\(\)/);
    // No unconditional quit on every platform.
    expect(block).not.toMatch(/app\.on\("window-all-closed",\s*\(\)\s*=>\s*\{\s*app\.quit/);
  });

  it("activate recreates the Command Center when only the hidden composition host remains", () => {
    expect(indexSrc).toMatch(
      /app\.on\("activate"[\s\S]*currentTrustedMainWindow\(\)\s*===\s*undefined[\s\S]*createWindow\(\)/,
    );
  });

  it("second-instance recreates or focuses only the trusted Command Center", () => {
    const start = indexSrc.indexOf('app.on("second-instance"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = indexSrc.slice(start, indexSrc.indexOf("});", start) + 3);
    expect(block).toContain("currentTrustedMainWindow()");
    expect(block).toMatch(/if\s*\(\s*!existing\s*\)/);
    expect(block).toMatch(/createWindow\(\)/);
    expect(block).toMatch(/headless/);
    expect(block).not.toContain("BrowserWindow.getAllWindows");
  });

  it("does not treat any BrowserWindow as an operator surface", () => {
    expect(indexSrc).not.toContain("BrowserWindow.getAllWindows");
    expect(indexSrc).toMatch(/candidate\.isDestroyed\(\)[\s\S]*trustedMainWindow\s*=\s*undefined/);
    expect(indexSrc).toMatch(/const recreateWindowIfEmpty[\s\S]*currentTrustedMainWindow\(\)\s*===\s*undefined/);
  });

  it("returns a closed Command Center to the hidden host while preserving Linux close semantics", () => {
    const closed = indexSrc.slice(
      indexSrc.indexOf('mainWindow.on("closed"'),
      indexSrc.indexOf("registerCrashRecovery(mainWindow)"),
    );
    expect(closed).toContain("browserCompositionHost.releaseVisibleWindow(mainWindow)");
    expect(closed).toContain("quitWhenNoOperatorWindow()");
  });

  it("before-quit gates on live work before final quiesce/detach (explicit quit only)", () => {
    const start = indexSrc.indexOf('app.on("before-quit"');
    const end = indexSrc.indexOf('app.on("will-quit"', start);
    const block = indexSrc.slice(start, end);
    const flushStart = indexSrc.indexOf("const flushCanvasOnQuit");
    const flushEnd = indexSrc.indexOf("let runtimeDetachedForQuit", flushStart);
    const flushBlock = indexSrc.slice(flushStart, flushEnd);
    expect(block).toMatch(/assessLiveWork|hasLiveWork|buildQuitConfirmPrompt/);
    expect(block).toMatch(/QUIT_CONFIRM_ACCEPT_INDEX|showMessageBox/);
    expect(block).toMatch(/runNormalQuitPreparation/);
    expect(block).toMatch(/finalRendererQuiesce[\s\S]*flushCanvasOnQuit/);
    expect(flushBlock).toMatch(/requestCanvasQuiesceAndFlush\(mainWindow\)/);
    expect(flushBlock).toMatch(/mainAuthoringGate\.close\(\)/);
    expect(block).toMatch(/detachRuntime[\s\S]*detachRuntimeOnQuit\("before-quit"\)/);

    // Sacred ordering is centralized in the normal-quit runner.
    const runnerStart = terminationSrc.indexOf("export const runNormalQuitPreparation");
    const runnerEnd = terminationSrc.indexOf("export const createSignalQuitState", runnerStart);
    const runner = terminationSrc.slice(runnerStart, runnerEnd);
    expect(runnerStart).toBeGreaterThanOrEqual(0);
    expect(runner.indexOf("steps.terminalClean()"))
      .toBeLessThan(runner.indexOf("steps.finalRendererQuiesce()"));
    expect(runner.indexOf("steps.finalRendererQuiesce()"))
      .toBeLessThan(runner.indexOf("arbiter.commitNormal(generation)"));
    expect(runner.indexOf("arbiter.commitNormal(generation)"))
      .toBeLessThan(runner.indexOf("steps.destroyRenderer()"));
    expect(runner.indexOf("steps.destroyRenderer()"))
      .toBeLessThan(runner.indexOf("steps.detachRuntime()"));
    expect(runner.indexOf("steps.detachRuntime()"))
      .toBeLessThan(runner.indexOf("steps.disposeRuntime()"));
  });

  it("signal / forced quit paths skip the confirm affordance", () => {
    expect(indexSrc).toMatch(/skipQuitConfirm|signalQuit|forceQuitWithoutConfirm/);
    const signalBlock = indexSrc.slice(indexSrc.indexOf("installProcessSignalTermination"));
    expect(signalBlock).toMatch(/skipQuitConfirm|signalQuit|forceQuitWithoutConfirm/);
  });

  it("skipQuitConfirm is consumed once and cleared on prep failure (not sticky)", () => {
    const start = indexSrc.indexOf('app.on("before-quit"');
    const end = indexSrc.indexOf('app.on("will-quit"', start);
    const block = indexSrc.slice(start, end);
    // Consume on force path.
    expect(block).toMatch(/skipQuitConfirm\s*=\s*false/);
    // Prep catch also clears sticky skip.
    const catchIdx = block.indexOf(
      'console.error("[canvas] quit blocked by canvas save failure:"',
    );
    expect(catchIdx).toBeGreaterThanOrEqual(0);
    expect(block.slice(0, catchIdx)).toMatch(/skipQuitConfirm\s*=\s*false/);
  });

  it("confirm dialog does not own quitPreparation (signals can supersede)", () => {
    const start = indexSrc.indexOf('app.on("before-quit"');
    const end = indexSrc.indexOf('app.on("will-quit"', start);
    const block = indexSrc.slice(start, end);
    // Dialog path must not assign quitPreparation = box
    expect(block).not.toMatch(/quitPreparation\s*=\s*box/);
    expect(block).toMatch(/quitConfirmGeneration|invalidateQuitConfirm/);
    expect(block).toMatch(/quitConfirmPending/);
    // Signal cleanup invalidates confirm.
    const signalBlock = indexSrc.slice(indexSrc.indexOf("installProcessSignalTermination"));
    expect(signalBlock).toMatch(/invalidateQuitConfirm|quitConfirmGeneration/);
  });

  it("cancel with zero windows recreates a surface", () => {
    expect(indexSrc).toMatch(/recreateWindowIfEmpty/);
    const start = indexSrc.indexOf('app.on("before-quit"');
    const end = indexSrc.indexOf('app.on("will-quit"', start);
    const block = indexSrc.slice(start, end);
    expect(block).toMatch(/recreateWindowIfEmpty\(\)/);
  });

  it("login item uses Electron get/setLoginItemSettings (no silent enrollment)", () => {
    const loginSrc = readFileSync(join(root, "src/main/vellum/login-item.ts"), "utf8");
    expect(loginSrc).toMatch(/getLoginItemSettings/);
    expect(loginSrc).toMatch(/setLoginItemSettings/);
    expect(loginSrc).toMatch(/openAtLogin/);
    // set only via explicit helper, not at import/boot
    expect(loginSrc).not.toMatch(/setLoginItemOpenAtLogin\([^)]+,\s*true\)/);
  });
});
