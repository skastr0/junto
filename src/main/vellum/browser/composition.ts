import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { isAllowedBrowserUrl } from "@shared/browser";
import {
  makeBrowserAutomationProduct,
  type BrowserAutomationProduct,
  type BrowserAutomationProductDependencies,
} from "./agent-product";
import { makeBrowserProfileGate, type BrowserProfileGate } from "./profile-gate";
import {
  makeBrowserProfileStorageLifecycle,
  type BrowserProfileStorageCapabilityControl,
  type BrowserProfileStorageDependencies,
  type BrowserProfileStoragePlatform,
  type BrowserProfileStorageSessionControl,
} from "./profile-storage";
import { makeElectronBrowserProfileStoragePlatform } from "./profile-storage-electron";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
  type BrowserProfileWipeLifecycle,
} from "./profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
} from "./sessions";
import { electronViewAdapter } from "./view-adapter";

export const BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE =
  "browser security initialization failed; browser startup blocked";

export class BrowserCompositionStartupError extends Error {
  override readonly name = "BrowserCompositionStartupError";

  constructor() {
    super(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
  }
}

export type BrowserCompositionDependencies = Omit<
  BrowserAutomationProductDependencies,
  "sessions" | "profileGate"
>;

export interface BrowserComposition {
  readonly profileGate: BrowserProfileGate;
  readonly profiles: BrowserProfileServiceApi;
  readonly sessions: BrowserSessionService;
  readonly storage: BrowserProfileWipeLifecycle;
  readonly automation: BrowserAutomationProduct;
}

export interface BrowserCompositionRuntime {
  readonly profileRoot?: string;
  readonly profileGate?: BrowserProfileGate;
  readonly storagePlatform?: BrowserProfileStoragePlatform;
  readonly viewAdapter?: BrowserViewAdapter;
  readonly makeStorageLifecycle?: (
    dependencies: BrowserProfileStorageDependencies,
  ) => BrowserProfileWipeLifecycle;
  readonly makeAutomationProduct?: (
    dependencies: BrowserAutomationProductDependencies,
  ) => BrowserAutomationProduct;
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

const closeAutomation = (automation: BrowserAutomationProduct | undefined): void => {
  try {
    automation?.close();
  } catch {
    // Startup is already blocked; cleanup cannot weaken the fixed failure.
  }
};

/**
 * Builds the sole browser authority graph, completes cold profile recovery,
 * and only then invokes the caller-owned activation boundary. The private
 * bind-once delegates break the storage lifecycle cycle without widening its
 * session or capability authority.
 */
export const startBrowserComposition = async (
  dependencies: BrowserCompositionDependencies,
  activate: (composition: BrowserComposition) => void | Promise<void>,
  runtime: BrowserCompositionRuntime = {},
): Promise<BrowserComposition> => {
  let automation: BrowserAutomationProduct | undefined;
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
    const storage = (runtime.makeStorageLifecycle ?? makeBrowserProfileStorageLifecycle)({
      platform: runtime.storagePlatform ?? makeElectronBrowserProfileStoragePlatform(),
      sessions: storageSessionControl,
      capabilities: storageCapabilityControl,
      profileGate,
    });
    const profiles = makeBrowserProfileService(runtime.profileRoot, {
      wipeLifecycle: storage,
      profileGate,
    });
    const sessions = new BrowserSessionService(
      runtime.viewAdapter ?? electronViewAdapter,
      profiles,
      Date.now,
      randomUUID,
      isAllowedBrowserUrl,
      profileGate,
    );
    sessionsRef.bind(sessions);
    automation = (runtime.makeAutomationProduct ?? makeBrowserAutomationProduct)({
      ...dependencies,
      sessions,
      profileGate,
    });
    capabilitiesRef.bind(automation.registry);

    const composition = Object.freeze<BrowserComposition>({
      profileGate,
      profiles,
      sessions,
      storage,
      automation,
    });
    await Effect.runPromise(profiles.recoverPendingWipe);
    await activate(composition);
    return composition;
  } catch {
    closeAutomation(automation);
    throw new BrowserCompositionStartupError();
  }
};
