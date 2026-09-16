import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppProcessClose,
  AppProcessLease,
  AppProcessPlane,
  AppProcessSignalReceipt,
} from "../src/main/vellum-command/app-process-plane";
import {
  SYSTEMCTL_DEADLINE_MS,
  SYSTEMCTL_PATH,
  VELLUM_COMMAND_SYSTEMD_USER_UNIT,
  createSystemctlRunner,
  systemdUserUnitTarget,
  type VellumSystemdUserUnitTarget,
} from "../src/main/vellum-command/supervision/systemctl-runner";

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
}

const makeLeaseHarness = (): LeaseHarness => {
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("systemctl runner target and argv boundary", () => {
  it("uses one fixed user unit, executable, literal argv, and no shell", async () => {
    const showHarness = makeLeaseHarness();
    const processPlane = makeProcessPlane(showHarness);
    const runner = createSystemctlRunner({ processPlane });

    const showing = runner.showVellumUnit(systemdUserUnitTarget());
    showHarness.close();
    await expect(showing).resolves.toMatchObject({
      clean: true,
      ok: true,
      unit: VELLUM_COMMAND_SYSTEMD_USER_UNIT,
    });
    expect(processPlane.spawnChild).toHaveBeenNthCalledWith(1, {
      source: "supervision.systemctl-runner",
      purpose: "show Junto systemd user unit",
      command: SYSTEMCTL_PATH,
      args: [
        "--user",
        "--no-pager",
        "--no-ask-password",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=ControlGroup",
        "--property=InvocationID",
        "show",
        "vellum-command-remote.service",
      ],
      env: expect.objectContaining({
        LANG: "C",
        LC_ALL: "C",
        SYSTEMD_COLORS: "0",
        SYSTEMD_PAGER: "",
        SYSTEMD_LESS: "",
      }),
      shell: false,
    });

    const startHarness = makeLeaseHarness();
    vi.mocked(processPlane.spawnChild).mockReturnValueOnce(startHarness.lease);
    const starting = runner.startVellumUnit(systemdUserUnitTarget());
    startHarness.close();
    await expect(starting).resolves.toMatchObject({
      clean: true,
      ok: true,
      action: "start",
    });
    expect(processPlane.spawnChild).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: SYSTEMCTL_PATH,
      args: [
        "--user",
        "--no-pager",
        "--no-ask-password",
        "start",
        "vellum-command-remote.service",
      ],
      shell: false,
    }));
  });

  it("does not inherit systemd behavior overrides from ambient environment", async () => {
    const prior = process.env.SYSTEMD_UNIT_PATH;
    process.env.SYSTEMD_UNIT_PATH = "/tmp/attacker-units";
    try {
      const harness = makeLeaseHarness();
      const processPlane = makeProcessPlane(harness);
      const runner = createSystemctlRunner({ processPlane });

      const running = runner.showVellumUnit(systemdUserUnitTarget());
      harness.close();
      await running;

      const spec = vi.mocked(processPlane.spawnChild).mock.calls[0]?.[0];
      expect(spec?.env).not.toHaveProperty("SYSTEMD_UNIT_PATH");
      expect(spec?.env).not.toHaveProperty("PATH");
    } finally {
      if (prior === undefined) delete process.env.SYSTEMD_UNIT_PATH;
      else process.env.SYSTEMD_UNIT_PATH = prior;
    }
  });

  it("rejects forged unit targets before process admission", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createSystemctlRunner({ processPlane });

    const result = await runner.startVellumUnit(
      Object.freeze({}) as VellumSystemdUserUnitTarget,
    );

    expect(result).toMatchObject({
      clean: true,
      ok: false,
      unit: "<unadmitted>",
      failure: { kind: "invalid-target" },
    });
    expect(processPlane.spawnChild).not.toHaveBeenCalled();
  });
});

describe("systemctl runner bounded lifecycle", () => {
  it("bounds output and waits for the exact close witness", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createSystemctlRunner({
      processPlane,
      deadlineMs: 30,
      termGraceMs: 10,
      killGraceMs: 15,
      stdoutCapBytes: 8,
      stderrCapBytes: 6,
    });
    const running = runner.showVellumUnit(systemdUserUnitTarget());
    let settled = false;
    void running.then(() => {
      settled = true;
    });

    harness.stdout.write("123456789-more");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(processPlane.terminate).toHaveBeenCalledWith(
      harness.lease,
      "systemctl show bounded teardown",
    );

    harness.close({ code: null, signal: "SIGTERM" });
    await expect(running).resolves.toMatchObject({
      clean: true,
      ok: false,
      stdout: "12345678",
      failure: { kind: "stdout-overflow" },
    });
  });

  it("runs deadline, TERM, KILL, then reports an unconfirmed close", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createSystemctlRunner({ processPlane });
    const running = runner.showVellumUnit(systemdUserUnitTarget());

    await vi.advanceTimersByTimeAsync(SYSTEMCTL_DEADLINE_MS);
    expect(processPlane.terminate).toHaveBeenCalledWith(
      harness.lease,
      "systemctl show bounded teardown",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(processPlane.forceTerminate).toHaveBeenCalledWith(
      harness.lease,
      "systemctl show bounded teardown escalation",
    );
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(running).resolves.toMatchObject({
      clean: false,
      ok: false,
      failure: { kind: "close-timeout" },
    });
  });

  it("maps process errors and returns no process authority", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    const runner = createSystemctlRunner({ processPlane });
    const running = runner.startVellumUnit(systemdUserUnitTarget());

    harness.error(Object.assign(new Error("permission denied"), {
      code: "EACCES",
    }));
    harness.close({ code: null, signal: "SIGTERM" });
    const result = await running;

    expect(result).toMatchObject({
      clean: true,
      ok: false,
      failure: {
        kind: "process-error",
        diagnostic: "Error (EACCES): permission denied",
      },
    });
    expect(result).not.toHaveProperty("pid");
    expect(result).not.toHaveProperty("child");
    expect(result).not.toHaveProperty("lease");
    expect(result).not.toHaveProperty("process");
  });

  it("fails closed when process admission is quiescing", async () => {
    const harness = makeLeaseHarness();
    const processPlane = makeProcessPlane(harness);
    vi.mocked(processPlane.isQuiescing).mockReturnValue(true);
    const runner = createSystemctlRunner({ processPlane });

    await expect(
      runner.showVellumUnit(systemdUserUnitTarget()),
    ).resolves.toMatchObject({
      clean: true,
      ok: false,
      failure: { kind: "admission-refused" },
    });
    expect(processPlane.spawnChild).not.toHaveBeenCalled();
  });
});
