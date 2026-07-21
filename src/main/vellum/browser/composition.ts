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
} from "./sessions";

// Browser composition without ceremony: sessions + profiles + internal
// capability registry (edge-grant leases only). Product access is
// process-bind + canvas edges — no enable/restart grant delivery.

export const BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE =
  "browser security initialization failed; browser startup blocked";

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
  readonly close: () => void;
}

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

    registry = makeBrowserCapabilityRegistry({
      profileGate,
      onTerminate: (notice) => {
        try {
          sessions.destroyOwnerSessions(notice.auditId, "browser authority ended");
        } catch {
          // Registry termination must remain complete if teardown fails.
        }
      },
    });
    capabilitiesRef.bind(registry);

    let closed = false;
    const composition = Object.freeze<BrowserComposition>({
      profileGate,
      profiles,
      sessions,
      storage,
      registry,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          registry?.close();
        } catch {
          // best-effort
        }
      },
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
