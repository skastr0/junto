import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IDisposable, IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  admitChildProcess: vi.fn(),
  spawnDetachedProcessGroup: vi.fn(),
  signalOwned: vi.fn(),
  releaseOwned: vi.fn(),
  refreshProcessGroupObservations: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("../src/main/vellum/process-signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/vellum/process-signal")>()),
  admitChildProcess: mocks.admitChildProcess,
  spawnDetachedProcessGroup: mocks.spawnDetachedProcessGroup,
  signalOwned: mocks.signalOwned,
  releaseOwned: mocks.releaseOwned,
}));

vi.mock("../src/main/vellum/process-epoch", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/main/vellum/process-epoch")
  >();
  return {
    ...actual,
    refreshProcessGroupObservations: (
      observations: Parameters<typeof actual.refreshProcessGroupObservations>[0],
    ) => mocks.refreshProcessGroupObservations(
      actual.refreshProcessGroupObservations,
      observations,
    ),
  };
});

import {
  APP_PROCESS_PLANE_QUIESCING_ERROR,
  createAppProcessPlane,
  TerminalBackendUnavailableError,
  type AppProcessLease,
  type AppTerminalLease,
} from "../src/main/vellum/app-process-plane";
import {
  setProcessEpochReaderForTests,
  type ProcessGroupObservation,
  type ProcessGroupObservationRefresh,
  type ProcessEpochRow,
} from "../src/main/vellum/process-epoch";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly unref = vi.fn(() => this);
  pid: number | undefined = 42_001;
  kill = vi.fn((_signal?: NodeJS.Signals) => true);

  exit(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.emit("exit", code, signal);
  }

  close(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.emit("close", code, signal);
  }

  exitAndClose(
    code: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exit(code, signal);
    this.close(code, signal);
  }
}

class FakePty {
  readonly pid = 43_001;
  readonly write = vi.fn((_data: string) => undefined);
  readonly resize = vi.fn((_cols: number, _rows: number) => undefined);
  readonly kill = vi.fn((_signal?: string) => undefined);
  readonly onData = vi.fn((listener: (data: string) => void): IDisposable => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  });
  readonly onExit = vi.fn((listener: (event: {
    readonly exitCode: number;
    readonly signal?: number;
  }) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  });
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: {
    readonly exitCode: number;
    readonly signal?: number;
  }) => void>();

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(exitCode = 0, signal?: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode, ...(signal === undefined ? {} : { signal }) });
    }
  }

  asPty(): IPty {
    return this as unknown as IPty;
  }
}

interface FakeOwned {
  readonly sink: { readonly kill: (signal?: NodeJS.Signals) => unknown };
  released: boolean;
}

const mintOwned = (sink: FakeOwned["sink"]): FakeOwned => ({
  sink,
  released: false,
});

const successfulSignal = (mode: "child" | "group") => ({
  attempted: true,
  decision: { ok: true as const, mode },
  via: mode === "child" ? "child.kill" as const : "process.kill-group" as const,
});

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.admitChildProcess.mockReset();
  mocks.spawnDetachedProcessGroup.mockReset();
  mocks.signalOwned.mockReset();
  mocks.releaseOwned.mockReset();
  mocks.refreshProcessGroupObservations.mockReset();

  mocks.admitChildProcess.mockImplementation(
    (input: { readonly child: FakeOwned["sink"] }) => mintOwned(input.child),
  );
  mocks.signalOwned.mockImplementation(
    (owned: FakeOwned, signal: NodeJS.Signals) => {
      if (owned.released) {
        return {
          attempted: false,
          decision: { ok: false, reason: "handle-not-registered" },
          via: "none",
        };
      }
      try {
        if (owned.sink.kill(signal) === false) {
          return {
            attempted: false,
            decision: { ok: false, reason: "child-signal-refused" },
            via: "none",
          };
        }
        return successfulSignal("child");
      } catch {
        return {
          attempted: false,
          decision: { ok: false, reason: "child-signal-failed" },
          via: "none",
        };
      }
    },
  );
  mocks.releaseOwned.mockImplementation((owned: FakeOwned) => {
    owned.released = true;
  });
  mocks.refreshProcessGroupObservations.mockImplementation(
    (
      refresh: (
        observations: readonly ProcessGroupObservation[],
      ) => readonly ProcessGroupObservationRefresh[] | undefined,
      observations: readonly ProcessGroupObservation[],
    ) => refresh(observations),
  );
});

