import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("canvas quit durability wiring", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");
  const terminationSource = readFileSync(
    join(import.meta.dirname, "..", "src/main/vellum/process-signal-termination.ts"),
    "utf8",
  );

  it("terminal-cleans then quiesces the renderer before normal runtime detach", () => {
    const start = source.indexOf('app.on("before-quit"');
    const end = source.indexOf('app.on("will-quit"', start);
    const block = source.slice(start, end);
    const runnerStart = terminationSource.indexOf("export const runNormalQuitPreparation");
    const runnerEnd = terminationSource.indexOf("/**\n * Generation-scoped", runnerStart);
    const runner = terminationSource.slice(runnerStart, runnerEnd);

    expect(block.indexOf('requireCleanLocalTerminalShutdown("before-quit", true)'))
      .toBeGreaterThanOrEqual(0);
    expect(block).toContain("requestCanvasQuiesceAndFlush(mainWindow)");
    expect(block).toContain("destroyRenderer: destroyQuiescedRenderer");
    expect(runner.indexOf("await steps.terminalClean()"))
      .toBeLessThan(runner.indexOf("await steps.finalRendererQuiesce()"));
    expect(runner.indexOf("await steps.finalRendererQuiesce()"))
      .toBeLessThan(runner.indexOf("arbiter.commitNormal(generation)"));
    expect(runner.indexOf("arbiter.commitNormal(generation)"))
      .toBeLessThan(runner.indexOf("steps.destroyRenderer()"));
    expect(runner.indexOf("steps.destroyRenderer()"))
      .toBeLessThan(runner.indexOf("steps.detachRuntime()"));
    expect(runner.indexOf("steps.detachRuntime()"))
      .toBeLessThan(runner.indexOf("await steps.disposeRuntime()"));
  });

  it("never authorizes the signal fallback before final flush and renderer quiesce", () => {
    const start = source.indexOf("installProcessSignalTermination({");
    const allowIdx = source.indexOf("allowForceExit:", start);
    expect(allowIdx).toBeGreaterThan(start);
    // Include through the allowForceExit predicate (async shutdown may insert `});` earlier).
    const standardStart = source.indexOf("// Existing normal continuations", start);
    const block = source.slice(standardStart, allowIdx + 120);

    expect(block).toContain("await beginSignalCanvasQuiesceAndFlush(generation)");
    expect(block.indexOf("await beginSignalCanvasQuiesceAndFlush(generation)"))
      .toBeLessThan(block.indexOf("signalQuitState.markCanvasDurable(generation)"));
    expect(block.indexOf("signalQuitState.markCanvasDurable(generation)"))
      .toBeLessThan(block.indexOf("quiesceSignalRenderer(generation)"));
    expect(block.indexOf("quiesceSignalRenderer(generation)"))
      .toBeLessThan(block.indexOf("signalQuitState.authorizeForceExit(generation)"));
    expect(block).toContain("allowForceExit:");
    expect(block).toContain("signalQuitState.forceExitAllowed()");
    expect(block).not.toContain("await beginSignalCanvasFlush(generation)");
  });

  it("commits signal quit in terminal, flush, quiesce, authorize, detach order", () => {
    const beforeStart = source.indexOf('app.on("before-quit"');
    const beforeEnd = source.indexOf('app.on("will-quit"', beforeStart);
    const beforeQuit = source.slice(beforeStart, beforeEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const standardStart = source.indexOf("// Existing normal continuations", signalStart);
    const signal = source.slice(standardStart);

    expect(signal.indexOf("requireCleanLocalTerminalShutdown(signal, false)"))
      .toBeLessThan(signal.indexOf("signalQuitState.markTerminalClean(generation)"));
    expect(signal.indexOf("signalQuitState.markTerminalClean(generation)"))
      .toBeLessThan(signal.indexOf("await beginSignalCanvasQuiesceAndFlush(generation)"));
    expect(signal.indexOf("await beginSignalCanvasQuiesceAndFlush(generation)"))
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
    expect(beforeQuit).toContain("if (canvasAlreadyDurable) return");
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
    const standardStart = source.indexOf("// Existing normal continuations", signalStart);
    const signalBlock = source.slice(standardStart);

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

    expect(block).toContain("generation = signalQuitState.begin()");
    expect(source).toContain("signalQuitState.isCurrent(generation)");
    expect(block).toContain("const disposition = signalQuitState.fail(generation)");
    expect(block).toContain('disposition === "recover"');
    expect(block).toContain("skipQuitConfirm = false");
    expect(block).toContain("recreateWindowIfEmpty()");
  });

  it("revalidates the active generation after the distinct signal handshake", () => {
    const start = source.indexOf("const beginSignalCanvasQuiesceAndFlush");
    const end = source.indexOf("const quiesceSignalRenderer", start);
    const block = source.slice(start, end);

    expect(block).toContain("requestCanvasQuiesceAndFlush(mainWindow)");
    expect(block).not.toContain("requestCanvasFlush(mainWindow)");
    expect(block.indexOf("signalQuitState.isCurrent(generation)"))
      .toBeGreaterThan(block.indexOf("requestCanvasQuiesceAndFlush(mainWindow)"));
    expect(block).not.toContain("disposeRuntime");
  });

  it("does not coalesce signal quiesce with an ordinary pending flush", () => {
    const start = source.indexOf("const requestCanvasQuiesceAndFlush");
    const end = source.indexOf(
      "ipcMain.on(IPC_CHANNELS.canvasQuiesceAndFlushComplete",
      start,
    );
    const block = source.slice(start, end);

    expect(block).toContain("pendingCanvasQuiesceAndFlushes");
    expect(block).not.toContain("pendingCanvasFlushes");
    expect(block).toContain("IPC_CHANNELS.canvasQuiesceAndFlushRequested");
    expect(source).toContain("IPC_CHANNELS.canvasQuiesceAndFlushStarted");
  });

  it("uses the renderer-start receipt instead of guessing at timeout state", () => {
    const start = source.indexOf("const requestCanvasQuiesceAndFlush");
    const end = source.indexOf(
      "ipcMain.on(IPC_CHANNELS.canvasQuiesceAndFlushComplete",
      start,
    );
    const block = source.slice(start, end);

    expect(block).toContain("pending.quiesced");
    expect(block).toContain("canvasQuiesceAndFlushStarted");
    expect(block).toContain("pending.quiesced = true");
    expect(source).toContain("pending.quiesced || result.quiesced");
    expect(block).not.toContain('timed out", true');
  });

  it("recovers a crashed pre-ack renderer but never reloads after final ack", () => {
    const start = source.indexOf("const registerCrashRecovery");
    const end = source.indexOf("const createWindow", start);
    const block = source.slice(start, end);

    expect(block).toContain("acknowledgedCanvasQuiesceWebContents.has(webContentsId)");
    expect(block).toContain("rejectPendingCanvasQuiesce(");
    expect(block).toContain("signalQuitState.forgetRendererGateAfterProcessLoss()");
    expect(block).toContain("quitPreparationArbiter.forgetRendererGateAfterProcessLoss()");
    expect(block.indexOf("quitPreparationArbiter.forgetRendererGateAfterProcessLoss()"))
      .toBeLessThan(block.indexOf('details.reason === "clean-exit"'));
    expect(block.indexOf("acknowledgedCanvasQuiesceWebContents.has(webContentsId)"))
      .toBeLessThan(block.indexOf("mainWindow.webContents.reload()"));
  });

  it("retains an irreversible normal renderer latch for a safe drain retry", () => {
    const start = source.indexOf('app.on("before-quit"');
    const end = source.indexOf('app.on("will-quit"', start);
    const block = source.slice(start, end);
    const mark = block.indexOf("observeRendererGateQuiesced");
    const recover = block.indexOf("recoverNormal(preparationGeneration)", mark);
    const retained = block.indexOf("rendererGateQuiesced()", recover);
    const recreate = block.indexOf("recreateWindowIfEmpty()", retained);

    expect(mark).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(recover);
    expect(recover).toBeLessThan(retained);
    expect(retained).toBeLessThan(recreate);
    expect(block.slice(retained, recreate)).toContain("return;");
  });

  it("destroys the trusted renderer without re-flushing before authorization", () => {
    const quiesceStart = source.indexOf("const destroyQuiescedRenderer");
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

  it("serializes normal quit continuations behind signal precommit", () => {
    const beforeStart = source.indexOf('app.on("before-quit"');
    const beforeEnd = source.indexOf('app.on("will-quit"', beforeStart);
    const beforeQuit = source.slice(beforeStart, beforeEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const signal = source.slice(signalStart);
    const standardStart = signal.indexOf("// Existing normal continuations");
    const standardSignal = signal.slice(standardStart);
    const detachStart = source.indexOf("const detachRuntimeOnQuit");
    const detachEnd = source.indexOf("let runtimeDispose", detachStart);
    const detach = source.slice(detachStart, detachEnd);

    expect(beforeQuit.indexOf("quitPreparationArbiter.signalPrecommit()"))
      .toBeLessThan(beforeQuit.indexOf("if (quitPreparation !== undefined)"));
    expect(beforeQuit).toContain("runNormalQuitPreparation(");
    expect(signal.indexOf("quitPreparationArbiter.claimSignal()"))
      .toBeLessThan(signal.indexOf("await requireCleanLocalTerminalShutdown(signal, false)"));
    expect(standardSignal.indexOf("signalQuitState.authorizeForceExit(generation)"))
      .toBeLessThan(standardSignal.indexOf("quitPreparationArbiter.commitSignal()"));
    expect(standardSignal.indexOf("quitPreparationArbiter.commitSignal()"))
      .toBeLessThan(standardSignal.indexOf("skipQuitConfirm = true"));
    expect(detach).toContain("quitPreparationArbiter.signalPrecommit()");
  });

  it("makes normal renderer finality irreversible and lets a later signal join it", () => {
    const beforeStart = source.indexOf('app.on("before-quit"');
    const beforeEnd = source.indexOf('app.on("will-quit"', beforeStart);
    const beforeQuit = source.slice(beforeStart, beforeEnd);
    const runnerStart = terminationSource.indexOf("export const runNormalQuitPreparation");
    const runnerEnd = terminationSource.indexOf("/**\n * Generation-scoped", runnerStart);
    const runner = terminationSource.slice(runnerStart, runnerEnd);
    const signalStart = source.indexOf("installProcessSignalTermination({");
    const signal = source.slice(signalStart);

    expect(beforeQuit).toContain("requestCanvasQuiesceAndFlush(mainWindow)");
    expect(runner.indexOf("await steps.finalRendererQuiesce()"))
      .toBeLessThan(runner.indexOf("arbiter.commitNormal(generation)"));
    expect(beforeQuit).toContain("quitPreparationArbiter.normalCommitted(preparationGeneration)");
    expect(signal).toContain('signalClaim === "joined-normal"');
    const joined = signal.slice(
      signal.indexOf('signalClaim === "joined-normal"'),
      signal.indexOf("let generation: number"),
    );
    expect(joined).not.toContain("signalQuitState.begin()");
    expect(joined).not.toContain("quiesceSignalRenderer(generation)");
    expect(joined).not.toContain("detachRuntimeOnQuit(signal)");
    expect(joined).not.toContain("recreateWindowIfEmpty()");
    expect(signal).toContain("quitPreparationArbiter.committed()");
  });

  it("blocks window teardown until a canvas flush acknowledgement arrives", () => {
    const start = source.indexOf('mainWindow.on("close"');
    const end = source.indexOf('mainWindow.webContents.setWindowOpenHandler', start);
    const block = source.slice(start, end);

    expect(block).toContain("event.preventDefault()");
    expect(block).toContain("requestCanvasFlush(mainWindow)");
    expect(block.indexOf("requestCanvasFlush(mainWindow)"))
      .toBeLessThan(block.indexOf("mainWindow.close()"));
    expect(block).toContain("quitPreparationArbiter.signalPrecommit()");
    expect(block.lastIndexOf("quitPreparationArbiter.signalPrecommit()"))
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
