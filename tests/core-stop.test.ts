import { describe, expect, it } from "vitest";
import { closeCoreProcess, drainCoreProcessPlane, stopCoreOnSignal } from "../src/main/core-process/core-stop";
import type { AppProcessDrainResult, AppProcessStraggler } from "../src/main/junto/app-process-plane";

const harness = () => {
  const exits: number[] = [];
  const logged: Array<{ message: string; error: unknown }> = [];
  const run = (close: () => Promise<void>): void =>
    stopCoreOnSignal(
      close,
      (code) => exits.push(code),
      (message, error) => logged.push({ message, error }),
    );
  return { exits, logged, run };
};

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("the core's stop signal", () => {
  it("a clean drain leaves with 0", async () => {
    const { exits, logged, run } = harness();
    run(async () => undefined);
    await settled();
    expect(exits).toEqual([0]);
    expect(logged).toEqual([]);
  });

  it("a drain that throws is reported and leaves nonzero, never as a clean stop", async () => {
    const { exits, logged, run } = harness();
    const failure = new Error("Core writes did not drain; core state retained");
    run(async () => {
      throw failure;
    });
    await settled();
    // The error is named with the one log line main and a boot harness read.
    expect(logged).toEqual([{ message: "[core] stop failed:", error: failure }]);
    // Never 0: a failed drain must not read as a clean stop.
    expect(exits).toEqual([1]);
  });

  it("a rejected close is reported the same way as a throw", async () => {
    const { exits, logged, run } = harness();
    const failure = new Error("service children did not drain");
    run(() => Promise.reject(failure));
    await settled();
    expect(logged).toEqual([{ message: "[core] stop failed:", error: failure }]);
    expect(exits).toEqual([1]);
  });
});

const straggler = (source: string, state: AppProcessStraggler["state"]): AppProcessStraggler => ({
  generation: 1,
  source,
  purpose: "test",
  mode: "group",
  state,
  pid: 4242,
});

const plane = (result: AppProcessDrainResult) => {
  let drained = 0;
  return {
    drained: () => drained,
    drainOnQuit: async () => {
      drained += 1;
      return result;
    },
  };
};

describe("the core process's own plane at stop", () => {
  it("a clean plane drains quietly", async () => {
    const clean = plane({ clean: true, stragglers: [] });
    await expect(drainCoreProcessPlane(clean)).resolves.toBeUndefined();
    expect(clean.drained()).toBe(1);
  });

  it("an unverifiable read-only adapter CLI is logged, never a failed stop", async () => {
    const leftover = plane({ clean: false, stragglers: [straggler("adapter.cli", "ownership-unverified")] });
    await expect(drainCoreProcessPlane(leftover)).resolves.toBeUndefined();
  });

  it("a child that could hold work fails the stop, named", async () => {
    const leftover = plane({ clean: false, stragglers: [straggler("region-env.tool", "running")] });
    await expect(drainCoreProcessPlane(leftover)).rejects.toThrow(/retained 1 child generation\(s\): region-env\.tool:test@1 pid=4242/u);
  });

  it("the plane drains even when the core's close failed, and the close's failure is the one reported", async () => {
    const failure = new Error("Core writes did not drain; core state retained");
    const clean = plane({ clean: true, stragglers: [] });
    await expect(closeCoreProcess(async () => {
      throw failure;
    }, clean)).rejects.toBe(failure);
    expect(clean.drained()).toBe(1);
  });
});
