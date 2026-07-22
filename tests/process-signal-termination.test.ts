import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuitPreparationArbiter,
  createSignalQuitState,
  installProcessSignalTermination,
  runNormalQuitPreparation,
} from "../src/main/vellum/process-signal-termination";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface SignalChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly forced: boolean;
}

const runSignalChild = async (
  mode: "fallback" | "normal",
  terminationSignal: "SIGINT" | "SIGTERM" = "SIGTERM",
): Promise<SignalChildResult> => {
  const fixture = join(
    import.meta.dirname,
    "fixtures",
    "process-signal-termination-child.ts",
  );
  const child = spawn(process.execPath, [fixture, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let signaled = false;
  let forced = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (signaled || !stdout.includes("ready\n")) return;
    signaled = true;
    child.kill(terminationSignal);
    setTimeout(() => child.kill(terminationSignal), 5).unref();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<SignalChildResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 2_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, forced });
    });
  });

  expect(stderr).toBe("");
  return result;
};

describe("process signal termination", () => {
  it("turns SIGTERM into one orderly quit and exits without escalation", async () => {
    const result = await runSignalChild("normal");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGTERM\nquit\n",
      forced: false,
    });
  });

  it("keeps the app.exit fallback live after cleanup removes the final handle", async () => {
    const result = await runSignalChild("fallback");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGTERM\nquit\nexit:0\n",
      forced: false,
    });
  });

  it("turns SIGINT into the same orderly, idempotent quit", async () => {
    const result = await runSignalChild("normal", "SIGINT");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGINT\nquit\n",
      forced: false,
    });
  });

  it("never bypasses an incomplete durability boundary, then forces only after it is safe", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const processTarget = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => {
        listeners.delete(signal);
      }),
    };
    const quit = vi.fn();
    const exit = vi.fn();
    const cleanup = vi.fn();
    let durable = false;
    const installed = installProcessSignalTermination({
      app: { quit, exit },
      cleanup,
      processTarget,
      exitGraceMs: 10,
      allowForceExit: () => durable,
    });

    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30);
    expect(exit).not.toHaveBeenCalled();

    durable = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    installed.dispose();
  });

  it("allows a fresh signal attempt after cleanup rejects", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const processTarget = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => {
        listeners.delete(signal);
      }),
    };
    const quit = vi.fn();
    const exit = vi.fn();
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("durability blocked"))
      .mockResolvedValue(undefined);
    const installed = installProcessSignalTermination({
      app: { quit, exit },
      cleanup,
      processTarget,
      exitGraceMs: 10,
      allowForceExit: () => true,
    });

    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(installed.requested()).toBe(false);

    listeners.get("SIGINT")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledOnce();
    expect(installed.requested()).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledOnce();
    installed.dispose();
  });

  it("generation-guards a cleanup that settles after disposal", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const processTarget = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => {
        listeners.delete(signal);
      }),
    };
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
    );
    const quit = vi.fn();
    const exit = vi.fn();
    const installed = installProcessSignalTermination({
      app: { quit, exit },
      cleanup,
      processTarget,
      exitGraceMs: 10,
    });

    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    installed.dispose();
    finishCleanup?.();
    await vi.advanceTimersByTimeAsync(20);

    expect(quit).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(installed.requested()).toBe(false);
  });

  it("keeps the fallback authorized when later quit teardown fails after commit", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const processTarget = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => {
        listeners.delete(signal);
      }),
    };
    const state = createSignalQuitState();
    let generation = 0;
    const cleanup = vi.fn(() => {
      generation = state.begin();
      state.markTerminalClean(generation);
      state.markCanvasDurable(generation);
      state.markRendererQuiesced(generation);
      state.authorizeForceExit(generation);
      state.markRuntimeDetached(generation);
    });
    const exit = vi.fn();
    let teardownFailure: ReturnType<typeof state.fail> | undefined;
    const installed = installProcessSignalTermination({
      app: {
        quit: () => {
          // Model a later before-quit stop/dispose rejection. The renderer is
          // already gone and the durable generation must remain authorized.
          teardownFailure = state.fail(generation);
        },
        exit,
      },
      cleanup,
      processTarget,
      exitGraceMs: 10,
      allowForceExit: () => state.forceExitAllowed(),
    });

    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(teardownFailure).toBe("finish");
    expect(state.forceExitAllowed()).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    installed.dispose();
  });
});