afterEach(() => {
  setProcessEpochReaderForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const spec = (purpose = "test operation") => ({
  source: "test.app-process-plane",
  purpose,
  command: "/usr/bin/example",
  args: ["--probe"],
});

const terminalSpec = (purpose = "test terminal") => ({
  ...spec(purpose),
  cwd: "/tmp/vellum-terminal",
  env: { TERM: "vellum-test" },
  cols: 120,
  rows: 32,
});

const epochRow = (
  pid: number,
  processGroupId: number,
  sessionId: number,
  startKey: string,
): ProcessEpochRow => ({ pid, processGroupId, sessionId, startKey });

describe("app process plane admission", () => {
  it("closes child, group, terminal, and daemon admission synchronously and monotonically", () => {
    const plane = createAppProcessPlane();
    plane.beginShutdown();
    plane.beginShutdown();

    expect(plane.isQuiescing()).toBe(true);
    expect(() => plane.spawnChild(spec())).toThrow(
      APP_PROCESS_PLANE_QUIESCING_ERROR,
    );
    expect(() => plane.spawnGroup(spec())).toThrow(
      APP_PROCESS_PLANE_QUIESCING_ERROR,
    );
    expect(() => plane.spawnTerminal(terminalSpec())).toThrow(
      APP_PROCESS_PLANE_QUIESCING_ERROR,
    );
    expect(() => plane.spawnOutlivingDaemon({
      ...spec("daemon"),
      lifetime: "outlives-app",
    })).toThrow(APP_PROCESS_PLANE_QUIESCING_ERROR);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.spawnDetachedProcessGroup).not.toHaveBeenCalled();
  });

  it("returns a frozen IO facade and rejects a structurally forged lease", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane();
    const lease = plane.spawnChild(spec());

    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.io)).toBe(true);
    expect(lease.io).not.toBe(child);
    expect("kill" in lease.io).toBe(false);
    expect("child" in lease).toBe(false);
    expect("release" in lease).toBe(false);
    expect("owned" in lease).toBe(false);

    const forged = { ...lease } as unknown as AppProcessLease;
    expect(plane.forceTerminate(forged, "forgery probe")).toEqual({
      signal: "SIGKILL",
      reason: "forgery probe",
      attempted: false,
      decision: { ok: false, reason: "lease-not-registered" },
      via: "none",
    });
    expect(mocks.signalOwned).not.toHaveBeenCalled();
  });

  it("binds the signal sink at spawn so child.kill replacement cannot redirect it", () => {
    const child = new FakeChild();
    const originalKill = child.kill;
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane();
    const lease = plane.spawnChild(spec());
    const redirectedKill = vi.fn(() => true);
    child.kill = redirectedKill;

    expect(plane.terminate(lease, "operation timeout").attempted).toBe(true);
    expect(originalKill).toHaveBeenCalledWith("SIGTERM");
    expect(redirectedKill).not.toHaveBeenCalled();
  });

  it("inherits only a validated parent descriptor as child fd 3", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane();

    plane.spawnChild({
      ...spec("descriptor-backed child"),
      inheritedFileDescriptor: {
        parentFd: 57,
        childFd: 3,
      },
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/bin/example",
      ["--probe"],
      {
        cwd: undefined,
        env: undefined,
        shell: undefined,
        uid: undefined,
        gid: undefined,
        detached: false,
        stdio: ["pipe", "pipe", "pipe", 57],
      },
    );

    mocks.spawn.mockClear();
    expect(() => plane.spawnChild({
      ...spec("invalid descriptor"),
      inheritedFileDescriptor: {
        parentFd: -1,
        childFd: 3,
      },
    })).toThrow(/non-stdio parent descriptor/);
    expect(mocks.spawn).not.toHaveBeenCalled();

    expect(() => plane.spawnChild({
      ...spec("invalid child mapping"),
      inheritedFileDescriptor: {
        parentFd: 57,
        childFd: 4,
      } as never,
    })).toThrow(/child fd 3/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("coalesces repeated TERM and KILL requests to their first frozen receipts", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane();
    const lease = plane.spawnChild(spec());

    const term = plane.terminate(lease, "first TERM owner");
    expect(plane.terminate(lease, "duplicate TERM owner")).toBe(term);
    const kill = plane.forceTerminate(lease, "first KILL owner");
    expect(plane.forceTerminate(lease, "duplicate KILL owner")).toBe(kill);

    expect(term.reason).toBe("first TERM owner");
    expect(kill.reason).toBe("first KILL owner");
    expect(Object.isFrozen(term)).toBe(true);
    expect(Object.isFrozen(kill)).toBe(true);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("passes only typed SSH identity options while retaining plane-owned spawn controls", () => {
    const child = new FakeChild();
    mocks.spawnDetachedProcessGroup.mockReturnValue({
      child,
      process: mintOwned({ kill: child.kill.bind(child) }),
      mode: "child",
    });
    const plane = createAppProcessPlane();
    plane.spawnGroup({
      ...spec("SSH command"),
      shell: "/bin/zsh",
      uid: 501,
      gid: 20,
    });

    expect(mocks.spawnDetachedProcessGroup).toHaveBeenCalledWith({
      source: "test.app-process-plane",
      command: "/usr/bin/example",
      args: ["--probe"],
      options: {
        cwd: undefined,
        env: undefined,
        shell: "/bin/zsh",
        uid: 501,
        gid: 20,
      },
    });
    const options = mocks.spawnDetachedProcessGroup.mock.calls[0]?.[0]?.options;
    expect(options).not.toHaveProperty("detached");
    expect(options).not.toHaveProperty("stdio");
  });

  it("settles close-only terminal promises without fabricating an exit callback", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane();
    const lease = plane.spawnChild(spec());
    const onExit = vi.fn();
    const onClose = vi.fn();
    lease.io.onExit(onExit);
    lease.io.onClose(onClose);

    child.close(1, null);

    await expect(lease.io.exited).resolves.toEqual({ code: 1, signal: null });
    await expect(lease.io.closed).resolves.toEqual({ code: 1, signal: null });
    expect(onExit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith({ code: 1, signal: null });
    expect(child.listenerCount("error")).toBe(0);

    const lateExit = vi.fn();
    lease.io.onExit(lateExit);
    expect(lateExit).not.toHaveBeenCalled();
  });

  it("observes a synchronous close before returning the lease", async () => {
    class SynchronouslyClosingChild extends FakeChild {
      override once(event: string | symbol, listener: (...args: any[]) => void): this {
        super.once(event, listener);
        if (event === "close") this.close(0, null);
        return this;
      }
    }

    const child = new SynchronouslyClosingChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 10 });
    const lease = plane.spawnChild(spec());

    await expect(lease.io.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(lease.io.closed).resolves.toEqual({ code: 0, signal: null });
    await expect(plane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
  });
});

describe("app terminal process plane", () => {
  it("owns a PTY behind a frozen safe facade and retires on its exit witness", async () => {
    const nodePty = require("node-pty") as typeof import("node-pty");
    const pty = new FakePty();
    const ptySpawn = vi.spyOn(nodePty, "spawn").mockReturnValue(pty.asPty());
    const originalKill = pty.kill;
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnTerminal(terminalSpec("interactive shell"));

    expect(ptySpawn).toHaveBeenCalledWith(
      "/usr/bin/example",
      ["--probe"],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: "/tmp/vellum-terminal",
        env: { TERM: "vellum-test" },
        handleFlowControl: true,
      },
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.io)).toBe(true);
    expect(lease.io.pidForDiagnostics).toBe(43_001);
    expect("kill" in lease.io).toBe(false);
    expect("pty" in lease).toBe(false);
    expect("owned" in lease).toBe(false);
    expect("release" in lease).toBe(false);

    const data = vi.fn();
    const exited = vi.fn();
    lease.io.onData(data);
    lease.io.onExit(exited);
    lease.io.write("echo vellum\n");
    lease.io.resize?.(132, 44);
    pty.emitData("vellum\r\n");
    expect(pty.write).toHaveBeenCalledWith("echo vellum\n");
    expect(pty.resize).toHaveBeenCalledWith(132, 44);
    expect(data).toHaveBeenCalledWith("vellum\r\n");

    const redirectedKill = vi.fn();
    (pty as unknown as { kill: (signal?: string) => void }).kill = redirectedKill;
    const term = plane.terminate(lease, "terminal timeout");
    expect(plane.terminate(lease, "duplicate timeout")).toBe(term);
    const kill = plane.forceTerminate(lease, "terminal force stop");
    expect(plane.forceTerminate(lease, "duplicate force stop")).toBe(kill);
    expect(originalKill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(redirectedKill).not.toHaveBeenCalled();

    pty.emitExit(0, 15);
    await expect(lease.io.exited).resolves.toEqual({ code: 0, signal: 15 });
    expect(exited).toHaveBeenCalledWith({ code: 0, signal: 15 });
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
    expect(() => lease.io.write("late input")).toThrow(
      "terminal process already exited",
    );
    await expect(plane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });

    const forged = { ...lease } as unknown as AppTerminalLease;
    expect(plane.terminate(forged, "forgery probe")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "lease-not-registered" },
    });
  });

  it("fails closed when node-pty cannot load in the default release policy", () => {
    const nodePty = require("node-pty") as typeof import("node-pty");
    vi.spyOn(nodePty, "spawn").mockImplementation(() => {
      throw new Error("PTY unavailable");
    });
    const plane = createAppProcessPlane();

    expect(() => plane.spawnTerminal(terminalSpec())).toThrow(TerminalBackendUnavailableError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("cannot unlock a fallback through ambient test or development environment", () => {
    const nodePty = require("node-pty") as typeof import("node-pty");
    vi.spyOn(nodePty, "spawn").mockImplementation(() => {
      throw new Error("PTY unavailable");
    });
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "true");
    const plane = createAppProcessPlane();

    expect(() => plane.spawnTerminal(terminalSpec())).toThrow(TerminalBackendUnavailableError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("boundedly tears down listener setup failure without spawning a fallback", async () => {
    vi.useFakeTimers();
    const nodePty = require("node-pty") as typeof import("node-pty");
    const pty = new FakePty();
    const setupError = new Error("PTY data subscription failed");
    pty.onData.mockImplementationOnce(() => {
      throw setupError;
    });
    pty.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") pty.emitExit(1, 9);
    });
    vi.spyOn(nodePty, "spawn").mockReturnValue(pty.asPty());
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });

    expect(() => plane.spawnTerminal(terminalSpec("broken PTY"))).toThrow(
      setupError,
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(pty.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(10);
    expect(pty.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
    await expect(plane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an unwitnessed PTY after bounded setup-failure escalation", async () => {
    vi.useFakeTimers();
    const nodePty = require("node-pty") as typeof import("node-pty");
    const pty = new FakePty();
    const setupError = new Error("PTY exit subscription failed");
    pty.onExit.mockImplementationOnce(() => {
      throw setupError;
    });
    vi.spyOn(nodePty, "spawn").mockReturnValue(pty.asPty());
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });

    expect(() => plane.spawnTerminal(terminalSpec("unwitnessed PTY"))).toThrow(
      setupError,
    );
    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);

    await expect(draining).resolves.toMatchObject({
      clean: false,
      stragglers: [{
        purpose: "unwitnessed PTY",
        mode: "terminal",
        state: "running",
        term: { attempted: true, reason: "terminal-listener-setup-failed" },
        kill: { attempted: true, reason: "terminal-listener-setup-failed" },
      }],
    });
    expect(pty.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(mocks.releaseOwned).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("app process plane drain", () => {
  it("coalesces domain TERM with aggregate TERM while still issuing one KILL", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnChild(spec("domain-owned timeout"));
    const domainTerm = plane.terminate(lease, "domain-timeout");

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(draining).resolves.toMatchObject({
      clean: false,
      stragglers: [{
        term: { reason: "domain-timeout" },
        kill: { reason: "app-quit-drain" },
      }],
    });

    expect(plane.terminate(lease, "post-drain duplicate")).toBe(domainTerm);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an unattempted TERM and then coalesces its successful delivery", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill
      .mockImplementationOnce(() => false)
      .mockImplementationOnce((signal) => {
        child.exitAndClose(null, signal ?? null);
        return true;
      });
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnChild(spec("retrying signal refusal"));

    const refused = plane.terminate(lease, "first TERM owner");
    expect(refused).toMatchObject({
      attempted: false,
      reason: "first TERM owner",
      decision: { ok: false, reason: "child-signal-refused" },
    });

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(0);
    await expect(draining).resolves.toEqual({ clean: true, stragglers: [] });
    const delivered = plane.terminate(lease, "post-drain duplicate");
    expect(delivered).not.toBe(refused);
    expect(delivered).toMatchObject({
      attempted: true,
      reason: "app-quit-drain",
    });
    expect(plane.terminate(lease, "another duplicate")).toBe(delivered);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends TERM, then KILL, and reports clean only after close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.exitAndClose(null, "SIGKILL");
      return true;
    });
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnChild(spec());

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(10);
    await expect(draining).resolves.toEqual({ clean: true, stragglers: [] });
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the latest refusal provenance after both bounded signal phases", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnChild(spec("settled caller operation"));
    expect(plane.terminate(lease, "earlier domain refusal")).toMatchObject({
      attempted: false,
      reason: "earlier domain refusal",
    });

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15);

    await expect(draining).resolves.toEqual({
      clean: false,
      stragglers: [{
        generation: 1,
        source: "test.app-process-plane",
        purpose: "settled caller operation",
        mode: "child",
        state: "refused",
        pid: 42_001,
        term: {
          signal: "SIGTERM",
          reason: "app-quit-drain",
          attempted: false,
          decision: { ok: false, reason: "child-signal-refused" },
          via: "none",
        },
        kill: {
          signal: "SIGKILL",
          reason: "app-quit-drain",
          attempted: false,
          decision: { ok: false, reason: "child-signal-refused" },
          via: "none",
        },
      }],
    });
    expect(child.kill.mock.calls).toEqual([
      ["SIGTERM"],
      ["SIGTERM"],
      ["SIGKILL"],
    ]);
    expect(mocks.releaseOwned).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a settled unclean drain to converge after a late close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnChild(spec());

    const first = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({ clean: false });

    child.close(null, "SIGKILL");
    await expect(lease.io.exited).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
    const retry = plane.drainOnQuit();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toEqual({ clean: true, stragglers: [] });
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes one drain flight before a signal callback can re-enter", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnChild(spec());
    let reenteredDrain: ReturnType<typeof plane.drainOnQuit> | undefined;
    child.kill.mockImplementation((signal) => {
      expect(() => plane.spawnChild(spec("reentrant late spawn"))).toThrow(
        APP_PROCESS_PLANE_QUIESCING_ERROR,
      );
      reenteredDrain = plane.drainOnQuit();
      child.exitAndClose(null, signal ?? null);
      return true;
    });

    const first = plane.drainOnQuit();
    const concurrent = plane.drainOnQuit();
    expect(concurrent).toBe(first);
    await vi.advanceTimersByTimeAsync(0);

    expect(reenteredDrain).toBe(first);
    await expect(first).resolves.toEqual({ clean: true, stragglers: [] });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never KILLs an exited leader and retains it until close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") child.exit(null, "SIGTERM");
      return true;
    });
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnChild(spec());

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(draining).resolves.toMatchObject({
      clean: false,
      stragglers: [{ state: "exited-awaiting-close" }],
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
  });

  it("observes descendant drainage and converges without signaling an exited leader", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const descendantPid = child.pid! + 1;
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      epochRow(child.pid!, child.pid!, 77, "leader-a"),
      epochRow(descendantPid, child.pid!, 77, "descendant-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const owned = mintOwned({ kill: child.kill.bind(child) });
    mocks.spawnDetachedProcessGroup.mockReturnValue({
      child,
      process: owned,
      mode: "group",
    });
    mocks.signalOwned.mockImplementation((handle: FakeOwned, signal: NodeJS.Signals) => {
      handle.sink.kill(signal);
      return successfulSignal("group");
    });
    child.kill.mockImplementation((signal) => {
      snapshot = [epochRow(descendantPid, child.pid!, 77, "descendant-a")];
      child.exitAndClose(null, signal ?? null);
      setTimeout(() => {
        snapshot = [];
      }, 12);
      return true;
    });
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    const lease = plane.spawnGroup(spec("detached worker tree"));

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(lease.io.closed).resolves.toEqual({
      code: null,
      signal: "SIGTERM",
    });
    await expect(draining).resolves.toEqual({ clean: true, stragglers: [] });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.releaseOwned).toHaveBeenCalledOnce();
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes a retained group tombstone on a later drain retry", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const descendantPid = child.pid! + 1;
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      epochRow(child.pid!, child.pid!, 78, "leader-a"),
      epochRow(descendantPid, child.pid!, 78, "descendant-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const owned = mintOwned({ kill: child.kill.bind(child) });
    mocks.spawnDetachedProcessGroup.mockReturnValue({
      child,
      process: owned,
      mode: "group",
    });
    mocks.signalOwned.mockImplementation((handle: FakeOwned, signal: NodeJS.Signals) => {
      handle.sink.kill(signal);
      return successfulSignal("group");
    });
    child.kill.mockImplementation((signal) => {
      snapshot = [epochRow(descendantPid, child.pid!, 78, "descendant-a")];
      child.exitAndClose(null, signal ?? null);
      return true;
    });
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnGroup(spec("late descendant"));

    const first = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({
      clean: false,
      stragglers: [{ state: "leaderless-group" }],
    });

    snapshot = [];
    const retry = plane.drainOnQuit();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toEqual({ clean: true, stragglers: [] });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an entire group refresh batch when one entry is malformed", async () => {
    vi.useFakeTimers();
    const first = new FakeChild();
    const second = new FakeChild();
    second.pid = 42_002;
    let snapshot: readonly ProcessEpochRow[] = [
      epochRow(first.pid!, first.pid!, 80, "first-leader"),
      epochRow(second.pid!, second.pid!, 81, "second-leader"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    mocks.spawnDetachedProcessGroup
      .mockReturnValueOnce({
        child: first,
        process: mintOwned({ kill: first.kill.bind(first) }),
        mode: "group",
      })
      .mockReturnValueOnce({
        child: second,
        process: mintOwned({ kill: second.kill.bind(second) }),
        mode: "group",
      });
    const exitGroup = (child: FakeChild) => (signal?: NodeJS.Signals): boolean => {
      snapshot = snapshot.filter((row) => row.pid !== child.pid);
      child.exitAndClose(null, signal ?? null);
      return true;
    };
    first.kill.mockImplementation(exitGroup(first));
    second.kill.mockImplementation(exitGroup(second));
    mocks.refreshProcessGroupObservations.mockImplementation(
      (
        refresh: (
          observations: readonly ProcessGroupObservation[],
        ) => readonly ProcessGroupObservationRefresh[] | undefined,
        observations: readonly ProcessGroupObservation[],
      ) => {
        const refreshed = refresh(observations);
        if (
          refreshed === undefined ||
          refreshed.length !== 2 ||
          !refreshed.every((entry) => entry.clean)
        ) return refreshed;
        const malformed = refreshed[1]!;
        return [
          refreshed[0]!,
          {
            ...malformed,
            observation: {
              ...malformed.observation,
              originalProcessGroupId:
                malformed.observation.originalProcessGroupId + 1,
            },
          },
        ];
      },
    );
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnGroup(spec("first retained group"));
    plane.spawnGroup(spec("second retained group"));

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    const result = await draining;
    expect(result).toMatchObject({
      clean: false,
      stragglers: [
        { purpose: "first retained group", state: "leaderless-group" },
        { purpose: "second retained group", state: "leaderless-group" },
      ],
    });
    expect(mocks.releaseOwned).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps unavailable capture ownership explicitly unverified forever", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let snapshot: readonly ProcessEpochRow[] | undefined;
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const owned = mintOwned({ kill: child.kill.bind(child) });
    mocks.spawnDetachedProcessGroup.mockReturnValue({
      child,
      process: owned,
      mode: "group",
    });
    mocks.signalOwned.mockImplementation((handle: FakeOwned, signal: NodeJS.Signals) => {
      handle.sink.kill(signal);
      return successfulSignal("group");
    });
    child.kill.mockImplementation((signal) => {
      child.exitAndClose(null, signal ?? null);
      return true;
    });
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnGroup(spec("unverified group"));

    const first = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({
      clean: false,
      stragglers: [{ state: "ownership-unverified" }],
    });

    snapshot = [];
    const retry = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(retry).resolves.toMatchObject({
      clean: false,
      stragglers: [{ state: "ownership-unverified" }],
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a verified tombstone unclean when refresh is unavailable", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    let snapshot: readonly ProcessEpochRow[] | undefined = [
      epochRow(child.pid!, child.pid!, 79, "leader-a"),
    ];
    setProcessEpochReaderForTests({ snapshot: () => snapshot });
    const owned = mintOwned({ kill: child.kill.bind(child) });
    mocks.spawnDetachedProcessGroup.mockReturnValue({
      child,
      process: owned,
      mode: "group",
    });
    mocks.signalOwned.mockImplementation((handle: FakeOwned, signal: NodeJS.Signals) => {
      handle.sink.kill(signal);
      return successfulSignal("group");
    });
    child.kill.mockImplementation((signal) => {
      snapshot = undefined;
      child.exitAndClose(null, signal ?? null);
      return true;
    });
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnGroup(spec("unavailable refresh"));

    const draining = plane.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(draining).resolves.toMatchObject({
      clean: false,
      stragglers: [{ state: "leaderless-group" }],
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("outlives-app daemon handoff", () => {
  it("returns readiness only and receives zero app-drain signals", async () => {
    const daemon = new FakeChild();
    mocks.spawn.mockReturnValue(daemon);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 10 });
    const handoff = plane.spawnOutlivingDaemon({
      ...spec("persistent daemon"),
      lifetime: "outlives-app",
    });

    expect(Object.keys(handoff)).toEqual(["readiness"]);
    expect("pid" in handoff).toBe(false);
    expect("kill" in handoff).toBe(false);
    expect("lease" in handoff).toBe(false);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/usr/bin/example",
      ["--probe"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(daemon.unref).toHaveBeenCalledOnce();

    daemon.emit("spawn");
    await expect(handoff.readiness).resolves.toEqual({ ready: true });
    await expect(plane.drainOnQuit()).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    expect(daemon.kill).not.toHaveBeenCalled();
    expect(mocks.admitChildProcess).not.toHaveBeenCalled();
    expect(mocks.signalOwned).not.toHaveBeenCalled();
    expect(mocks.releaseOwned).not.toHaveBeenCalled();
  });
});
