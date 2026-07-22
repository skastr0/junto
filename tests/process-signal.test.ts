import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProcessSignalTarget,
  clearProcessSignalAuditLog,
  getProcessSignalAuditLog,
  signalOwnedProcess,
} from "../src/main/vellum/process-signal";

afterEach(() => {
  clearProcessSignalAuditLog();
  vi.restoreAllMocks();
});

describe("process-signal sealed authority", () => {
  it("refuses init, self, parent, zero, negative-without-group", () => {
    expect(classifyProcessSignalTarget({ pid: 1 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: process.pid }).ok).toBe(false);
    if (typeof process.ppid === "number") {
      expect(classifyProcessSignalTarget({ pid: process.ppid }).ok).toBe(false);
    }
    expect(classifyProcessSignalTarget({ pid: 0 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: -1 }).ok).toBe(false);
    expect(classifyProcessSignalTarget({ pid: -1, asProcessGroup: true }).ok).toBe(false); // | -1 | = 1
    expect(classifyProcessSignalTarget({ pid: 4242 }).ok).toBe(true);
    expect(classifyProcessSignalTarget({ pid: 4242, asProcessGroup: true }).ok).toBe(true);
  });

  it("never calls process.kill for pid=1 even with ownsProcessGroup", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    const result = signalOwnedProcess({
      source: "test.pid1",
      pid: 1,
      signal: "SIGTERM",
      ownsProcessGroup: true,
      child: { kill: childKill },
    });
    expect(result.decision.ok).toBe(false);
    expect(result.decision).toMatchObject({ reason: "pid-is-init-or-launchd" });
    expect(spy).not.toHaveBeenCalled();
    // Handle path still allowed (fake/test children).
    expect(childKill).toHaveBeenCalledWith("SIGTERM");
    expect(getProcessSignalAuditLog().some((a) => a.decision.ok === false)).toBe(true);
  });

  it("never calls process.kill for pid=self", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = signalOwnedProcess({
      source: "test.self",
      pid: process.pid,
      signal: "SIGKILL",
      ownsProcessGroup: true,
    });
    expect(result.decision.ok).toBe(false);
    expect(result.via).toBe("none");
    expect(spy).not.toHaveBeenCalled();
  });

  it("term path uses child.kill only (no group) for ordinary pids", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.fn();
    const result = signalOwnedProcess({
      source: "term.forceKill:x",
      pid: 55_001,
      signal: "SIGTERM",
      ownsProcessGroup: false,
      child: { kill: childKill },
    });
    expect(result.decision.ok).toBe(true);
    expect(result.via).toBe("child.kill");
    expect(childKill).toHaveBeenCalledWith("SIGTERM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("adapter/ssh path may group-kill only when ownsProcessGroup and pid is safe", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = signalOwnedProcess({
      source: "adapter.signalOwned",
      pid: 66_002,
      signal: "SIGTERM",
      ownsProcessGroup: true,
    });
    expect(result.decision.ok).toBe(true);
    expect(result.via).toBe("process.kill-group");
    expect(spy).toHaveBeenCalledWith(-66_002, "SIGTERM");
  });
});
