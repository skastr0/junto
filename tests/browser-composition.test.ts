import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  BrowserCompositionStartupError,
  makeBrowserShutdownCoordinator,
} from "../src/main/vellum/browser/composition";
import { makeBrowserCapabilityRegistry } from "../src/main/vellum/browser/capabilities";
import { makeBrowserProfileGate } from "../src/main/vellum/browser/profile-gate";
import type { BrowserSessionService } from "../src/main/vellum/browser/sessions";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const controlShutdownReceipt = (clean = true) => Object.freeze({
  clean,
  rounds: 0,
  settled: 0,
  fulfilled: 0,
  rejected: 0,
  retainedCounts: Object.freeze({
    requests: 0,
    edgeAdmissions: 0,
    dispatches: 0,
    routeOperations: 0,
    listenerClosures: 0,
    sockets: 0,
    requestControllers: 0,
    socketPaths: 0,
  }),
  retainedLabels: Object.freeze([] as string[]),
});

const storageShutdownReceipt = (clean = true) => Object.freeze({
  epoch: 1,
  clean,
  operations: Object.freeze([]),
  settled: 0,
  fulfilled: 0,
  rejected: 0,
  rounds: 0,
  timedOut: false,
  activeOperations: Object.freeze([]),
  activeRawClearOperations: Object.freeze([]),
});

const storageShutdownPort = () => ({
  beginShutdown: () => ({
    epoch: 1,
    activeOperations: Object.freeze([]),
    activeRawClearOperations: Object.freeze([]),
  }),
  drainOnQuit: async () => storageShutdownReceipt(),
});