describe("signal quit commit state", () => {
  it("enforces terminal, flush, renderer quiesce, authorization, then detach", () => {
    const state = createSignalQuitState();
    const generation = state.begin();

    expect(() => state.markCanvasDurable(generation)).toThrow();
    state.markTerminalClean(generation);
    expect(() => state.markRendererQuiesced(generation)).toThrow();
    state.markCanvasDurable(generation);
    expect(() => state.authorizeForceExit(generation)).toThrow();
    state.markRendererQuiesced(generation);
    expect(state.forceExitAllowed()).toBe(false);
    state.authorizeForceExit(generation);
    expect(() => state.markCanvasDurable(generation)).toThrow();
    state.markRuntimeDetached(generation);

    expect(state.snapshot()).toEqual({
      generation,
      phase: "runtime-detached",
    });
    expect(state.reusableDurabilityGeneration()).toBe(generation);
    expect(state.forceExitAllowed()).toBe(true);
  });

  it("recovers UI and permits a fresh generation only before renderer quiesce", () => {
    const state = createSignalQuitState();
    const first = state.begin();
    state.markTerminalClean(first);

    expect(state.fail(first)).toBe("recover");
    expect(state.snapshot()).toEqual({ generation: first, phase: "idle" });
    expect(state.rendererQuiesced()).toBe(false);
    expect(state.forceExitAllowed()).toBe(false);

    const second = state.begin();
    expect(second).toBe(first + 1);
  });

  it("finishes exit instead of recovering a renderer-quiesced attempt", () => {
    const state = createSignalQuitState();
    const generation = state.begin();
    state.markTerminalClean(generation);
    state.markCanvasDurable(generation);
    state.markRendererQuiesced(generation);

    expect(state.fail(generation)).toBe("finish");
    expect(state.snapshot()).toEqual({
      generation,
      phase: "force-authorized",
    });
    expect(state.rendererQuiesced()).toBe(true);
    expect(state.reusableDurabilityGeneration()).toBe(generation);
    expect(state.forceExitAllowed()).toBe(true);
  });

  it("retries without recreating when the renderer gate closed before flush failed", () => {
    const state = createSignalQuitState();
    const first = state.begin();
    state.markTerminalClean(first);
    state.markRendererGateQuiesced(first);

    expect(state.fail(first)).toBe("retry");
    expect(state.snapshot()).toEqual({ generation: first, phase: "idle" });
    expect(state.rendererQuiesced()).toBe(true);
    expect(state.forceExitAllowed()).toBe(false);

    const retry = state.begin();
    state.markTerminalClean(retry);
    state.markCanvasDurable(retry);
    state.markRendererQuiesced(retry);
    state.authorizeForceExit(retry);
    expect(state.forceExitAllowed()).toBe(true);
  });

  it("forgets only a pre-durable gate when that renderer process is gone", () => {
    const state = createSignalQuitState();
    const first = state.begin();
    state.markTerminalClean(first);
    state.markRendererGateQuiesced(first);
    expect(state.fail(first)).toBe("retry");

    state.forgetRendererGateAfterProcessLoss();
    expect(state.rendererQuiesced()).toBe(false);

    const replacement = state.begin();
    state.markTerminalClean(replacement);
    state.markCanvasDurable(replacement);
    state.forgetRendererGateAfterProcessLoss();
    expect(state.rendererQuiesced()).toBe(true);
    expect(state.snapshot().phase).toBe("canvas-durable");
  });

  it("ignores stale failure callbacks from an earlier generation", () => {
    const state = createSignalQuitState();
    const first = state.begin();
    expect(state.fail(first)).toBe("recover");
    const second = state.begin();

    expect(state.fail(first)).toBe("stale");
    expect(state.snapshot()).toEqual({
      generation: second,
      phase: "preparing",
    });
  });
});

