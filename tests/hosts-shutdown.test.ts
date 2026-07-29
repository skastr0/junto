import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { registerHostsIpc } from "../src/main/vellum/hosts/ipc";
import {
  HOST_OPERATION_ADMISSIONS,
  HostOperationShutdownRefused,
  createHostOperationGate,
} from "../src/main/vellum/hosts/shutdown";

type InvokeHandler = (event: unknown, ...args: ReadonlyArray<unknown>) => unknown;

const runtime = vi.hoisted(() => ({
  runPromise: vi.fn(),
}));

vi.mock("../src/main/runtime", () => ({ AppRuntime: runtime }));

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("host operation shutdown gate", () => {
  it("closes admission synchronously and never invokes a late operation factory", async () => {
    const gate = createHostOperationGate();
    const first = gate.beginShutdown();
    const second = gate.beginShutdown();
    let invoked = false;

    const refused = gate.run(HOST_OPERATION_ADMISSIONS.deployRemote, async () => {
      invoked = true;
      return "deployed";
    });

    await expect(refused).rejects.toBeInstanceOf(HostOperationShutdownRefused);
    await expect(refused).rejects.toMatchObject({
      code: "shutdown",
      operation: HOST_OPERATION_ADMISSIONS.deployRemote,
    });
    expect(invoked).toBe(false);
    expect(second.closedAt).toBe(first.closedAt);
    await expect(gate.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      retained: 0,
    });
  });

  it("returns and strongly retains the exact operation promise across a bounded timeout", async () => {
    const gate = createHostOperationGate({ shutdownDeadlineMs: 15 });
    const pending = deferred<string>();

    const admitted = gate.run(
      HOST_OPERATION_ADMISSIONS.deployRemote,
      () => pending.promise,
    );
    expect(admitted).toBe(pending.promise);

    await expect(gate.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      settled: 0,
      retained: 1,
      retainedLabels: ["hosts.deploy-remote"],
    });
    expect(gate.snapshot()).toEqual({
      phase: "closed",
      activeLabels: ["hosts.deploy-remote"],
    });

    pending.resolve("deployed");
    await expect(admitted).resolves.toBe("deployed");
    await expect(gate.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      settled: 1,
      fulfilled: 1,
      retained: 0,
    });
  });

  it("uses allSettled and preserves rejected runtime evidence across retries", async () => {
    const gate = createHostOperationGate();
    const failure = new Error("remote probe failed");
    const rejected = Promise.reject(failure);
    const admitted = gate.run(HOST_OPERATION_ADMISSIONS.test, () => rejected);

    const receipt = await gate.drainOnQuit();

    await expect(admitted).rejects.toBe(failure);
    expect(receipt).toMatchObject({
      clean: false,
      timedOut: false,
      rounds: 1,
      settled: 1,
      fulfilled: 0,
      rejected: 1,
      retained: 0,
      causes: [{ label: "hosts.test", message: "remote probe failed" }],
    });
    await expect(gate.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: false,
      retained: 0,
      causes: [{ label: "hosts.test", message: "remote probe failed" }],
    });
  });

  it("publishes lifetimes before caller reentrancy and drains the fixed point", async () => {
    const gate = createHostOperationGate();
    const nested = deferred<string>();
    let nestedOperation!: Promise<string>;

    const outerOperation = gate.run(HOST_OPERATION_ADMISSIONS.upsert, () => {
      nestedOperation = gate.run(
        HOST_OPERATION_ADMISSIONS.test,
        () => nested.promise,
      );
      const precommit = gate.beginShutdown();
      expect(precommit.activeLabels).toEqual(["hosts.upsert", "hosts.test"]);
      return Promise.resolve("saved");
    });

    const drain = gate.drainOnQuit();
    nested.resolve("reachable");

    await expect(outerOperation).resolves.toBe("saved");
    await expect(nestedOperation).resolves.toBe("reachable");
    await expect(drain).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      settled: 2,
      fulfilled: 2,
      rejected: 0,
      retained: 0,
    });
  });

  it("coalesces a reentrant and concurrent drain without losing its prepublished operation", async () => {
    const gate = createHostOperationGate();
    let reentrantDrain!: ReturnType<typeof gate.drainOnQuit>;

    const operation = gate.run(HOST_OPERATION_ADMISSIONS.remove, () => {
      reentrantDrain = gate.drainOnQuit();
      return Promise.resolve("removed");
    });
    const concurrentDrain = gate.drainOnQuit();

    expect(concurrentDrain).toBe(reentrantDrain);
    await expect(operation).resolves.toBe("removed");
    await expect(reentrantDrain).resolves.toMatchObject({
      clean: true,
      settled: 1,
      retained: 0,
    });
  });

  it("breaks causal drain reentrancy at the deadline and converges on retry", async () => {
    const gate = createHostOperationGate({ shutdownDeadlineMs: 15 });

    const operation = gate.run(
      HOST_OPERATION_ADMISSIONS.configureRemote,
      () => gate.drainOnQuit(),
    );
    const firstDrain = gate.drainOnQuit();

    expect(firstDrain).toBe(operation);
    await expect(firstDrain).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      retainedLabels: ["hosts.configure-remote"],
    });
    // The bounded receipt releases the causal operation, but the exact promise
    // remains journaled until a later drain observes that real settlement.
    await Promise.resolve();
    await expect(gate.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      timedOut: false,
      settled: 1,
      retained: 0,
    });
  });
});

describe("host IPC shutdown admission", () => {
  const handlers = new Map<string, InvokeHandler>();

  beforeEach(() => {
    handlers.clear();
    runtime.runPromise.mockReset();
  });

  const register = (shutdownDeadlineMs = 100) => {
    const gate = createHostOperationGate({ shutdownDeadlineMs });
    const ipcMain = {
      handle: vi.fn((channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerHostsIpc(ipcMain, gate);
    return gate;
  };

  const invoke = (channel: string, ...args: ReadonlyArray<unknown>): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} handler not registered`);
    return handler({}, ...args);
  };

  it("routes every host IPC handler through the synchronous shutdown cut", async () => {
    const gate = register();
    gate.beginShutdown();

    const calls = [
      [IPC_CHANNELS.hostsList],
      [IPC_CHANNELS.hostsUpsert, { id: "studio" }],
      [IPC_CHANNELS.hostsRemove, "studio"],
      [IPC_CHANNELS.hostsTest, "studio"],
      [IPC_CHANNELS.hostsConfigureRemote, "studio"],
      [IPC_CHANNELS.hostsDeployRemote, { id: "studio" }],
    ] as const;

    for (const [channel, ...args] of calls) {
      await expect(invoke(channel, ...args)).resolves.toMatchObject({
        ok: false,
        code: "shutdown",
        message: expect.stringContaining("shutdown is active"),
      });
    }
    expect(runtime.runPromise).not.toHaveBeenCalled();
  });

  it("rejects invalid deploy IPC shape without entering the app runtime", async () => {
    register();
    // Managed deploy is release-enabled; invalid payloads still fail closed
    // before AppRuntime (decode gate), and never retain a flight.
    const inputs: ReadonlyArray<unknown> = [
      "studio",
      { id: "studio", extra: true },
      { authorization: { password: "secret" } },
    ];

    for (const input of inputs) {
      await expect(
        invoke(IPC_CHANNELS.hostsDeployRemote, input),
      ).resolves.toMatchObject({
        ok: false,
        code: "validation",
        detail: expect.stringMatching(/invalid/i),
      });
    }
    expect(runtime.runPromise).not.toHaveBeenCalled();
  });
});
