import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("canvas quit durability wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("flushes the renderer before disposing the runtime on normal quit", () => {
    const start = source.indexOf('app.on("before-quit"');
    const end = source.indexOf('app.on("will-quit"', start);
    const block = source.slice(start, end);

    expect(block.indexOf("requestCanvasFlush(mainWindow)")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("requestCanvasFlush(mainWindow)"))
      .toBeLessThan(block.indexOf('detachRuntimeOnQuit("before-quit")'));
    expect(block.indexOf('detachRuntimeOnQuit("before-quit")'))
      .toBeLessThan(block.indexOf("disposeRuntime()"));
  });

  it("never lets the signal fallback bypass an incomplete canvas flush", () => {
    const start = source.indexOf("installProcessSignalTermination({");
    const allowIdx = source.indexOf("allowForceExit:", start);
    expect(allowIdx).toBeGreaterThan(start);
    // Include through the allowForceExit predicate (async shutdown may insert `});` earlier).
    const block = source.slice(start, allowIdx + 120);

    expect(block).toContain("await beginSignalCanvasFlush(generation)");
    // Force-exit requires both canvas flush durability AND local terminal shutdown.
    expect(block).toContain("allowForceExit:");
    expect(block).toContain("signalCanvasFlushDurable");
    expect(block).toContain("signalTerminalShutdownComplete");
  });

  it("resumes direct and signal exit only after a late terminal exit is observed", () => {
    const helperStart = source.indexOf("const requireCleanLocalTerminalShutdown");
    const helperEnd = source.indexOf("const exitAfterDetach", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const directEnd = source.indexOf("let quitPreparation", helperEnd);
    const directExit = source.slice(helperEnd, directEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const signalBlock = source.slice(signalStart);

    expect(helper).toContain("if (!result.clean)");
    expect(helper).toContain("await termPlane.router.waitForAllLocalExited()");
    expect(directExit.indexOf("requireCleanLocalTerminalShutdown(reason, true)"))
      .toBeLessThan(directExit.indexOf("detachRuntimeOnQuit(reason)"));
    expect(directExit.indexOf("requireCleanLocalTerminalShutdown(reason, true)"))
      .toBeLessThan(directExit.indexOf("app.exit(exitCode)"));
    expect(directExit).not.toContain(".finally(");
    expect(signalBlock.indexOf("requireCleanLocalTerminalShutdown(signal, false)"))
      .toBeLessThan(signalBlock.indexOf("signalTerminalShutdownComplete = true"));
    expect(signalBlock.indexOf("signalTerminalShutdownComplete = true"))
      .toBeLessThan(signalBlock.indexOf("detachRuntimeOnQuit(signal)"));
    expect(signalBlock).toContain("catch (error)");
  });

  it("keeps signal attempts generation-scoped and restores retry state on failure", () => {
    const start = source.indexOf("installProcessSignalTermination({");
    const block = source.slice(start);

    expect(block).toContain("const generation = ++signalShutdownGeneration");
    expect(block).toContain("generation !== signalShutdownGeneration");
    expect(block).toContain("signalCanvasFlushDurable = false");
    expect(block).toContain("signalTerminalShutdownComplete = false");
    expect(block).toContain("skipQuitConfirm = false");
    expect(block).toContain("recreateWindowIfEmpty()");
  });

  it("keys fallback authorization to each signal flush, independent of hung disposal", () => {
    const start = source.indexOf("const beginSignalCanvasFlush");
    const end = source.indexOf('app.on("before-quit"', start);
    const block = source.slice(start, end);

    expect(block.indexOf("signalCanvasFlushDurable = false"))
      .toBeLessThan(block.indexOf("requestCanvasFlush(mainWindow)"));
    expect(block.indexOf("signalCanvasFlushDurable = true"))
      .toBeGreaterThan(block.indexOf("requestCanvasFlush(mainWindow)"));
    expect(block).not.toContain("disposeRuntime");
  });

  it("blocks window teardown until a canvas flush acknowledgement arrives", () => {
    const start = source.indexOf('mainWindow.on("close"');
    const end = source.indexOf('mainWindow.webContents.setWindowOpenHandler', start);
    const block = source.slice(start, end);

    expect(block).toContain("event.preventDefault()");
    expect(block).toContain("requestCanvasFlush(mainWindow)");
    expect(block.indexOf("requestCanvasFlush(mainWindow)"))
      .toBeLessThan(block.indexOf("mainWindow.close()"));
  });

  it("never dereferences destroyed WebContents from the BrowserWindow closed event", () => {
    const start = source.indexOf('mainWindow.on("closed"');
    const end = source.indexOf("registerCrashRecovery(mainWindow)", start);
    const block = source.slice(start, end);

    expect(source).toContain("const mainWebContentsId = mainWindow.webContents.id");
    expect(block).toContain("pendingCanvasFlushes.get(mainWebContentsId)");
    expect(block).not.toContain("mainWindow.webContents");
  });
});
