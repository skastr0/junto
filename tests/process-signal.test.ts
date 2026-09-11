import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import {
  admitChildProcess,
  clearProcessSignalAuditLog,
  getProcessSignalAuditLog,
  releaseOwned,
  signalOwned,
  signalOwnedGroupLeader,
  spawnDetachedProcessGroup,
  KillablePid,
  type OwnedProcess,
} from "../src/main/vellum-command/process-signal";
import {
  captureChildProcessEpoch,
  captureProcessGroupEpoch,
  childProcessEpochIsCurrent,
  processGroupEpochIsCurrent,
  setProcessEpochReaderForTests,
  type ProcessEpochRow,
} from "../src/main/vellum-command/process-epoch";
import { Schema } from "effect";

const row = (
  pid: number,
  startKey: string,
  processGroupId = pid,
  sessionId = 7,
): ProcessEpochRow => ({ pid, processGroupId, sessionId, startKey });

afterEach(() => {
  setProcessEpochReaderForTests(undefined);
  clearProcessSignalAuditLog();
  vi.restoreAllMocks();
});

describe("process-signal authority", () => {
  it("retains self and parent pid rejection as a group-mint defense", () => {
    expect(Schema.decodeUnknownResult(KillablePid)(process.pid)._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(KillablePid)(process.ppid)._tag).toBe("Failure");
  });
  it("has no raw-pid admission export", async () => {
    const surface = await import("../src/main/vellum-command/process-signal");
    expect("admitSpawnedProcess" in surface).toBe(false);
    expect("registerOwnedProcess" in surface).toBe(false);
  });

  it("forged handle is refused", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalOwned({ source: "forged" } as unknown as OwnedProcess, "SIGKILL").decision).toMatchObject({ ok: false, reason: "handle-not-registered" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps a genuinely pid-less child wrapper opaque and handle-scoped", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const kill = vi.fn();
    const owned = admitChildProcess({ source: "term", child: { kill } });
    expect(signalOwned(owned, "SIGTERM").via).toBe("child.kill");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("signals a numeric child only while its captured start epoch is current", () => {
    const pid = 41_001;
    setProcessEpochReaderForTests({ snapshot: () => [row(pid, "child-a", 91, 12)] });
    const kill = vi.fn(() => true);
    const owned = admitChildProcess({ source: "numeric", child: { pid, kill } });

    expect(signalOwned(owned, "SIGTERM")).toEqual({
      attempted: true,
      decision: { ok: true, mode: "child" },
      via: "child.kill",
    });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("audits an explicit false child.kill result as a refused attempt", () => {
    const kill = vi.fn(() => false);
    const owned = admitChildProcess({ source: "opaque-refusal", child: { kill } });

    expect(signalOwned(owned, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "child-signal-refused" },
      via: "none",
    });
    expect(getProcessSignalAuditLog()).toEqual([
      expect.objectContaining({
        source: "opaque-refusal",
        pid: undefined,
        requestedGroup: false,
        decision: { ok: false, reason: "child-signal-refused" },
      }),
    ]);
  });

  it("refuses a numeric child whose pid mutates after admission", () => {
    const admittedPid = 41_002;
    let currentPid: number | undefined = admittedPid;
    setProcessEpochReaderForTests({ snapshot: () => [row(admittedPid, "child-a")] });
    const kill = vi.fn();
    const child = { get pid() { return currentPid; }, kill };
    const owned = admitChildProcess({ source: "mutated", child });
    currentPid = admittedPid + 1;

    expect(signalOwned(owned, "SIGKILL")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "child-pid-mismatch" },
      via: "none",
    });
    expect(kill).not.toHaveBeenCalled();
    expect(getProcessSignalAuditLog().at(-1)).toMatchObject({
      source: "mutated",
      pid: admittedPid,
      requestedGroup: false,
    });
  });

  it("refuses a numeric child whose pid disappears after admission", () => {
    const pid = 41_003;
    let currentPid: number | undefined = pid;
    setProcessEpochReaderForTests({ snapshot: () => [row(pid, "child-a")] });
    const kill = vi.fn();
    const child = { get pid() { return currentPid; }, kill };
    const owned = admitChildProcess({ source: "missing", child });
    currentPid = undefined;

    expect(signalOwned(owned, "SIGTERM").decision).toEqual({
      ok: false,
      reason: "child-pid-unavailable",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses a reused numeric pid whose start epoch changed", () => {
    const pid = 41_004;
    let startKey = "child-a";
    setProcessEpochReaderForTests({ snapshot: () => [row(pid, startKey)] });
    const kill = vi.fn();
    const owned = admitChildProcess({ source: "reused", child: { pid, kill } });
    startKey = "child-b";

    expect(signalOwned(owned, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "child-epoch-mismatch" },
      via: "none",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("mints inert authority when a numeric child epoch cannot be captured", () => {
    const pid = 41_005;
    setProcessEpochReaderForTests({ snapshot: () => undefined });
    const kill = vi.fn();
    const owned = admitChildProcess({ source: "unobserved", child: { pid, kill } });

    expect(signalOwned(owned, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "child-epoch-unavailable" },
      via: "none",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([1, process.pid, process.ppid, 0, -1])(
    "mints inert authority for dangerous numeric pid %s",
    (pid) => {
      setProcessEpochReaderForTests({ snapshot: () => [row(pid, "dangerous")] });
      const kill = vi.fn();
      const owned = admitChildProcess({ source: "dangerous", child: { pid, kill } });

      expect(signalOwned(owned, "SIGKILL")).toMatchObject({
        attempted: false,
        decision: { ok: false, reason: "child-pid-not-killable" },
        via: "none",
      });
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("central detached spawn mints verified group authority", async () => {
    const source = await import("node:child_process");
    const original = source.spawn;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const spawned = spawnDetachedProcessGroup({ source: "test", command: "/bin/sh", args: ["-c", "sleep 0.2"] });
    const closed = once(spawned.child, "close");
    expect(spawned.child.pid).toBeTypeOf("number");
    expect(spawned.mode).toBe("group");
    expect(signalOwned(spawned.process, "SIGTERM").via).toBe("process.kill-group");
    expect(spy).toHaveBeenCalledWith(-spawned.child.pid!, "SIGTERM");
    // The mocked group signal does not terminate the real child. Keep its
    // authority until the bounded fixture exits naturally and close is seen.
    await closed;
    releaseOwned(spawned.process);
    expect(original).toBeTypeOf("function");
  });

  it("attenuates graceful group shutdown to the spawn-bound exact leader", async () => {
    const spawned = spawnDetachedProcessGroup({
      source: "cooperative-group",
      command: "/bin/sleep",
      args: ["5"],
    });
    const closed = once(spawned.child, "close");
    expect(spawned.mode).toBe("group");
    const redirectedKill = vi.fn(() => true);
    spawned.child.kill = redirectedKill;

    expect(signalOwnedGroupLeader(spawned.process, "SIGTERM")).toEqual({
      attempted: true,
      decision: { ok: true, mode: "child" },
      via: "child.kill",
    });
    expect(redirectedKill).not.toHaveBeenCalled();
    await closed;
    releaseOwned(spawned.process);
  });

  it("refuses non-TERM and non-group leader signals", async () => {
    const group = spawnDetachedProcessGroup({
      source: "leader-signal-policy",
      command: "/bin/sh",
      args: ["-c", "sleep 0.2"],
    });
    const groupClosed = once(group.child, "close");
    expect(
      signalOwnedGroupLeader(group.process, "SIGKILL" as never),
    ).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "leader-signal-not-allowed" },
    });

    const childKill = vi.fn();
    const child = admitChildProcess({
      source: "child-not-group",
      child: { kill: childKill },
    });
    expect(signalOwnedGroupLeader(child, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "group-leader-authority-required" },
    });
    expect(childKill).not.toHaveBeenCalled();
    releaseOwned(child);
    await groupClosed;
    releaseOwned(group.process);
  });

  it("epoch drift refuses group kill without signaling its child", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const spawned = spawnDetachedProcessGroup({ source: "test", command: "/bin/sh", args: ["-c", "sleep 0.2"] });
    const closed = once(spawned.child, "close");
    setProcessEpochReaderForTests({ snapshot: () => [{ pid: spawned.child.pid!, processGroupId: spawned.child.pid!, sessionId: 42, startKey: "epoch-b" }] });
    expect(signalOwned(spawned.process, "SIGTERM").via).toBe("none");
    expect(spy).not.toHaveBeenCalled();
    await closed;
    releaseOwned(spawned.process);
  });

  it("epoch drift also refuses exact-leader signaling", async () => {
    const spawned = spawnDetachedProcessGroup({
      source: "leader-epoch-drift",
      command: "/bin/sh",
      args: ["-c", "sleep 0.2"],
    });
    const closed = once(spawned.child, "close");
    const redirectedKill = vi.fn(() => true);
    spawned.child.kill = redirectedKill;
    setProcessEpochReaderForTests({
      snapshot: () => [{
        pid: spawned.child.pid!,
        processGroupId: spawned.child.pid!,
        sessionId: 42,
        startKey: "epoch-b",
      }],
    });

    expect(signalOwnedGroupLeader(spawned.process, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "group-epoch-mismatch" },
      via: "none",
    });
    expect(redirectedKill).not.toHaveBeenCalled();
    await closed;
    releaseOwned(spawned.process);
  });

  it("refuses a leaderless group even when members remain", () => {
    let members: readonly { pid: number; processGroupId: number; sessionId: number; startKey: string }[] = [];
    setProcessEpochReaderForTests({ snapshot: () => members });
    const epoch = { startKey: "old", processGroupId: 77, sessionId: 9 };
    members = [{ pid: 88, processGroupId: 77, sessionId: 9, startKey: "member" }];
    expect(processGroupEpochIsCurrent(77, epoch)).toBe(false);
    members = [];
    expect(processGroupEpochIsCurrent(77, epoch)).toBe(false);
    members = [{ pid: 77, processGroupId: 77, sessionId: 9, startKey: "reused" }];
    expect(processGroupEpochIsCurrent(77, epoch)).toBe(false);
  });

  it("does not authorize hybrid identity rows from separate snapshots", () => {
    let phase = 0;
    setProcessEpochReaderForTests({ snapshot: () => {
      phase += 1;
      return phase === 1
        ? [{ pid: 55, processGroupId: 55, sessionId: 2, startKey: "a" }]
        : [{ pid: 55, processGroupId: 55, sessionId: 2, startKey: "b" }];
    } });
    const epoch = captureProcessGroupEpoch(55)!;
    expect(processGroupEpochIsCurrent(55, epoch)).toBe(false);
  });

  it("captures and revalidates one child epoch from coherent snapshots", () => {
    let startKey = "child-a";
    setProcessEpochReaderForTests({ snapshot: () => [row(56, startKey, 44, 3)] });
    const epoch = captureChildProcessEpoch(56)!;
    expect(childProcessEpochIsCurrent(56, epoch)).toBe(true);
    startKey = "child-b";
    expect(childProcessEpochIsCurrent(56, epoch)).toBe(false);
  });

  it("reuses a verified child epoch when detached group identity is unavailable", async () => {
    setProcessEpochReaderForTests({
      snapshot: (pid) => pid === undefined ? [] : [row(pid, "verified-child", pid + 1, 3)],
    });
    const spawned = spawnDetachedProcessGroup({ source: "fallback", command: "/bin/sh", args: ["-c", "sleep 0.2"] });
    const closed = once(spawned.child, "close");
    expect(spawned.mode).toBe("child");
    expect(signalOwned(spawned.process, "SIGTERM")).toMatchObject({
      attempted: true,
      decision: { ok: true, mode: "child" },
      via: "child.kill",
    });
    await closed;
    releaseOwned(spawned.process);
  });

  it("reports an inert child fallback when no detached identity can be captured", async () => {
    setProcessEpochReaderForTests({ snapshot: () => [] });
    const spawned = spawnDetachedProcessGroup({ source: "fallback-inert", command: "/bin/sh", args: ["-c", "sleep 0.2"] });
    const closed = once(spawned.child, "close");
    expect(spawned.mode).toBe("child");
    expect(signalOwned(spawned.process, "SIGTERM")).toMatchObject({
      attempted: false,
      decision: { ok: false, reason: "child-epoch-unavailable" },
      via: "none",
    });
    await closed;
    releaseOwned(spawned.process);
  });

  it("release is idempotent and loses authority", () => {
    const kill = vi.fn(); const owned = admitChildProcess({ source: "test", child: { kill } });
    releaseOwned(owned); releaseOwned(owned);
    expect(signalOwned(owned, "SIGTERM").decision).toMatchObject({ ok: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it("source contains no positive terminating process.kill branch", async () => {
    const source = await readFile("src/main/vellum-command/process-signal.ts", "utf8");
    expect(source).not.toMatch(/process\.kill\(rec\.pid/);
    expect(source).toMatch(/process\.kill\(-rec\.pid/);
  });
});
