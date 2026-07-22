import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProcessSignalTarget,
  clearOwnedProcessRegistryForTests,
  clearProcessSignalAuditLog,
  getProcessSignalAuditLog,
  ownedProcessRegistrySizeForTests,
  registerOwnedProcess,
  releaseOwnedProcess,
  signalChildHandleOnly,
  signalOwnedHandle,
} from "../src/main/vellum/process-signal";

afterEach(() => {
  clearProcessSignalAuditLog();
  clearOwnedProcessRegistryForTests();
  vi.restoreAllMocks();
});

describe("process-signal sealed authority (capability handles)", () => {
  it("classifier refuses init, self, parent, zero, negative", () => {
    expect(classifyProcessSignalTarget({ pid: 1 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: process.pid }).ok).toBe(false);
    if (typeof process.ppid === "number") {
      expect(classifyProcessSignalTarget({ pid: process.ppid }).ok).toBe(false);
    }
    expect(classifyProcessSignalTarget({ pid: 0 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: -1 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: 4242 }).ok).toBe(true);
  });

  it("refuses to register pid=1 / self — no capability issued", () => {
    const a = registerOwnedProcess({
      source: "test",
      pid: 1,
      ownsProcessGroup: true,
    });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("pid-is-init-or-launchd");

    const b = registerOwnedProcess({
      source: "test",
      pid: process.pid,
      ownsProcessGroup: true,
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("pid-is-self");
    expect(ownedProcessRegistrySizeForTests()).toBe(0);
  });

  it("forged handle cannot kill — registry miss, process.kill never called", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const forged = {
      id: "op_forged_not_real",
      source: "evil",
      pid: 66_002,
      ownsProcessGroup: true,
    };
    const result = signalOwnedHandle(forged, "SIGKILL");
    expect(result.decision.ok).toBe(false);
    expect(result.decision).toMatchObject({ reason: "handle-not-registered" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("bare pid path does not exist — only handle after register", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    const reg = registerOwnedProcess({
      source: "term.test",
      pid: 55_001,
      ownsProcessGroup: false,
      child: { kill: childKill },
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const result = signalOwnedHandle(reg.handle, "SIGTERM");
    expect(result.via).toBe("child.kill");
    expect(childKill).toHaveBeenCalledWith("SIGTERM");
    // term path never process.kill
    expect(spy).not.toHaveBeenCalled();
    releaseOwnedProcess(reg.handle);
  });

  it("group kill only when registered with ownsProcessGroup:true", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const reg = registerOwnedProcess({
      source: "adapter.test",
      pid: 66_002,
      ownsProcessGroup: true,
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const result = signalOwnedHandle(reg.handle, "SIGTERM");
    expect(result.via).toBe("process.kill-group");
    expect(spy).toHaveBeenCalledWith(-66_002, "SIGTERM");
    // flipping handle field must not escalate — registry freezes the flag
    const tampered = { ...reg.handle, ownsProcessGroup: false };
    spy.mockClear();
    // still the same id in registry with ownsProcessGroup true
    signalOwnedHandle(tampered, "SIGKILL");
    expect(spy).toHaveBeenCalledWith(-66_002, "SIGKILL");
    releaseOwnedProcess(reg.handle);
  });

  it("released handle loses authority", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const reg = registerOwnedProcess({
      source: "t",
      pid: 77_003,
      ownsProcessGroup: true,
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    releaseOwnedProcess(reg.handle);
    const result = signalOwnedHandle(reg.handle, "SIGTERM");
    expect(result.decision.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("signalChildHandleOnly never touches process.kill", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    signalChildHandleOnly({ kill: childKill }, "SIGTERM", "test.child-only");
    expect(childKill).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("audit records refusals", () => {
    registerOwnedProcess({ source: "x", pid: 1, ownsProcessGroup: true });
    expect(getProcessSignalAuditLog().some((a) => a.decision.ok === false)).toBe(true);
  });
});
