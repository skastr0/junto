import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAUNCHCTL_DEADLINE_MS,
  LAUNCHCTL_PATH,
  createLaunchctlRunner,
  launchAgentTargetForCurrentUser,
  type VellumLaunchAgentTarget,
} from "../src/main/junto/settings/launchctl-runner";
import type {
  AppProcessClose,
  AppProcessLease,
  AppProcessPlane,
  AppProcessSignalReceipt,
} from "../src/main/junto/app-process-plane";

type RunnerProcessPlane = Pick<
  AppProcessPlane,
  "spawnChild" | "terminate" | "forceTerminate" | "isQuiescing"
>;

interface LeaseHarness {
  readonly lease: AppProcessLease;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly close: (event?: AppProcessClose) => void;
  readonly error: (error: Error) => void;
  readonly hasCloseListener: () => boolean;
  readonly hasErrorListener: () => boolean;
}

const makeLeaseHarness = (
  synchronousClose?: AppProcessClose,
): LeaseHarness => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeListener: ((event: AppProcessClose) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const lease = {
    io: {
      stdin,
      stdout,
      stderr,
      onClose: vi.fn((listener: (event: AppProcessClose) => void) => {
        if (synchronousClose !== undefined) {
          listener(synchronousClose);
          return () => undefined;
        }
        closeListener = listener;
        return () => {
          if (closeListener === listener) closeListener = undefined;
        };
      }),
      onError: vi.fn((listener: (error: Error) => void) => {
        errorListener = listener;
        return () => {
          if (errorListener === listener) errorListener = undefined;
        };
      }),
    },
  } as unknown as AppProcessLease;
  return {
    lease,
    stdout,
    stderr,
    close: (event = { code: 0, signal: null }) => closeListener?.(event),
    error: (error) => errorListener?.(error),
    hasCloseListener: () => closeListener !== undefined,
    hasErrorListener: () => errorListener !== undefined,
  };
};

const signalReceipt: AppProcessSignalReceipt = Object.freeze({
  attempted: true,
  decision: { ok: true as const, mode: "child" as const },
  via: "child.kill" as const,
  signal: "SIGTERM" as const,
  reason: "test",
});

const makeProcessPlane = (
  harness: LeaseHarness,
): RunnerProcessPlane => ({
  spawnChild: vi.fn(() => harness.lease),
  terminate: vi.fn(() => signalReceipt),
  forceTerminate: vi.fn(() => ({
    ...signalReceipt,
    signal: "SIGKILL" as const,
  })),
  isQuiescing: vi.fn(() => false),
});

const createTestRunner = (processPlane: RunnerProcessPlane) =>
  createLaunchctlRunner({
    processPlane,
    deadlineMs: 30,
    termGraceMs: 10,
    killGraceMs: 15,
    stdoutCapBytes: 8,
    stderrCapBytes: 6,
  });

const ownedTarget = (): VellumLaunchAgentTarget => {
  const target = launchAgentTargetForCurrentUser();
  if (target === undefined) throw new Error("expected test launch-agent target");
  return target;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "getuid").mockReturnValue(501);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("launchctl runner target boundary", () => {
  it("mints only the current user's fixed Junto target", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createTestRunner(processPlane);
    const target = ownedTarget();

    const running = runner.printLaunchAgent(target);
    harness.close();
    await expect(running).resolves.toMatchObject({
      clean: true,
      ok: true,
      target: "gui/501/skastr0.vellumcommand",
    });
    expect(processPlane.spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["print", "gui/501/skastr0.vellumcommand"],
      }),
    );
  });

  it("refuses forged target objects without opening process admission", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createTestRunner(processPlane);
    const forged = Object.freeze({}) as VellumLaunchAgentTarget;

    await expect(runner.printLaunchAgent(forged)).resolves
      .toMatchObject({
        clean: true,
        ok: false,
        failure: { kind: "invalid-target" },
      });
    expect(processPlane.spawnChild).not.toHaveBeenCalled();
  });

  it("refuses to mint non-canonical user domains", () => {
    for (const uid of [-1, 0xffff_ffff + 1, Number.NaN, 1.5]) {
      vi.mocked(process.getuid!).mockReturnValueOnce(uid);
      expect(launchAgentTargetForCurrentUser(), String(uid)).toBeUndefined();
    }
  });

  it("does not let injected settings relax production safety bounds", () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);

    expect(() => createLaunchctlRunner({
      processPlane,
      deadlineMs: LAUNCHCTL_DEADLINE_MS + 1,
    })).toThrow("launchctl deadline must be an integer from 1 through 3000");
    expect(() => createLaunchctlRunner({
      processPlane,
      stdoutCapBytes: 64 * 1024 + 1,
    })).toThrow("launchctl stdout cap must be an integer from 1 through 65536");
  });
});

