import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { isAllowedBrowserUrl } from "@shared/browser";
import {
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "./capabilities";
import { makeBrowserProfileGate, type BrowserProfileGate } from "./profile-gate";
import {
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStorageCapabilityControl,
  type BrowserProfileStorageDependencies,
  type BrowserProfileStoragePlatform,
  type BrowserProfileStorageSessionControl,
} from "./profile-storage";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
  type BrowserProfileWipeLifecycle,
} from "./profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserUiShutdownDrainReceipt,
} from "./sessions";

// Browser composition without ceremony: sessions + profiles + internal
// capability registry (edge-grant leases only). Product access is
// process-bind + canvas edges — no enable/restart grant delivery.

export const BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE =
  "browser security initialization failed; browser startup blocked";
export const BROWSER_COMPOSITION_SHUTDOWN_DRAIN_TIMEOUT_MS = 55_000;

export class BrowserCompositionStartupError extends Error {
  override readonly name = "BrowserCompositionStartupError";

  constructor() {
    super(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
  }
}

export interface BrowserComposition {
  readonly profileGate: BrowserProfileGate;
  readonly profiles: BrowserProfileServiceApi;
  readonly sessions: BrowserSessionService;
  readonly storage: BrowserProfileWipeLifecycle;
  /** Internal edge-grant lease registry — not a product grant surface. */
  readonly registry: BrowserCapabilityRegistry;
  /** Bind the local control socket's future monotonic drain before shutdown. */
  readonly bindControlShutdown: (control: BrowserControlShutdownPort) => void;
  /** Close all browser-domain admission and return one aggregate receipt. */
  readonly drainOnQuit: (reason?: string) => Promise<BrowserCompositionShutdownReceipt>;
  /** Compatibility alias; callers must await the authoritative receipt. */
  readonly close: (reason?: string) => Promise<BrowserCompositionShutdownReceipt>;
}

export interface BrowserControlShutdownReceipt {
  readonly clean: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retainedCounts: Readonly<{
    requests: number;
    edgeAdmissions: number;
    dispatches: number;
    routeOperations: number;
    listenerClosures: number;
    sockets: number;
    requestControllers: number;
    socketPaths: number;
  }>;
  readonly retainedLabels: ReadonlyArray<string>;
}

/** Structural port so browser/control.ts can add a drain without a cycle. */
export interface BrowserControlShutdownPort {
  /** Invocation must close control admission synchronously before returning. */
  readonly drainOnQuit: () => Promise<BrowserControlShutdownReceipt>;
}

export interface BrowserCompositionShutdownReceipt {
  readonly clean: boolean;
  readonly timedOut: boolean;
  readonly registry: Readonly<{
    clean: boolean;
    capabilitiesRevoked: number;
    terminationFailures: number;
  }>;
  readonly ui: BrowserUiShutdownDrainReceipt;
  readonly control:
    | Readonly<{ available: false; clean: false }>
    | Readonly<{
        available: true;
        clean: boolean;
        receipt?: BrowserControlShutdownReceipt;
      }>;
}

interface BrowserShutdownCoordinator {
  readonly bindControlShutdown: (control: BrowserControlShutdownPort) => void;
  readonly drainOnQuit: (reason?: string) => Promise<BrowserCompositionShutdownReceipt>;
  readonly close: (reason?: string) => Promise<BrowserCompositionShutdownReceipt>;
}

const CONTROL_RETAINED_COUNT_KEYS = [
  "requests",
  "edgeAdmissions",
  "dispatches",
  "routeOperations",
  "listenerClosures",
  "sockets",
  "requestControllers",
  "socketPaths",
] as const;

const ownDataValue = (record: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
};

const normalizeControlShutdownReceipt = (
  value: unknown,
): BrowserControlShutdownReceipt | undefined => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const clean = ownDataValue(value, "clean");
    const rounds = ownDataValue(value, "rounds");
    const settled = ownDataValue(value, "settled");
    const fulfilled = ownDataValue(value, "fulfilled");
    const rejected = ownDataValue(value, "rejected");
    const retainedCountsValue = ownDataValue(value, "retainedCounts");
    const retainedLabelsValue = ownDataValue(value, "retainedLabels");
    if (
      typeof clean !== "boolean" ||
      ![rounds, settled, fulfilled, rejected].every(
        (entry) => Number.isSafeInteger(entry) && Number(entry) >= 0,
      ) ||
      typeof retainedCountsValue !== "object" ||
      retainedCountsValue === null ||
      !Array.isArray(retainedLabelsValue) ||
      !retainedLabelsValue.every((label) => typeof label === "string")
    ) {
      return undefined;
    }
    const retainedCounts: Record<string, number> = {};
    for (const key of CONTROL_RETAINED_COUNT_KEYS) {
      const count = ownDataValue(retainedCountsValue, key);
      if (!Number.isSafeInteger(count) || Number(count) < 0) return undefined;
      retainedCounts[key] = Number(count);
    }
    return Object.freeze({
      clean,
      rounds: Number(rounds),
      settled: Number(settled),
      fulfilled: Number(fulfilled),
      rejected: Number(rejected),
      retainedCounts: Object.freeze({
        requests: retainedCounts.requests!,
        edgeAdmissions: retainedCounts.edgeAdmissions!,
        dispatches: retainedCounts.dispatches!,
        routeOperations: retainedCounts.routeOperations!,
        listenerClosures: retainedCounts.listenerClosures!,
        sockets: retainedCounts.sockets!,
        requestControllers: retainedCounts.requestControllers!,
        socketPaths: retainedCounts.socketPaths!,
      }),
      retainedLabels: Object.freeze([...retainedLabelsValue]),
    });
  } catch {
    return undefined;
  }
};