describe("browser composition (no ceremony)", () => {
  it("source no longer wires grant delivery / agent product", () => {
    const root = join(import.meta.dirname, "..");
    const composition = readFileSync(
      join(root, "src/main/vellum/browser/composition.ts"),
      "utf8",
    );
    const index = readFileSync(join(root, "src/main/index.ts"), "utf8");
    expect(composition).not.toContain("agent-product");
    expect(composition).not.toContain("makeBrowserAutomationProduct");
    expect(composition).not.toContain("agent-runtime");
    expect(composition).not.toContain("agent-authority");
    expect(index).not.toContain("registerBrowserAgentIpc");
    expect(index).not.toContain("confirmBrowserAutomation");
    expect(index).not.toContain("agent-confirmation");
    expect(index).toContain("composition.registry");
    expect(index).not.toContain("composition.automation");
  });

  it("ceremony modules are gone from the tree", () => {
    const root = join(import.meta.dirname, "..");
    for (const rel of [
      "src/main/vellum/browser/agent-product.ts",
      "src/main/vellum/browser/agent-runtime.ts",
      "src/main/vellum/browser/agent-authority.ts",
      "src/main/vellum/browser/agent-confirmation.ts",
      "src/main/vellum/browser/agent-ipc.ts",
      "src/main/vellum/browser/herdr-agent-delivery.ts",
    ]) {
      expect(() => readFileSync(join(root, rel))).toThrow();
    }
  });

  it("internal registry still supports edge-grant leases", () => {
    const gate = makeBrowserProfileGate();
    const registry = makeBrowserCapabilityRegistry({ profileGate: gate });
    try {
      const principal = registry.createPrincipal();
      expect(principal.ownerId.length).toBeGreaterThan(0);
      registry.reapAfterResume();
    } finally {
      registry.close();
    }
  });

  it("startup failure type stays fixed-message", () => {
    const err = new BrowserCompositionStartupError();
    expect(err.message).toBe(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
    expect(err.name).toBe("BrowserCompositionStartupError");
  });

  it("closes every browser ingress synchronously and coalesces one aggregate drain", async () => {
    const ui = deferred<{
      readonly epoch: number;
      readonly clean: true;
      readonly operations: readonly [];
      readonly settled: number;
      readonly fulfilled: number;
      readonly rejected: number;
      readonly rounds: number;
      readonly timedOut: false;
      readonly activeOperations: readonly [];
      readonly sessionsDestroyed: number;
      readonly teardownWitnessFailures: number;
    }>();
    const control = deferred<ReturnType<typeof controlShutdownReceipt>>();
    const storage = deferred<ReturnType<typeof storageShutdownReceipt>>();
    const beginUiShutdown = vi.fn(() => ({
      epoch: 1,
      closedAt: 1,
      activeOperations: [] as const,
    }));
    const drainUiOnQuit = vi.fn(() => ui.promise);
    const beginStorageShutdown = vi.fn(() => ({
      epoch: 1,
      activeOperations: [] as const,
      activeRawClearOperations: [] as const,
    }));
    const drainStorageOnQuit = vi.fn(() => storage.promise);
    const sessions = {
      beginUiShutdown,
      drainUiOnQuit,
    } as unknown as BrowserSessionService;
    const closeRegistry = vi.fn(() => 3);
    const drainControl = vi.fn(() => control.promise);
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: {
        beginShutdown: beginStorageShutdown,
        drainOnQuit: drainStorageOnQuit,
      },
      registry: { close: closeRegistry },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({ drainOnQuit: drainControl });

    const first = coordinator.drainOnQuit("test shutdown");
    const concurrent = coordinator.drainOnQuit("test shutdown");

    expect(concurrent).toBe(first);
    expect(beginUiShutdown).toHaveBeenCalledOnce();
    expect(beginStorageShutdown).toHaveBeenCalledOnce();
    expect(drainStorageOnQuit).toHaveBeenCalledOnce();
    expect(drainControl).toHaveBeenCalledOnce();
    expect(closeRegistry).toHaveBeenCalledOnce();
    expect(drainUiOnQuit).toHaveBeenCalledOnce();

    ui.resolve({
      epoch: 1,
      clean: true,
      operations: [],
      settled: 0,
      fulfilled: 0,
      rejected: 0,
      rounds: 0,
      timedOut: false,
      activeOperations: [],
      sessionsDestroyed: 2,
      teardownWitnessFailures: 0,
    });
    control.resolve(controlShutdownReceipt());
    storage.resolve(storageShutdownReceipt());

    await expect(first).resolves.toEqual({
      clean: true,
      timedOut: false,
      registry: { clean: true, capabilitiesRevoked: 3, terminationFailures: 0 },
      storage: storageShutdownReceipt(),
      ui: {
        epoch: 1,
        clean: true,
        operations: [],
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false,
        activeOperations: [],
        sessionsDestroyed: 2,
        teardownWitnessFailures: 0,
      },
      control: {
        available: true,
        clean: true,
        receipt: controlShutdownReceipt(),
      },
    });
  });

  it("returns an unclean aggregate when a bound control drain rejects", async () => {
    const sessions = {
      beginUiShutdown: vi.fn(() => ({
        epoch: 4,
        closedAt: 1,
        activeOperations: [] as const,
      })),
      drainUiOnQuit: vi.fn(async () => ({
        epoch: 4,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      })),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: () => Promise.reject(new Error("control drain failed")),
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      registry: { clean: true },
      ui: { clean: true },
      control: { available: true, clean: false },
    });
  });

  it("reports a rejected UI drain with internally consistent counters", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 3, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: () => Promise.reject(new Error("UI drain failed")),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => controlShutdownReceipt(),
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: false,
      ui: {
        clean: false,
        settled: 1,
        fulfilled: 0,
        rejected: 1,
        timedOut: false,
      },
      control: { clean: true },
    });
  });

  it("reports a pending UI drain as timed out without inventing a rejection", async () => {
    const sessions = {
      beginUiShutdown: () => ({
        epoch: 5,
        closedAt: 1,
        activeOperations: ["profile-wipe"] as const,
      }),
      drainUiOnQuit: () => new Promise<never>(() => {}),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
      drainTimeoutMs: 5,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => controlShutdownReceipt(),
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      ui: {
        clean: false,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        timedOut: true,
        activeOperations: ["profile-wipe"],
      },
      control: { clean: true },
    });
  });

  it("keeps a retained raw profile clear authoritative in the aggregate", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      }),
    } as unknown as BrowserSessionService;
    const retainedClear = Object.freeze({
      ...storageShutdownReceipt(false),
      operations: Object.freeze(["execute_live", "clear:http_cache"] as const),
      timedOut: true,
      activeOperations: Object.freeze(["execute_live"] as const),
      activeRawClearOperations: Object.freeze(["http_cache"] as const),
    });
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: {
        beginShutdown: () => ({
          epoch: 1,
          activeOperations: ["execute_live"] as const,
          activeRawClearOperations: ["http_cache"] as const,
        }),
        drainOnQuit: async () => retainedClear,
      },
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => controlShutdownReceipt(),
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: false,
      storage: {
        clean: false,
        timedOut: true,
        activeRawClearOperations: ["http_cache"],
      },
      ui: { clean: true },
      control: { clean: true },
    });
  });

  it("fails closed instead of awaiting itself when a control drain re-enters", async () => {
    const sessions = {
      beginUiShutdown: vi.fn(() => ({
        epoch: 7,
        closedAt: 1,
        activeOperations: [] as const,
      })),
      drainUiOnQuit: vi.fn(async () => ({
        epoch: 7,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      })),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: () => coordinator.drainOnQuit("reentrant control") as never,
    });

    await expect(coordinator.drainOnQuit("outer shutdown")).resolves.toMatchObject({
      clean: false,
      registry: { clean: true },
      ui: { clean: true },
      control: { available: true, clean: false },
    });
  });

  it("bounds an indirect reentrant control promise that adopts the aggregate", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      }),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
      drainTimeoutMs: 5,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => coordinator.drainOnQuit("indirect reentry") as never,
    });

    await expect(coordinator.drainOnQuit("outer shutdown")).resolves.toMatchObject({
      clean: false,
      timedOut: true,
      ui: { clean: true },
      control: { available: true, clean: false },
    });
  });

  it.each([
    ["undefined", undefined],
    ["non-boolean", { clean: "yes" }],
    [
      "contradictory accounting",
      { ...controlShutdownReceipt(), settled: 1, fulfilled: 0, rejected: 0 },
    ],
    ["throwing getter", Object.defineProperty({}, "clean", {
      get: () => {
        throw new Error("malformed control receipt");
      },
    })],
    ["changing getter", (() => {
      let reads = 0;
      return Object.defineProperty({}, "clean", {
        get: () => {
          reads += 1;
          return reads === 1 ? true : "yes";
        },
      });
    })()],
  ])("normalizes a malformed %s control receipt to unclean", async (_label, malformed) => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      }),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => malformed as never,
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      timedOut: false,
      control: { available: true, clean: false },
    });
  });

  it("cannot normalize retained control resources into a clean aggregate", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      }),
    } as unknown as BrowserSessionService;
    const retainedControl = {
      ...controlShutdownReceipt(),
      retainedCounts: {
        ...controlShutdownReceipt().retainedCounts,
        requests: 1,
      },
      retainedLabels: ["request"],
    };
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => retainedControl,
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      control: {
        available: true,
        clean: false,
        receipt: {
          clean: false,
          retainedCounts: { requests: 1 },
          retainedLabels: ["request"],
        },
      },
    });
  });

  it("fails closed when capability teardown records a permanent failure", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: false as const,
        operations: ["view-destroy"] as const,
        settled: 1,
        fulfilled: 0,
        rejected: 1,
        rounds: 1,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 1,
      }),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 2 },
      registryTerminationFailures: () => 1,
    });
    coordinator.bindControlShutdown({
      drainOnQuit: async () => controlShutdownReceipt(),
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      registry: { clean: false, capabilitiesRevoked: 2, terminationFailures: 1 },
      ui: { clean: false, teardownWitnessFailures: 1 },
      control: { clean: true },
    });
  });

  it("fails closed when no control-plane drain was bound", async () => {
    const sessions = {
      beginUiShutdown: () => ({ epoch: 1, closedAt: 1, activeOperations: [] }),
      drainUiOnQuit: async () => ({
        epoch: 1,
        clean: true as const,
        operations: [] as const,
        settled: 0,
        fulfilled: 0,
        rejected: 0,
        rounds: 0,
        timedOut: false as const,
        activeOperations: [] as const,
        sessionsDestroyed: 0,
        teardownWitnessFailures: 0,
      }),
    } as unknown as BrowserSessionService;
    const coordinator = makeBrowserShutdownCoordinator({
      sessions,
      storage: storageShutdownPort(),
      registry: { close: () => 0 },
      registryTerminationFailures: () => 0,
    });

    await expect(coordinator.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      control: { available: false, clean: false },
    });
  });
});