describe("launchctl runner process authority", () => {
  it("uses the fixed binary and literal print/kickstart argument shapes", async () => {
    const printHarness = makeLeaseHarness();
    const processPlane = makeProcessPlane(printHarness);
    const runner = createTestRunner(processPlane);

    const printing = runner.printLaunchAgent(ownedTarget());
    printHarness.stdout.write("pid = 9");
    printHarness.close();

    await expect(printing).resolves.toMatchObject({
      clean: true,
      ok: true,
      action: "print",
      stdout: "pid = 9",
    });
    expect(processPlane.spawnChild).toHaveBeenNthCalledWith(1, {
      source: "settings.launchctl-runner",
      purpose: "print launch agent",
      command: LAUNCHCTL_PATH,
      args: ["print", "gui/501/skastr0.vellumcommand"],
      shell: false,
    });

    const kickHarness = makeLeaseHarness();
    vi.mocked(processPlane.spawnChild).mockReturnValueOnce(kickHarness.lease);
    const kicking = runner.kickstartLaunchAgent(ownedTarget());
    kickHarness.close();
    await expect(kicking).resolves.toMatchObject({
      clean: true,
      ok: true,
      action: "kickstart",
    });
    expect(processPlane.spawnChild).toHaveBeenNthCalledWith(2, {
      source: "settings.launchctl-runner",
      purpose: "kickstart launch agent",
      command: LAUNCHCTL_PATH,
      args: ["kickstart", "gui/501/skastr0.vellumcommand"],
      shell: false,
    });
  });

  it("treats process errors as diagnostics and waits for exact close", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createTestRunner(processPlane);
    const running = runner.printLaunchAgent(ownedTarget());
    let settled = false;
    void running.then(() => {
      settled = true;
    });

    harness.error(Object.assign(new Error("permission denied"), {
      code: "EACCES",
    }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(processPlane.terminate).toHaveBeenCalledWith(
      harness.lease,
      "launchctl print bounded teardown",
    );

    harness.close({ code: null, signal: "SIGTERM" });
    await expect(running).resolves.toMatchObject({
      clean: true,
      ok: false,
      failure: {
        kind: "process-error",
        diagnostic: "Error (EACCES): permission denied",
      },
    });
    expect(harness.hasCloseListener()).toBe(false);
    expect(harness.hasErrorListener()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both output streams and tears down on the first overflow", async () => {
    const stdoutHarness = makeLeaseHarness();
    const processPlane = makeProcessPlane(stdoutHarness);
    const runner = createTestRunner(processPlane);
    const stdoutRun = runner.printLaunchAgent(ownedTarget());

    stdoutHarness.stdout.write("123456789-more");
    stdoutHarness.close({ code: null, signal: "SIGTERM" });
    await expect(stdoutRun).resolves.toMatchObject({
      clean: true,
      ok: false,
      stdout: "12345678",
      failure: { kind: "stdout-overflow" },
    });

    const stderrHarness = makeLeaseHarness();
    vi.mocked(processPlane.spawnChild).mockReturnValueOnce(stderrHarness.lease);
    const stderrRun = runner.kickstartLaunchAgent(ownedTarget());
    stderrHarness.stderr.write("abcdefg-more");
    stderrHarness.close({ code: null, signal: "SIGTERM" });
    await expect(stderrRun).resolves.toMatchObject({
      clean: true,
      ok: false,
      stderr: "abcdef",
      failure: { kind: "stderr-overflow" },
    });
    expect(processPlane.terminate).toHaveBeenCalledTimes(2);
  });

  it("runs deadline, TERM, KILL, then reports missing close as unclean", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createLaunchctlRunner({ processPlane });
    const running = runner.printLaunchAgent(ownedTarget());
    let settled = false;
    void running.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(LAUNCHCTL_DEADLINE_MS - 1);
    expect(processPlane.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(processPlane.terminate).toHaveBeenCalledWith(
      harness.lease,
      "launchctl print bounded teardown",
    );
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(processPlane.forceTerminate).toHaveBeenCalledWith(
      harness.lease,
      "launchctl print bounded teardown escalation",
    );
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(running).resolves.toMatchObject({
      clean: false,
      ok: false,
      failure: { kind: "close-timeout" },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.hasCloseListener()).toBe(false);
    expect(harness.hasErrorListener()).toBe(false);
  });

  it("does not arm teardown when close is witnessed synchronously", async () => {
    const harness = makeLeaseHarness({ code: 0, signal: null });
    const processPlane = makeProcessPlane(harness);
    const runner = createTestRunner(processPlane);

    const result = await runner.printLaunchAgent(ownedTarget());

    expect(result).toMatchObject({ clean: true, ok: true });
    expect(processPlane.terminate).not.toHaveBeenCalled();
    expect(processPlane.forceTerminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a close emitted synchronously by TERM", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    vi.mocked(processPlane.terminate).mockImplementation(() => {
      harness.close({ code: null, signal: "SIGTERM" });
      return signalReceipt;
    });
    const runner = createTestRunner(processPlane);
    const running = runner.printLaunchAgent(ownedTarget());

    harness.stdout.write("123456789");

    await expect(running).resolves.toMatchObject({
      clean: true,
      ok: false,
      failure: { kind: "stdout-overflow" },
    });
    expect(processPlane.forceTerminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a signal diagnostic when TERM closes and then throws", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    vi.mocked(processPlane.terminate).mockImplementation(() => {
      harness.close({ code: null, signal: "SIGTERM" });
      throw new Error("TERM sink failed after close");
    });
    const runner = createTestRunner(processPlane);
    const running = runner.printLaunchAgent(ownedTarget());

    harness.error(new Error("spawn error"));

    await expect(running).resolves.toMatchObject({
      clean: true,
      ok: false,
      failure: {
        kind: "process-error",
        diagnostic: expect.stringContaining("TERM sink failed after close"),
      },
    });
    expect(processPlane.forceTerminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when shutdown has already closed process admission", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    vi.mocked(processPlane.isQuiescing).mockReturnValue(true);
    const runner = createTestRunner(processPlane);

    const result = await runner.kickstartLaunchAgent(ownedTarget());

    expect(result).toMatchObject({
      clean: true,
      ok: false,
      failure: { kind: "admission-refused" },
    });
    expect(processPlane.spawnChild).not.toHaveBeenCalled();
  });

  it("distinguishes shutdown refusal from an uncertain synchronous spawn failure", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    vi.mocked(processPlane.spawnChild).mockImplementation(() => {
      throw new Error("unexpected spawn failure");
    });
    const runner = createTestRunner(processPlane);

    await expect(runner.printLaunchAgent(ownedTarget())).resolves
      .toMatchObject({
        clean: false,
        ok: false,
        failure: { kind: "spawn-failed" },
      });

    vi.mocked(processPlane.isQuiescing).mockReturnValue(true);
    await expect(runner.printLaunchAgent(ownedTarget())).resolves
      .toMatchObject({
        clean: true,
        ok: false,
        failure: { kind: "admission-refused" },
      });
  });

  it("returns no pid, child, lease, or process authority", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createTestRunner(processPlane);
    const running = runner.printLaunchAgent(ownedTarget());
    harness.close();

    const result = await running;
    expect(result).not.toHaveProperty("pid");
    expect(result).not.toHaveProperty("child");
    expect(result).not.toHaveProperty("lease");
    expect(result).not.toHaveProperty("process");
  });
});
