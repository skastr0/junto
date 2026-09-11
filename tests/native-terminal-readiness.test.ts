import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppTerminalExit,
  AppTerminalLease,
  AppTerminalSpawnSpec,
} from "../src/main/vellum-command/app-process-plane";
import {
  assessNativeTerminalDoctor,
  probeNativeTerminalReadiness,
  type NativeTerminalProbeAuthority,
} from "../src/main/vellum-command/term/native-readiness";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const successfulAuthority = (): {
  readonly authority: NativeTerminalProbeAuthority;
  readonly specs: AppTerminalSpawnSpec[];
} => {
  const specs: AppTerminalSpawnSpec[] = [];
  const authority: NativeTerminalProbeAuthority = {
    spawnTerminal: (spec) => {
      specs.push(spec);
      // Real node-pty uses signal=0 for an ordinary exit.
      const exit: AppTerminalExit = { code: 0, signal: 0 };
      return {
        generation: 1,
        source: spec.source,
        purpose: spec.purpose,
        backend: "pty",
        io: {
          pidForDiagnostics: 98_765,
          exited: Promise.resolve(exit),
          write: () => undefined,
          resize: () => undefined,
          onData: () => () => undefined,
          onExit: () => () => undefined,
          onError: () => () => undefined,
        },
      } as unknown as AppTerminalLease;
    },
    terminate: vi.fn(),
    forceTerminate: vi.fn(),
  };
  return { authority, specs };
};

describe("native terminal readiness", () => {
  it("proves a native PTY spawn without returning PID or signal authority", async () => {
    const fake = successfulAuthority();

    const result = await probeNativeTerminalReadiness(fake.authority);

    expect(result).toEqual({ ready: true, backend: "pty", exitCode: 0 });
    expect("pid" in result).toBe(false);
    expect("lease" in result).toBe(false);
    expect(fake.specs).toEqual([
      expect.objectContaining({
        source: "doctor:native-terminal",
        purpose: "prove native PTY load and spawn",
        command: "/bin/sh",
        args: ["-c", "exit 0"],
        cols: 80,
        rows: 24,
      }),
    ]);
  });

  it("reports native load/spawn failure instead of accepting socket presence", async () => {
    const authority: NativeTerminalProbeAuthority = {
      spawnTerminal: () => {
        throw new Error("node-pty binary missing");
      },
      terminate: vi.fn(),
      forceTerminate: vi.fn(),
    };

    const probe = await probeNativeTerminalReadiness(authority);
    const doctor = assessNativeTerminalDoctor({
      probe,
      controlReady: true,
      running: 0,
    });

    expect(probe).toMatchObject({ ready: false, code: "native_spawn_failed" });
    expect(doctor).toMatchObject({ id: "terminal", status: "error" });
    expect(doctor.detail).toContain("node-pty binary missing");
  });

  it("boundedly cleans up a probe that does not exit", async () => {
    vi.useFakeTimers();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      exitOnSignal: "SIGTERM",
    }));

    const probePromise = probeNativeTerminalReadiness(fake.authority, {
      timeoutMs: 5,
      cleanupGraceMs: 5,
    });
    await vi.advanceTimersByTimeAsync(5);

    await expect(probePromise).resolves.toMatchObject({
      ready: false,
      code: "native_probe_timeout",
    });
    expect(fake.controllers[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("distinguishes a proven backend from optional control-socket readiness", () => {
    const probe = { ready: true, backend: "pty", exitCode: 0 } as const;

    expect(assessNativeTerminalDoctor({ probe, controlReady: false, running: 2 }))
      .toMatchObject({ status: "warning" });
    expect(assessNativeTerminalDoctor({ probe, controlReady: true, running: 2 }))
      .toMatchObject({ status: "ok" });
  });
});
