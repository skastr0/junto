import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import { isAllowedBrowserUrl } from "@shared/browser";
import { runClosedBrowserEffect } from "./run-closed";
import {
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityRegistry,
} from "./capabilities";
import type {
  BrowserControlShutdownReceipt as RuntimeBrowserControlShutdownReceipt,
} from "./control";
import { makeBrowserProfileGate, type BrowserProfileGate } from "./profile-gate";
import {
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStorageCapabilityControl,
  type BrowserProfileStorageDependencies,
  type BrowserProfileStorageLifecycle,
  type BrowserProfileStoragePlatform,
  type BrowserProfileStorageSessionControl,
  type BrowserProfileStorageShutdownReceipt,
} from "./profile-storage";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
} from "./profiles";
import { StateEngine } from "../state/service";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserUiShutdownDrainReceipt,
} from "./sessions";
import {
  prepareDefaultBrowserHostCapabilityAuthority,
  type BrowserHostCapabilityAuthorityLease,
} from "./station-authority";

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
  readonly storage: BrowserProfileStorageLifecycle;
  /** Internal edge-grant lease registry — not a product grant surface. */
  readonly registry: BrowserCapabilityRegistry;
  /** Bind the local control socket's future monotonic drain before shutdown. */
  readonly bindControlShutdown: (control: BrowserControlShutdownPort) => void;
  /** Close all browser-domain admission and return one aggregate receipt. */
  readonly drainOnQuit: (reason?: string) => Promise<BrowserCompositionShutdownReceipt>;
}

export type BrowserControlShutdownReceipt = RuntimeBrowserControlShutdownReceipt;

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
  readonly storage: BrowserProfileStorageShutdownReceipt;
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

const snapshotStringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const length = ownDataValue(value, "length");
  if (!Number.isSafeInteger(length) || Number(length) < 0) return undefined;
  const snapshot: string[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const entry = ownDataValue(value, String(index));
    if (typeof entry !== "string") return undefined;
    snapshot.push(entry);
  }
  return Object.freeze(snapshot);
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
    const retainedLabels = snapshotStringArray(retainedLabelsValue);
    if (
      typeof clean !== "boolean" ||
      ![rounds, settled, fulfilled, rejected].every(
        (entry) => Number.isSafeInteger(entry) && Number(entry) >= 0,
      ) ||
      typeof retainedCountsValue !== "object" ||
      retainedCountsValue === null ||
      retainedLabels === undefined
    ) {
      return undefined;
    }
    const retainedCounts: Record<string, number> = {};
    for (const key of CONTROL_RETAINED_COUNT_KEYS) {
      const count = ownDataValue(retainedCountsValue, key);
      if (!Number.isSafeInteger(count) || Number(count) < 0) return undefined;
      retainedCounts[key] = Number(count);
    }
    if (Number(settled) !== Number(fulfilled) + Number(rejected)) return undefined;
    const noRetainedCounts = CONTROL_RETAINED_COUNT_KEYS.every(
      (key) => retainedCounts[key] === 0,
    );
    const normalizedClean =
      clean && noRetainedCounts && retainedLabels.length === 0;
    return Object.freeze({
      clean: normalizedClean,
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
      retainedLabels,
    });
  } catch {
    return undefined;
  }
};

