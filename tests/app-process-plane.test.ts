import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  admitChildProcess: vi.fn(),
  spawnDetachedProcessGroup: vi.fn(),
  signalOwned: vi.fn(),
  releaseOwned: vi.fn(),
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

import {
  APP_PROCESS_PLANE_QUIESCING_ERROR,
  createAppProcessPlane,
  type AppProcessLease,
} from "../src/main/vellum/app-process-plane";
import {
  setProcessEpochReaderForTests,
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
});

afterEach(() => {
  setProcessEpochReaderForTests(undefined);
  vi.useRealTimers();
});

const spec = (purpose = "test operation") => ({
  source: "test.app-process-plane",
  purpose,
  command: "/usr/bin/example",
  args: ["--probe"],
});

const epochRow = (
  pid: number,
  processGroupId: number,
  sessionId: number,
  startKey: string,
): ProcessEpochRow => ({ pid, processGroupId, sessionId, startKey });

describe("app process plane admission", () => {
  it("closes child, group, and daemon admission synchronously and monotonically", () => {
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

  it("retains exact refusal receipts after both bounded signal phases", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    mocks.spawn.mockReturnValue(child);
    const plane = createAppProcessPlane({ termGraceMs: 10, killGraceMs: 15 });
    plane.spawnChild(spec("settled caller operation"));

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
