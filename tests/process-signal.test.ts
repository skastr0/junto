import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  admitSpawnedProcess,
  classifyProcessSignalTarget,
  clearProcessSignalAuditLog,
  getProcessSignalAuditLog,
  KillablePid,
  releaseOwned,
  signalChildHandleOnly,
  signalOwned,
  type OwnedProcess,
} from "../src/main/vellum/process-signal";

afterEach(() => {
  clearProcessSignalAuditLog();
  vi.restoreAllMocks();
});

describe("process-signal architecture (branded OwnedProcess)", () => {
  it("KillablePid schema rejects init, self, parent, zero, negative", () => {
    expect(Schema.decodeUnknownEither(KillablePid)(1)._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(KillablePid)(process.pid)._tag).toBe("Left");
    if (typeof process.ppid === "number") {
      expect(Schema.decodeUnknownEither(KillablePid)(process.ppid)._tag).toBe("Left");
    }
    expect(Schema.decodeUnknownEither(KillablePid)(0)._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(KillablePid)(-1)._tag).toBe("Left");
    expect(Schema.decodeUnknownEither(KillablePid)(4242)._tag).toBe("Right");
  });

  it("classifier mirrors schema refusals", () => {
    expect(classifyProcessSignalTarget({ pid: 1 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: process.pid }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: 4242 }).ok).toBe(true);
  });

  it("admit refuses pid=1 and self — no capability minted", () => {
    const a = admitSpawnedProcess({ source: "t", pid: 1, ownsProcessGroup: true });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("pid-is-init-or-launchd");

    const b = admitSpawnedProcess({ source: "t", pid: process.pid, ownsProcessGroup: true });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("pid-is-self");
  });

  it("forged plain object is not an OwnedProcess at runtime (WeakMap miss)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Type system rejects this assignment in real code; cast only for runtime proof.
    const forged = { source: "evil" } as unknown as OwnedProcess;
    const result = signalOwned(forged, "SIGKILL");
    expect(result.decision.ok).toBe(false);
    expect(result.decision).toMatchObject({ reason: "handle-not-registered" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("term path: admit without group → child.kill only, never process.kill", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    const admitted = admitSpawnedProcess({
      source: "term.test",
      pid: 55_001,
      ownsProcessGroup: false,
      child: { kill: childKill },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const result = signalOwned(admitted.process, "SIGTERM");
    expect(result.via).toBe("child.kill");
    expect(childKill).toHaveBeenCalledWith("SIGTERM");
    expect(spy).not.toHaveBeenCalled();
    releaseOwned(admitted.process);
  });

  it("adapter path: admit with group → process.kill(-pid) only for admitted leader", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const admitted = admitSpawnedProcess({
      source: "adapter.test",
      pid: 66_002,
      ownsProcessGroup: true,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const result = signalOwned(admitted.process, "SIGTERM");
    expect(result.via).toBe("process.kill-group");
    expect(spy).toHaveBeenCalledWith(-66_002, "SIGTERM");
    releaseOwned(admitted.process);
  });

  it("released capability loses all authority", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const admitted = admitSpawnedProcess({
      source: "t",
      pid: 77_003,
      ownsProcessGroup: true,
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    releaseOwned(admitted.process);
    const result = signalOwned(admitted.process, "SIGTERM");
    expect(result.decision.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("signalChildHandleOnly has no pid parameter — cannot OS-kill", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    signalChildHandleOnly({ kill: childKill }, "SIGTERM", "test");
    expect(childKill).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("audit records admit refusals", () => {
    admitSpawnedProcess({ source: "x", pid: 1, ownsProcessGroup: true });
    expect(getProcessSignalAuditLog().some((a) => a.decision.ok === false)).toBe(true);
  });
});
