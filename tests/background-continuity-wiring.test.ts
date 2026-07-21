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

  it("macOS window-all-closed does not quit; non-darwin does", () => {
    const start = indexSrc.indexOf('app.on("window-all-closed"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = indexSrc.slice(start, indexSrc.indexOf("});", start) + 3);
    expect(block).toMatch(/process\.platform\s*!==\s*["']darwin["']/);
    expect(block).toMatch(/app\.quit\(\)/);
    // No unconditional quit on every platform.
    expect(block).not.toMatch(/app\.on\("window-all-closed",\s*\(\)\s*=>\s*\{\s*app\.quit/);
  });

  it("activate recreates the window when none remain (non-headless)", () => {
    expect(indexSrc).toMatch(
      /app\.on\("activate"[\s\S]*BrowserWindow\.getAllWindows\(\)\.length\s*===\s*0[\s\S]*createWindow\(\)/,
    );
  });

  it("second-instance recreates the window when the factory is windowless", () => {
    const start = indexSrc.indexOf('app.on("second-instance"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = indexSrc.slice(start, indexSrc.indexOf("});", start) + 3);
    expect(block).toMatch(/if\s*\(\s*!existing\s*\)/);
    expect(block).toMatch(/createWindow\(\)/);
    expect(block).toMatch(/headless/);
  });

  it("before-quit gates on live work before flush/detach (explicit quit only)", () => {
    const start = indexSrc.indexOf('app.on("before-quit"');
    const end = indexSrc.indexOf('app.on("will-quit"', start);
    const block = indexSrc.slice(start, end);
    expect(block).toMatch(/assessLiveWork|hasLiveWork|buildQuitConfirmPrompt/);
    expect(block).toMatch(/QUIT_CONFIRM_ACCEPT_INDEX|showMessageBox/);
    // Sacred ordering still present after the gate.
    expect(block.indexOf("requestCanvasFlush")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("requestCanvasFlush")).toBeLessThan(
      block.indexOf('detachRuntimeOnQuit("before-quit")'),
    );
    expect(block.indexOf('detachRuntimeOnQuit("before-quit")')).toBeLessThan(
      block.indexOf("disposeRuntime()"),
    );
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
    const catchIdx = block.indexOf('console.error("[canvas] quit blocked:"');
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
