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
    const block = source.slice(start, source.indexOf("});", start) + 3);

    expect(block).toContain("beginSignalCanvasFlush()");
    // Force-exit requires both canvas flush durability AND local terminal shutdown.
    expect(block).toContain("allowForceExit:");
    expect(block).toContain("signalCanvasFlushDurable");
    expect(block).toContain("signalTerminalShutdownComplete");
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