describe("quit preparation arbitration", () => {
  it("blocks new normal quit preparation until signal precommit resolves", () => {
    const arbiter = createQuitPreparationArbiter();

    expect(arbiter.claimSignal()).toBe("claimed");
    expect(arbiter.beginNormal()).toBeUndefined();
    expect(arbiter.signalPrecommit()).toBe(true);

    arbiter.recoverSignal();
    const normal = arbiter.beginNormal();
    expect(normal).toBeTypeOf("number");
    expect(arbiter.normalCurrent(normal!)).toBe(true);
    expect(arbiter.commitNormal(normal!)).toBe(true);
    expect(arbiter.committed()).toBe(true);
  });

  it("invalidates a normal continuation that was awaiting shutdown when signal claims quit", async () => {
    const arbiter = createQuitPreparationArbiter();
    const normal = arbiter.beginNormal();
    if (normal === undefined) throw new Error("normal preparation unexpectedly blocked");
    let finishTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      finishTerminal = resolve;
    });
    const detach = vi.fn();
    const normalContinuation = terminal.then(() => {
      if (arbiter.normalCurrent(normal) && arbiter.commitNormal(normal)) detach();
    });

    expect(arbiter.claimSignal()).toBe("claimed");
    finishTerminal();
    await normalContinuation;

    expect(detach).not.toHaveBeenCalled();
    arbiter.commitSignal();
    const committedSignalPreparation = arbiter.beginNormal();
    expect(committedSignalPreparation).toBeTypeOf("number");
    expect(arbiter.commitNormal(committedSignalPreparation!)).toBe(true);
    expect(arbiter.committed()).toBe(true);
  });

  it("joins a committed normal quit instead of invalidating its teardown", () => {
    const arbiter = createQuitPreparationArbiter();
    const normal = arbiter.beginNormal();
    if (normal === undefined) throw new Error("normal preparation unexpectedly blocked");

    expect(arbiter.commitNormal(normal)).toBe(true);
    expect(arbiter.normalCommitted(normal)).toBe(true);
    expect(arbiter.claimSignal()).toBe("joined-normal");
    expect(arbiter.signalPrecommit()).toBe(false);
    expect(arbiter.committed()).toBe(true);
    expect(arbiter.beginNormal()).toBeUndefined();
  });

  it("lets signal win while normal final quiesce is awaiting its ACK", async () => {
    const arbiter = createQuitPreparationArbiter();
    const normal = arbiter.beginNormal();
    if (normal === undefined) throw new Error("normal preparation unexpectedly blocked");
    let finishQuiesce!: () => void;
    const quiesce = new Promise<void>((resolve) => {
      finishQuiesce = resolve;
    });
    const detach = vi.fn();
    const normalPreparation = Promise.resolve()
      .then(async () => {
        if (!arbiter.normalCurrent(normal)) return false;
        await quiesce;
        return arbiter.commitNormal(normal);
      })
      .then((committed) => {
        if (committed) detach();
      });

    await Promise.resolve();
    expect(arbiter.claimSignal()).toBe("claimed");
    finishQuiesce();
    await normalPreparation;

    expect(detach).not.toHaveBeenCalled();
    expect(arbiter.committed()).toBe(false);
  });

  it("keeps a normal teardown committed when signal arrives after its CAS", () => {
    const arbiter = createQuitPreparationArbiter();
    const normal = arbiter.beginNormal();
    if (normal === undefined) throw new Error("normal preparation unexpectedly blocked");
    expect(arbiter.normalCurrent(normal)).toBe(true);
    expect(arbiter.commitNormal(normal)).toBe(true);

    const detach = vi.fn();
    if (arbiter.committed()) detach();
    expect(arbiter.claimSignal()).toBe("joined-normal");

    expect(detach).toHaveBeenCalledOnce();
    expect(arbiter.normalCommitted(normal)).toBe(true);
    expect(arbiter.committed()).toBe(true);
  });

  it("recovers only a normal preparation that has not committed", () => {
    const arbiter = createQuitPreparationArbiter();
    const first = arbiter.beginNormal();
    if (first === undefined) throw new Error("normal preparation unexpectedly blocked");
    arbiter.recoverNormal(first);

    const retry = arbiter.beginNormal();
    if (retry === undefined) throw new Error("normal retry unexpectedly blocked");
    expect(arbiter.commitNormal(retry)).toBe(true);
    arbiter.recoverNormal(retry);
    expect(arbiter.normalCommitted(retry)).toBe(true);
  });

  it("retains a normal renderer latch across drain retries until process loss", () => {
    const arbiter = createQuitPreparationArbiter();
    const first = arbiter.beginNormal();
    if (first === undefined) throw new Error("normal preparation unexpectedly blocked");

    arbiter.observeRendererGateQuiesced();
    arbiter.recoverNormal(first);
    expect(arbiter.rendererGateQuiesced()).toBe(true);

    const retry = arbiter.beginNormal();
    expect(retry).toBeTypeOf("number");
    arbiter.recoverNormal(retry!);
    arbiter.forgetRendererGateAfterProcessLoss();
    expect(arbiter.rendererGateQuiesced()).toBe(false);
  });

  it("retains renderer gate evidence reported after signal supersedes normal ownership", () => {
    const arbiter = createQuitPreparationArbiter();
    const normal = arbiter.beginNormal();
    if (normal === undefined) throw new Error("normal preparation unexpectedly blocked");

    expect(arbiter.claimSignal()).toBe("claimed");
    arbiter.observeRendererGateQuiesced();
    arbiter.recoverSignal();

    expect(arbiter.rendererGateQuiesced()).toBe(true);
    expect(arbiter.normalCurrent(normal)).toBe(false);
  });

  it("never forgets normal renderer finality after the commit CAS", () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");

    expect(arbiter.commitNormal(generation)).toBe(true);
    arbiter.forgetRendererGateAfterProcessLoss();

    expect(arbiter.rendererGateQuiesced()).toBe(true);
    expect(arbiter.normalCommitted(generation)).toBe(true);
  });
});

