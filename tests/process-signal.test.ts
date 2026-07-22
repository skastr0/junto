import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  spawnDetachedProcessGroup,
  KillablePid,
  type OwnedProcess,
} from "../src/main/vellum/process-signal";
import { captureProcessGroupEpoch, processGroupEpochIsCurrent, setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { Schema } from "effect";

afterEach(() => { setProcessEpochReaderForTests(undefined); vi.restoreAllMocks(); });

describe("process-signal authority", () => {
  it("retains self and parent pid rejection as a group-mint defense", () => {
    expect(Schema.decodeUnknownEither(KillablePid)(process.pid)._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(KillablePid)(process.ppid)._tag).toBe("Left");
  });
  it("has no raw-pid admission export", async () => {
    const surface = await import("../src/main/vellum/process-signal");
    expect("admitSpawnedProcess" in surface).toBe(false);
    expect("registerOwnedProcess" in surface).toBe(false);
  });

  it("forged handle is refused", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(signalOwned({ source: "forged" } as unknown as OwnedProcess, "SIGKILL").decision).toMatchObject({ ok: false, reason: "handle-not-registered" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("child-only authority never calls process.kill", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const kill = vi.fn();
    const owned = admitChildProcess({ source: "term", child: { kill } });
    expect(signalOwned(owned, "SIGTERM").via).toBe("child.kill");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("central detached spawn mints verified group authority", async () => {
    const source = await import("node:child_process");
    const original = source.spawn;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const spawned = spawnDetachedProcessGroup({ source: "test", command: "/bin/sh", args: ["-c", "sleep 1"] });
    expect(spawned.child.pid).toBeTypeOf("number");
    expect(spawned.mode).toBe("group");
    expect(signalOwned(spawned.process, "SIGTERM").via).toBe("process.kill-group");
    expect(spy).toHaveBeenCalledWith(-spawned.child.pid!, "SIGTERM");
    releaseOwned(spawned.process);
    // The mocked group signal does not terminate the real child.
    spawned.child.kill("SIGKILL");
    expect(original).toBeTypeOf("function");
  });

  it("epoch drift refuses group kill without signaling its child", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const spawned = spawnDetachedProcessGroup({ source: "test", command: "/bin/sh", args: ["-c", "sleep 1"] });
    setProcessEpochReaderForTests({ snapshot: () => [{ pid: spawned.child.pid!, processGroupId: spawned.child.pid!, sessionId: 42, startKey: "epoch-b" }] });
    expect(signalOwned(spawned.process, "SIGTERM").via).toBe("none");
    expect(spy).not.toHaveBeenCalled();
    releaseOwned(spawned.process);
    spawned.child.kill("SIGKILL");
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

  it("reports an explicit child fallback when group identity cannot be captured", () => {
    setProcessEpochReaderForTests({ snapshot: () => [] });
    const spawned = spawnDetachedProcessGroup({ source: "fallback", command: "/bin/sh", args: ["-c", "sleep 1"] });
    expect(spawned.mode).toBe("child");
    releaseOwned(spawned.process);
    spawned.child.kill("SIGKILL");
  });

  it("release is idempotent and loses authority", () => {
    const kill = vi.fn(); const owned = admitChildProcess({ source: "test", child: { kill } });
    releaseOwned(owned); releaseOwned(owned);
    expect(signalOwned(owned, "SIGTERM").decision).toMatchObject({ ok: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it("source contains no positive terminating process.kill branch", async () => {
    const source = await readFile("src/main/vellum/process-signal.ts", "utf8");
    expect(source).not.toMatch(/process\.kill\(rec\.pid/);
    expect(source).toMatch(/process\.kill\(-rec\.pid/);
  });
});