export const makeBrowserShutdownCoordinator = (input: {
  readonly sessions: BrowserSessionService;
  readonly registry: Pick<BrowserCapabilityRegistry, "close">;
  readonly registryTerminationFailures: () => number;
  /** Tests may lower, never raise, the aggregate deadline. */
  readonly drainTimeoutMs?: number;
}): BrowserShutdownCoordinator => {
  const drainTimeoutMs =
    input.drainTimeoutMs !== undefined &&
    Number.isFinite(input.drainTimeoutMs) &&
    input.drainTimeoutMs > 0
      ? Math.min(
          Math.floor(input.drainTimeoutMs),
          BROWSER_COMPOSITION_SHUTDOWN_DRAIN_TIMEOUT_MS,
        )
      : BROWSER_COMPOSITION_SHUTDOWN_DRAIN_TIMEOUT_MS;
  let control: BrowserControlShutdownPort | undefined;
  let shutdownStarted = false;
  let registryReceipt:
    | Readonly<{
        clean: boolean;
        capabilitiesRevoked: number;
        terminationFailures: number;
      }>
    | undefined;
  let drainFlight: Promise<BrowserCompositionShutdownReceipt> | undefined;

  const bindControlShutdown = (next: BrowserControlShutdownPort): void => {
    if (shutdownStarted) {
      throw new Error("browser control shutdown cannot bind after browser shutdown begins");
    }
    if (control !== undefined && control !== next) {
      throw new Error("browser control shutdown is already bound");
    }
    control = next;
  };

  const closeRegistry = (): Readonly<{
    clean: boolean;
    capabilitiesRevoked: number;
    terminationFailures: number;
  }> => {
    if (registryReceipt !== undefined) return registryReceipt;
    try {
      const capabilitiesRevoked = input.registry.close();
      const terminationFailures = input.registryTerminationFailures();
      registryReceipt = Object.freeze({
        clean: terminationFailures === 0,
        capabilitiesRevoked,
        terminationFailures,
      });
    } catch {
      registryReceipt = Object.freeze({
        clean: false,
        capabilitiesRevoked: 0,
        terminationFailures: 1,
      });
    }
    return registryReceipt;
  };

  const drainOnQuit = (
    reason = "browser composition shutdown",
  ): Promise<BrowserCompositionShutdownReceipt> => {
    if (drainFlight !== undefined) return drainFlight;
    shutdownStarted = true;

    let resolveFlight!: (receipt: BrowserCompositionShutdownReceipt) => void;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<BrowserCompositionShutdownReceipt>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // Publish before crossing the session, control, registry, or adapter
    // seams. Any synchronous callback that re-enters observes this exact
    // aggregate rather than starting a recursive second drain.
    drainFlight = flight;
    void flight.then(
      () => {
        if (drainFlight === flight) drainFlight = undefined;
      },
      () => {
        if (drainFlight === flight) drainFlight = undefined;
      },
    );

    const work = (async (): Promise<BrowserCompositionShutdownReceipt> => {
      // Every ingress closes in this synchronous preamble. Starting the
      // control drain first aborts future socket admissions; registry close
      // then revokes already-minted leases before any asynchronous wait.
      const uiPrecommit = input.sessions.beginUiShutdown(reason);
      let controlFlight: Promise<BrowserControlShutdownReceipt> | undefined;
      let controlStartFailed = false;
      if (control !== undefined) {
        try {
          const candidate = Promise.resolve(control.drainOnQuit());
          // A bound port is an external seam. If it re-enters this coordinator
          // and hands our own aggregate promise back, awaiting it here would
          // make the drain wait on itself forever.
          if (Object.is(candidate, flight)) controlStartFailed = true;
          else controlFlight = candidate;
        } catch {
          controlStartFailed = true;
        }
      }
      const registry = closeRegistry();
      let uiFlight: Promise<BrowserUiShutdownDrainReceipt>;
      try {
        const candidate = input.sessions.drainUiOnQuit(reason);
        uiFlight = Object.is(candidate, flight)
          ? Promise.reject(new Error("browser UI drain returned its aggregate shutdown promise"))
          : candidate;
      } catch (error) {
        uiFlight = Promise.reject(error);
      }
      let uiOutcome: PromiseSettledResult<BrowserUiShutdownDrainReceipt> | undefined;
      void uiFlight.then(
        (value) => {
          uiOutcome = { status: "fulfilled", value };
        },
        (reason) => {
          uiOutcome = { status: "rejected", reason };
        },
      );
      let controlOutcome: PromiseSettledResult<BrowserControlShutdownReceipt> | undefined;
      if (controlFlight !== undefined) {
        void controlFlight.then(
          (value) => {
            controlOutcome = { status: "fulfilled", value };
          },
          (reason) => {
            controlOutcome = { status: "rejected", reason };
          },
        );
      }
      const allSettled = Promise.allSettled([
        uiFlight,
        ...(controlFlight === undefined ? [] : [controlFlight]),
      ]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        allSettled.then(() => false),
        new Promise<true>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(true), drainTimeoutMs);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      // Let the per-flight observers publish outcomes from the same settlement
      // turn before constructing the aggregate snapshot.
      await Promise.resolve();
      const ui: BrowserUiShutdownDrainReceipt =
        uiOutcome !== undefined && uiOutcome.status === "fulfilled"
          ? uiOutcome.value as BrowserUiShutdownDrainReceipt
          : Object.freeze({
              epoch: uiPrecommit.epoch,
              clean: false,
              operations: Object.freeze([]),
              settled: uiOutcome?.status === "rejected" ? 1 : 0,
              fulfilled: 0,
              rejected: uiOutcome?.status === "rejected" ? 1 : 0,
              rounds: 0,
              timedOut: uiOutcome === undefined && timedOut,
              activeOperations: uiPrecommit.activeOperations,
              sessionsDestroyed: 0,
              teardownWitnessFailures: 1,
            });
      let controlReceipt: BrowserCompositionShutdownReceipt["control"];
      if (control === undefined) {
        controlReceipt = Object.freeze({ available: false, clean: false });
      } else if (controlStartFailed || controlFlight === undefined) {
        controlReceipt = Object.freeze({ available: true, clean: false });
      } else {
        const normalized = controlOutcome?.status === "fulfilled"
          ? normalizeControlShutdownReceipt(controlOutcome.value)
          : undefined;
        controlReceipt = normalized === undefined
          ? Object.freeze({ available: true, clean: false })
          : Object.freeze({
              available: true,
              clean: normalized.clean,
              receipt: normalized,
            });
      }
      return Object.freeze({
        clean: !timedOut && registry.clean && ui.clean && controlReceipt.clean,
        timedOut,
        registry,
        ui,
        control: controlReceipt,
      });
    })();
    void work.then(resolveFlight, rejectFlight);
    return flight;
  };

  return Object.freeze({
    bindControlShutdown,
    drainOnQuit,
    close: drainOnQuit,
  });
};

