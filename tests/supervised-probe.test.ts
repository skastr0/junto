import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnChild: vi.fn(),
  terminate: vi.fn(),
  forceTerminate: vi.fn(),
}));

vi.mock("../src/main/vellum/app-process-plane", () => ({
  APP_PROCESS_TERM_GRACE_MS: 1_000,
  APP_PROCESS_KILL_GRACE_MS: 1_500,
  appProcessPlane: {
    spawnChild: mocks.spawnChild,
    terminate: mocks.terminate,
    forceTerminate: mocks.forceTerminate,
  },
}));

import {
  probeLaunchAgentLoaded,
  VELLUM_LAUNCHD_LABEL,
} from "../src/main/vellum/settings/supervised-probe";

interface ProbeHarness {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly close: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly error: (error: Error) => void;
  readonly hasCloseListener: () => boolean;
  readonly hasErrorListener: () => boolean;
  readonly lease: object;
}

const makeHarness = (): ProbeHarness => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closeListener:
    | ((event: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const lease = {
    io: {
      stdout,
      stderr,
      onClose: vi.fn((listener) => {
        closeListener = listener;
        return () => {
          if (closeListener === listener) closeListener = undefined;
        };
      }),
      onError: vi.fn((listener) => {
        errorListener = listener;
        return () => {
          if (errorListener === listener) errorListener = undefined;
        };
      }),
    },
  };
  return {
    stdout,
    stderr,
    lease,
    close: (code, signal) => closeListener?.({ code, signal }),
    error: (error) => errorListener?.(error),
    hasCloseListener: () => closeListener !== undefined,
    hasErrorListener: () => errorListener !== undefined,
  };
};

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "getuid").mockReturnValue(501);
  mocks.spawnChild.mockReset();
  mocks.terminate.mockReset();
  mocks.forceTerminate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("supervised launch-agent probe", () => {
  it("reports absent without spawning outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await expect(probeLaunchAgentLoaded()).resolves.toBe("absent");
    expect(mocks.spawnChild).not.toHaveBeenCalled();
  });

  it("reports unknown without spawning when the user id is unavailable", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(undefined as never);

    await expect(probeLaunchAgentLoaded()).resolves.toBe("unknown");
    expect(mocks.spawnChild).not.toHaveBeenCalled();
  });

  it("spawns launchctl through the central plane and reports a loaded job", async () => {
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);

    const result = probeLaunchAgentLoaded();
    expect(mocks.spawnChild).toHaveBeenCalledWith({
      source: "settings.supervised-probe",
      purpose: "probe supervised launch agent",
      command: "/bin/launchctl",
      args: ["print", `gui/501/${VELLUM_LAUNCHD_LABEL}`],
    });
    expect(harness.stdout.readableFlowing).toBe(true);
    expect(harness.stderr.readableFlowing).toBe(true);

    harness.close(0, null);
    await expect(result).resolves.toBe("installed");
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(mocks.forceTerminate).not.toHaveBeenCalled();
    expect(harness.hasCloseListener()).toBe(false);
    expect(harness.hasErrorListener()).toBe(false);
  });

  it("preserves absent and signaled close classifications", async () => {
    const absentHarness = makeHarness();
    mocks.spawnChild.mockReturnValueOnce(absentHarness.lease);
    const absent = probeLaunchAgentLoaded();
    absentHarness.close(113, null);
    await expect(absent).resolves.toBe("absent");

    const signaledHarness = makeHarness();
    mocks.spawnChild.mockReturnValueOnce(signaledHarness.lease);
    const signaled = probeLaunchAgentLoaded();
    signaledHarness.close(null, "SIGTERM");
    await expect(signaled).resolves.toBe("unknown");
  });

  it("preserves execFile spawn-error classifications", async () => {
    const missingHarness = makeHarness();
    mocks.spawnChild.mockReturnValueOnce(missingHarness.lease);
    const missing = probeLaunchAgentLoaded();
    missingHarness.error(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(missing).resolves.toBe("unknown");
    expect(mocks.terminate).toHaveBeenCalledWith(
      missingHarness.lease,
      "supervised probe process error",
    );
    expect(missingHarness.stdout.destroyed).toBe(true);
    expect(missingHarness.stderr.destroyed).toBe(true);

    const deniedHarness = makeHarness();
    mocks.spawnChild.mockReturnValueOnce(deniedHarness.lease);
    const denied = probeLaunchAgentLoaded();
    deniedHarness.error(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(denied).resolves.toBe("absent");
  });

  it("terminates a live child after a generic post-spawn error", async () => {
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);

    const result = probeLaunchAgentLoaded();
    harness.error(Object.assign(new Error("late I/O fault"), { code: "EIO" }));

    await expect(result).resolves.toBe("absent");
    expect(mocks.terminate).toHaveBeenCalledWith(
      harness.lease,
      "supervised probe process error",
    );
    expect(mocks.forceTerminate).not.toHaveBeenCalled();
    expect(harness.hasCloseListener()).toBe(false);
    expect(harness.hasErrorListener()).toBe(false);
    expect(() => harness.close(null, "SIGTERM")).not.toThrow();
  });

  it("requests central termination on timeout and waits for close", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);
    mocks.terminate.mockImplementation(() => {
      harness.close(null, "SIGTERM");
    });

    const result = probeLaunchAgentLoaded();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.terminate).toHaveBeenCalledWith(
      harness.lease,
      "supervised probe timeout",
    );

    await expect(result).resolves.toBe("unknown");
    expect(mocks.forceTerminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds timeout through TERM, KILL, and a late-close window", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);

    const result = probeLaunchAgentLoaded();
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.terminate).toHaveBeenCalledWith(
      harness.lease,
      "supervised probe timeout",
    );
    expect(mocks.forceTerminate).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.forceTerminate).toHaveBeenCalledWith(
      harness.lease,
      "supervised probe timeout escalation",
    );
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toBe("unknown");
    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.hasCloseListener()).toBe(false);
    expect(harness.hasErrorListener()).toBe(false);
    expect(() => harness.close(null, "SIGKILL")).not.toThrow();
  });

  it("does not arm a late-close timer when KILL closes synchronously", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);
    mocks.forceTerminate.mockImplementation(() => {
      harness.close(null, "SIGKILL");
    });

    const result = probeLaunchAgentLoaded();
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(result).resolves.toBe("unknown");
    expect(mocks.forceTerminate).toHaveBeenCalledWith(
      harness.lease,
      "supervised probe timeout escalation",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains execFile's success result when a timeout races a zero exit", async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    mocks.spawnChild.mockReturnValue(harness.lease);

    const result = probeLaunchAgentLoaded();
    await vi.advanceTimersByTimeAsync(3_000);
    harness.close(0, null);

    await expect(result).resolves.toBe("installed");
  });

  it("fails closed when central admission is already quiescing", async () => {
    mocks.spawnChild.mockImplementation(() => {
      throw new Error("app process plane is shutting down");
    });

    await expect(probeLaunchAgentLoaded()).resolves.toBe("unknown");
  });
});