describe("normal quit preparation", () => {
  it("runs terminal, final renderer ACK, commit/destroy, detach, and dispose in order", async () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");
    const calls: string[] = [];

    await expect(runNormalQuitPreparation(arbiter, generation, {
      terminalClean: async () => { calls.push("terminal"); },
      finalRendererQuiesce: async () => { calls.push("renderer-ack"); },
      destroyRenderer: () => { calls.push("destroy"); },
      detachRuntime: () => { calls.push("detach"); },
      disposeRuntime: async () => { calls.push("dispose"); },
    })).resolves.toBe(true);

    expect(calls).toEqual(["terminal", "renderer-ack", "destroy", "detach", "dispose"]);
    expect(arbiter.normalCommitted(generation)).toBe(true);
  });

  it("never starts renderer finality when signal claims during terminal cleanup", async () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");
    let finishTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { finishTerminal = resolve; });
    const renderer = vi.fn(async () => undefined);
    const detach = vi.fn();
    const preparation = runNormalQuitPreparation(arbiter, generation, {
      terminalClean: () => terminal,
      finalRendererQuiesce: renderer,
      destroyRenderer: vi.fn(),
      detachRuntime: detach,
      disposeRuntime: async () => undefined,
    });

    expect(arbiter.claimSignal()).toBe("claimed");
    finishTerminal();
    await expect(preparation).resolves.toBe(false);
    expect(renderer).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("loses the commit CAS when signal claims during the renderer ACK", async () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");
    let finishRenderer!: () => void;
    const renderer = new Promise<void>((resolve) => { finishRenderer = resolve; });
    const destroy = vi.fn();
    const detach = vi.fn();
    const preparation = runNormalQuitPreparation(arbiter, generation, {
      terminalClean: async () => undefined,
      finalRendererQuiesce: () => renderer,
      destroyRenderer: destroy,
      detachRuntime: detach,
      disposeRuntime: async () => undefined,
    });

    await Promise.resolve();
    expect(arbiter.claimSignal()).toBe("claimed");
    finishRenderer();
    await expect(preparation).resolves.toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("keeps committed teardown joinable while runtime disposal is pending", async () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");
    let finishDispose!: () => void;
    const dispose = new Promise<void>((resolve) => { finishDispose = resolve; });
    const destroy = vi.fn();
    const detach = vi.fn();
    const preparation = runNormalQuitPreparation(arbiter, generation, {
      terminalClean: async () => undefined,
      finalRendererQuiesce: async () => undefined,
      destroyRenderer: destroy,
      detachRuntime: detach,
      disposeRuntime: () => dispose,
    });

    for (let turn = 0; turn < 4 && !arbiter.committed(); turn += 1) await Promise.resolve();
    expect(arbiter.committed()).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(arbiter.claimSignal()).toBe("joined-normal");

    finishDispose();
    await expect(preparation).resolves.toBe(true);
  });

  it("retains the normal commit when disposal rejects", async () => {
    const arbiter = createQuitPreparationArbiter();
    const generation = arbiter.beginNormal();
    if (generation === undefined) throw new Error("normal preparation unexpectedly blocked");

    await expect(runNormalQuitPreparation(arbiter, generation, {
      terminalClean: async () => undefined,
      finalRendererQuiesce: async () => undefined,
      destroyRenderer: () => undefined,
      detachRuntime: () => undefined,
      disposeRuntime: async () => { throw new Error("dispose stalled"); },
    })).rejects.toThrow("dispose stalled");

    expect(arbiter.normalCommitted(generation)).toBe(true);
    expect(arbiter.claimSignal()).toBe("joined-normal");
    expect(arbiter.committed()).toBe(true);
  });
});