export interface BrowserCompositionRuntime {
  readonly profileRoot?: string;
  readonly profileGate?: BrowserProfileGate;
  readonly storagePlatform?: BrowserProfileStoragePlatform;
  readonly viewAdapter?: BrowserViewAdapter;
  readonly makeStorageLifecycle?: (
    dependencies: BrowserProfileStorageDependencies,
  ) => BrowserProfileWipeLifecycle;
}

class BindOnce<T extends object> {
  #bound = false;
  #value: T | undefined;

  bind(value: T): void {
    if (this.#bound) throw new BrowserCompositionStartupError();
    this.#bound = true;
    this.#value = value;
  }

  get(): T {
    if (!this.#bound || this.#value === undefined) {
      throw new BrowserCompositionStartupError();
    }
    return this.#value;
  }
}

/**
 * Builds sessions + profile gate + internal capability registry, completes
 * cold profile recovery, then activates the control plane.
 */
export const startBrowserComposition = async (
  activate: (composition: BrowserComposition) => void | Promise<void>,
  runtime: BrowserCompositionRuntime = {},
): Promise<BrowserComposition> => {
  let registry: BrowserCapabilityRegistry | undefined;
  try {
    const profileGate = runtime.profileGate ?? makeBrowserProfileGate();
    const sessionsRef = new BindOnce<BrowserProfileStorageSessionControl>();
    const capabilitiesRef = new BindOnce<BrowserProfileStorageCapabilityControl>();
    const storageSessionControl = Object.freeze<BrowserProfileStorageSessionControl>({
      beginProfileQuiescence: (profile, reason) =>
        sessionsRef.get().beginProfileQuiescence(profile, reason),
    });
    const storageCapabilityControl = Object.freeze<BrowserProfileStorageCapabilityControl>({
      revokeByProfile: (profile, reason) =>
        capabilitiesRef.get().revokeByProfile(profile, reason),
    });
    // Electron platform/view adapters are production-only defaults so unit
    // tests can inject stubs without importing the electron package.
    const platform =
      runtime.storagePlatform ??
      (await import("./profile-storage-electron")).makeElectronBrowserProfileStoragePlatform();
    const viewAdapter =
      runtime.viewAdapter ?? (await import("./view-adapter")).electronViewAdapter;

    const storage = (runtime.makeStorageLifecycle ?? makeBrowserProfileStorageLifecycle)({
      platform,
      sessions: storageSessionControl,
      capabilities: storageCapabilityControl,
      profileGate,
    });
    const profiles = makeBrowserProfileService(runtime.profileRoot, {
      wipeLifecycle: storage,
      profileGate,
    });
    const sessions = new BrowserSessionService(
      viewAdapter,
      profiles,
      Date.now,
      randomUUID,
      isAllowedBrowserUrl,
      profileGate,
    );
    sessionsRef.bind(sessions);

    let registryTerminationFailures = 0;
    registry = makeBrowserCapabilityRegistry({
      profileGate,
      onTerminate: (notice) => {
        try {
          sessions.destroyOwnerSessions(notice.auditId, "browser authority ended");
        } catch {
          registryTerminationFailures = Math.min(
            Number.MAX_SAFE_INTEGER,
            registryTerminationFailures + 1,
          );
        }
      },
    });
    capabilitiesRef.bind(registry);

    const shutdown = makeBrowserShutdownCoordinator({
      sessions,
      registry,
      registryTerminationFailures: () => registryTerminationFailures,
    });
    const composition = Object.freeze<BrowserComposition>({
      profileGate,
      profiles,
      sessions,
      storage,
      registry,
      bindControlShutdown: shutdown.bindControlShutdown,
      drainOnQuit: shutdown.drainOnQuit,
      close: shutdown.close,
    });
    await Effect.runPromise(profiles.recoverPendingWipe);
    await activate(composition);
    return composition;
  } catch (error) {
    try {
      registry?.close();
    } catch {
      // Startup is already blocked.
    }
    // Preserve cause for diagnostics (tests/logs); public message stays fixed.
    const failure = new BrowserCompositionStartupError();
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
};