export const makeBrowserShutdownCoordinator = (input: {
  readonly sessions: BrowserSessionService;
  readonly storage: Pick<BrowserProfileStorageLifecycle, "beginShutdown" | "drainOnQuit">;
  readonly registry: Pick<BrowserCapabilityRegistry, "close">;
  readonly registryTerminationFailures: () => number;
  readonly releaseHostAuthority?: () => void;
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
      // Every ingress closes in this synchronous preamble. Storage and UI
      // close before any external wait; starting the control drain aborts
      // future socket admissions; registry close then revokes already-minted
      // leases before any asynchronous wait.
      const uiPrecommit = input.sessions.beginUiShutdown(reason);
      const storagePrecommit = input.storage.beginShutdown();
      try {
        input.releaseHostAuthority?.();
      } catch {
        // Browser admission is already closed; authority cleanup is best effort.
      }
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
      let storageFlight: Promise<BrowserProfileStorageShutdownReceipt>;
      try {
        const candidate = input.storage.drainOnQuit();
        storageFlight = Object.is(candidate, flight)
          ? Promise.reject(
              new Error("browser storage drain returned its aggregate shutdown promise"),
            )
          : candidate;
      } catch (error) {
        storageFlight = Promise.reject(error);
      }
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
      let storageOutcome:
        | PromiseSettledResult<BrowserProfileStorageShutdownReceipt>
        | undefined;
      void storageFlight.then(
        (value) => {
          storageOutcome = { status: "fulfilled", value };
        },
        (reason) => {
          storageOutcome = { status: "rejected", reason };
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
        storageFlight,
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
              teardownWitnessFailures: 0,
            });
      const storage: BrowserProfileStorageShutdownReceipt =
        storageOutcome !== undefined && storageOutcome.status === "fulfilled"
          ? storageOutcome.value
          : Object.freeze({
              epoch: storagePrecommit.epoch,
              clean: false,
              operations: Object.freeze([]),
              settled: storageOutcome?.status === "rejected" ? 1 : 0,
              fulfilled: 0,
              rejected: storageOutcome?.status === "rejected" ? 1 : 0,
              rounds: 0,
              timedOut: storageOutcome === undefined && timedOut,
              activeOperations: storagePrecommit.activeOperations,
              activeRawClearOperations: storagePrecommit.activeRawClearOperations,
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
        clean:
          !timedOut &&
          registry.clean &&
          storage.clean &&
          ui.clean &&
          controlReceipt.clean,
        timedOut,
        registry,
        storage,
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
  });
};

export interface BrowserCompositionRuntime {
  readonly state: Context.Service.Shape<typeof StateEngine>;
  readonly profileRoot?: string;
  readonly profileGate?: BrowserProfileGate;
  readonly storagePlatform?: BrowserProfileStoragePlatform;
  readonly viewAdapter?: BrowserViewAdapter;
  readonly prepareHostAuthority?: () => Promise<BrowserHostCapabilityAuthorityLease>;
  readonly makeStorageLifecycle?: (
    dependencies: BrowserProfileStorageDependencies,
  ) => BrowserProfileStorageLifecycle;
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
  runtime: BrowserCompositionRuntime,
): Promise<BrowserComposition> => {
  let registry: BrowserCapabilityRegistry | undefined;
  let hostAuthorityLease: BrowserHostCapabilityAuthorityLease | undefined;
  try {
    // This is an authority barrier, not a background warm-up: no Electron
    // adapter, control socket, or renderer IPC exists until durable station
    // identity has hydrated and subscribed to transactional settings changes.
    hostAuthorityLease = await (
      runtime.prepareHostAuthority ??
      prepareDefaultBrowserHostCapabilityAuthority
    )();
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
    const profiles = makeBrowserProfileService(runtime.state, runtime.profileRoot, {
      wipeLifecycle: storage,
      profileGate,
    });
    const sessions = new BrowserSessionService(
      viewAdapter,
      hostAuthorityLease.authority,
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
      storage,
      registry,
      registryTerminationFailures: () => registryTerminationFailures,
      releaseHostAuthority: hostAuthorityLease.close,
    });
    const composition = Object.freeze<BrowserComposition>({
      profileGate,
      profiles,
      sessions,
      storage,
      registry,
      bindControlShutdown: shutdown.bindControlShutdown,
      drainOnQuit: shutdown.drainOnQuit,
    });
    // recoverPendingWipe is R=never on the injected profiles API.
    await runClosedBrowserEffect(profiles.recoverPendingWipe);
    await activate(composition);
    return composition;
  } catch (error) {
    try {
      hostAuthorityLease?.close();
    } catch {
      // Startup is already blocked.
    }
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
