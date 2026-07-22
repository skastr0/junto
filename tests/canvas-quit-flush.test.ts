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

  it("never authorizes the signal fallback before final flush and renderer quiesce", () => {
    const start = source.indexOf("installProcessSignalTermination({");
    const allowIdx = source.indexOf("allowForceExit:", start);
    expect(allowIdx).toBeGreaterThan(start);
    // Include through the allowForceExit predicate (async shutdown may insert `});` earlier).
    const block = source.slice(start, allowIdx + 120);

    expect(block).toContain("await beginSignalCanvasFlush(generation)");
    expect(block.indexOf("await beginSignalCanvasFlush(generation)"))
      .toBeLessThan(block.indexOf("signalQuitState.markCanvasDurable(generation)"));
    expect(block.indexOf("signalQuitState.markCanvasDurable(generation)"))
      .toBeLessThan(block.indexOf("quiesceSignalRenderer(generation)"));
    expect(block.indexOf("quiesceSignalRenderer(generation)"))
      .toBeLessThan(block.indexOf("signalQuitState.authorizeForceExit(generation)"));
    expect(block).toContain("allowForceExit:");
    expect(block).toContain("signalQuitState.forceExitAllowed()");
  });

  it("commits signal quit in terminal, flush, quiesce, authorize, detach order", () => {
    const beforeStart = source.indexOf('app.on("before-quit"');
    const beforeEnd = source.indexOf('app.on("will-quit"', beforeStart);
    const beforeQuit = source.slice(beforeStart, beforeEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const signal = source.slice(signalStart);

    expect(signal.indexOf("requireCleanLocalTerminalShutdown(signal, false)"))
      .toBeLessThan(signal.indexOf("signalQuitState.markTerminalClean(generation)"));
    expect(signal.indexOf("signalQuitState.markTerminalClean(generation)"))
      .toBeLessThan(signal.indexOf("await beginSignalCanvasFlush(generation)"));
    expect(signal.indexOf("await beginSignalCanvasFlush(generation)"))
      .toBeLessThan(signal.indexOf("signalQuitState.markCanvasDurable(generation)"));
    expect(signal.indexOf("signalQuitState.markCanvasDurable(generation)"))
      .toBeLessThan(signal.indexOf("quiesceSignalRenderer(generation)"));
    expect(signal.indexOf("quiesceSignalRenderer(generation)"))
      .toBeLessThan(signal.indexOf("signalQuitState.authorizeForceExit(generation)"));
    expect(signal.indexOf("signalQuitState.authorizeForceExit(generation)"))
      .toBeLessThan(signal.indexOf("detachRuntimeOnQuit(signal)"));
    expect(signal.indexOf("detachRuntimeOnQuit(signal)"))
      .toBeLessThan(signal.indexOf("signalQuitState.markRuntimeDetached(generation)"));
    expect(beforeQuit).toContain("durableSignalGeneration");
    expect(beforeQuit).toContain("? Promise.resolve()");
    expect(beforeQuit).toContain("signalQuitState.reusableDurabilityGeneration()");
    expect(beforeQuit).not.toContain("signalTermination?.cancel()");
  });

  it("blocks every exit path after the bounded terminal shutdown returns unclean", () => {
    const helperStart = source.indexOf("const requireCleanLocalTerminalShutdown");
    const helperEnd = source.indexOf("const exitAfterDetach", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const directEnd = source.indexOf("let quitPreparation", helperEnd);
    const directExit = source.slice(helperEnd, directEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const signalBlock = source.slice(signalStart);

    expect(helper).toContain("if (!result.clean)");
    expect(helper).toContain("throw new Error");
    expect(helper).not.toContain("waitForAllLocalExited");
    expect(directExit.indexOf("requireCleanLocalTerminalShutdown(reason, true)"))
      .toBeLessThan(directExit.indexOf("detachRuntimeOnQuit(reason)"));
    expect(directExit.indexOf("requireCleanLocalTerminalShutdown(reason, true)"))
      .toBeLessThan(directExit.indexOf("app.exit(exitCode)"));
    expect(directExit).not.toContain(".finally(");
    expect(directExit).toContain("recreateWindowIfEmpty()");
    expect(signalBlock.indexOf("requireCleanLocalTerminalShutdown(signal, false)"))
      .toBeLessThan(signalBlock.indexOf("signalQuitState.markTerminalClean(generation)"));
    expect(signalBlock.indexOf("signalQuitState.markTerminalClean(generation)"))
      .toBeLessThan(signalBlock.indexOf("detachRuntimeOnQuit(signal)"));
    expect(signalBlock).toContain("catch (error)");
  });

  it("keeps signal attempts generation-scoped and restores retry state on failure", () => {
    const start = source.indexOf("installProcessSignalTermination({");
    const block = source.slice(start);

    expect(block).toContain("const generation = signalQuitState.begin()");
    expect(source).toContain("signalQuitState.isCurrent(generation)");
    expect(block).toContain("const disposition = signalQuitState.fail(generation)");
    expect(block).toContain('disposition === "recover"');
    expect(block).toContain("skipQuitConfirm = false");
    expect(block).toContain("recreateWindowIfEmpty()");
  });

  it("revalidates the active generation after each signal flush", () => {
    const start = source.indexOf("const beginSignalCanvasFlush");
    const end = source.indexOf("const quiesceSignalRenderer", start);
    const block = source.slice(start, end);

    expect(block).toContain("requestCanvasFlush(mainWindow)");
    expect(block.indexOf("signalQuitState.isCurrent(generation)"))
      .toBeGreaterThan(block.indexOf("requestCanvasFlush(mainWindow)"));
    expect(block).not.toContain("disposeRuntime");
  });

  it("destroys the trusted renderer without re-flushing before authorization", () => {
    const quiesceStart = source.indexOf("const quiesceSignalRenderer");
    const quiesceEnd = source.indexOf("const collectLiveWorkSnapshot", quiesceStart);
    const quiesce = source.slice(quiesceStart, quiesceEnd);
    const closeStart = source.indexOf('mainWindow.on("close"');
    const closeEnd = source.indexOf("mainWindow.webContents.setWindowOpenHandler", closeStart);
    const close = source.slice(closeStart, closeEnd);

    expect(quiesce.indexOf("signalQuiescedWindows.add(mainWindow)"))
      .toBeLessThan(quiesce.indexOf("mainWindow.destroy()"));
    expect(quiesce.indexOf("mainWindow.destroy()"))
      .toBeLessThan(quiesce.indexOf("signalQuitState.markRendererQuiesced(generation)"));
    expect(quiesce).not.toContain("requestCanvasFlush");
    expect(close).toContain("signalQuiescedWindows.has(mainWindow)");
    expect(close).toContain("requestCanvasFlush(mainWindow)");
  });

  it("prevents native activation from recreating authoring after quiesce", () => {
    const createStart = source.indexOf("const createWindow = () =>");
    const createEnd = source.indexOf("const LAUNCHD_LABEL", createStart);
    const create = source.slice(createStart, createEnd);

    expect(create).toContain("signalRendererDestroyInProgress");
    expect(create).toContain("signalQuitState.rendererQuiesced()");
    expect(create.indexOf("signalQuitState.rendererQuiesced()"))
      .toBeLessThan(create.indexOf("new BrowserWindow"));
  });

  it("retains fallback authorization on teardown failure after signal commit", () => {
    const beforeStart = source.indexOf('app.on("before-quit"');
    const beforeEnd = source.indexOf('app.on("will-quit"', beforeStart);
    const beforeQuit = source.slice(beforeStart, beforeEnd);
    const committed = beforeQuit.indexOf("if (signalQuitState.forceExitAllowed())");
    const recover = beforeQuit.indexOf("quitPreparation = undefined", committed);

    expect(committed).toBeGreaterThanOrEqual(0);
    expect(recover).toBeGreaterThan(committed);
    expect(beforeQuit.slice(committed, recover)).not.toContain("recreateWindowIfEmpty()");
    expect(beforeQuit.slice(committed, recover)).not.toContain("skipQuitConfirm = false");
    expect(beforeQuit).not.toContain("signalTermination?.cancel()");
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
