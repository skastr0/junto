import { describe, expect, it, vi } from "vitest";
import {
  installProbeSignalDrain,
  type ProbeShutdownSignal,
  type ProbeSignalSource,
} from "../scripts/probe-signal-drain";

const makeSignalSource = () => {
  const listeners = new Map<ProbeShutdownSignal, Set<() => void>>();
  const source: ProbeSignalSource = {
    on: (signal, listener) => {
      const registered = listeners.get(signal) ?? new Set<() => void>();
      registered.add(listener);
      listeners.set(signal, registered);
    },
    off: (signal, listener) => {
      listeners.get(signal)?.delete(listener);
    },
  };
  return {
    source,
    emit: (signal: ProbeShutdownSignal): void => {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
    count: (): number =>
      [...listeners.values()].reduce((total, group) => total + group.size, 0),
  };
};

describe("probe signal drain", () => {
  it("joins repeated runner signals onto one capability-owned finalizer", async () => {
    const signals = makeSignalSource();
    let finish!: (clean: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const finalize = vi.fn(() => pending);
    const beforeDrain = vi.fn();
    const drain = installProbeSignalDrain({
      source: signals.source,
      finalize,
      beforeDrain,
    });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    expect(finalize).toHaveBeenCalledExactlyOnceWith("probe-runner-sigterm");
    expect(beforeDrain).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(drain.active()).toBeDefined();
    finish(true);
    await expect(drain.active()).resolves.toBe(true);
    drain.uninstall();
    drain.uninstall();
    expect(signals.count()).toBe(0);
  });

  it("contains finalizer rejection and reports an unclean drain", async () => {
    const signals = makeSignalSource();
    const failure = new Error("fixture drain failed");
    const onFailure = vi.fn();
    const drain = installProbeSignalDrain({
      source: signals.source,
      finalize: async () => {
        throw failure;
      },
      onFailure,
    });

    await expect(drain.request("SIGHUP")).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("SIGHUP", failure);
    drain.uninstall();
  });
});
