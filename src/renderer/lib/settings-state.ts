import type {
  Settings,
  SettingsPatch,
  SettingsSectionKey,
  StationPatch,
} from "@shared/settings";
import { state$ } from "./state";

/** Hydrate settings from main and subscribe for push updates. Idempotent. */
let bridgeStarted = false;

export const startSettingsBridge = (): (() => void) | undefined => {
  if (bridgeStarted || !window.junto?.settingsGet) return undefined;
  bridgeStarted = true;

  const unsub = window.junto.onSettingsChanged((settings) => {
    state$.settings.set(settings);
    state$.settingsReady.set(true);
    state$.settingsError.set("");
  });

  void (async () => {
    state$.settingsLoading.set(true);
    try {
      const result = await window.junto!.settingsGet();
      if (result.ok && result.settings) {
        state$.settings.set(result.settings);
        state$.settingsReady.set(true);
        state$.settingsError.set("");
      } else {
        state$.settingsError.set(result.message ?? "failed to load settings");
      }
    } catch (error) {
      state$.settingsError.set(error instanceof Error ? error.message : String(error));
    } finally {
      state$.settingsLoading.set(false);
    }
  })();

  return () => {
    unsub();
    bridgeStarted = false;
  };
};

export const openSettings = (): void => {
  state$.settingsOpen.set(true);
};

export const closeSettings = (): void => {
  state$.settingsOpen.set(false);
};

export const patchSettings = async (patch: SettingsPatch): Promise<boolean> => {
  if (!window.junto?.settingsPatch) {
    state$.settingsError.set("settings API unavailable");
    return false;
  }
  try {
    const result = await window.junto.settingsPatch(patch);
    if (result.ok && result.settings) {
      state$.settings.set(result.settings);
      state$.settingsError.set("");
      return true;
    }
    state$.settingsError.set(result.message ?? "patch failed");
    return false;
  } catch (error) {
    state$.settingsError.set(error instanceof Error ? error.message : String(error));
    return false;
  }
};

export const resetSettings = async (section?: SettingsSectionKey): Promise<boolean> => {
  if (!window.junto?.settingsReset) {
    state$.settingsError.set("settings API unavailable");
    return false;
  }
  try {
    const result = await window.junto.settingsReset(section);
    if (result.ok && result.settings) {
      state$.settings.set(result.settings);
      state$.settingsError.set("");
      return true;
    }
    state$.settingsError.set(result.message ?? "reset failed");
    return false;
  } catch (error) {
    state$.settingsError.set(error instanceof Error ? error.message : String(error));
    return false;
  }
};

/**
 * Topology transitions (role / hostId / CC ref / supervisedPreferred).
 * Uses the dedicated protected-topology IPC — never generic settingsPatch.
 */
export const setStationTopology = async (station: StationPatch): Promise<boolean> => {
  if (!window.junto?.settingsSetStationTopology) {
    state$.settingsError.set("station topology API unavailable");
    return false;
  }
  try {
    const result = await window.junto.settingsSetStationTopology(station);
    if (result.ok && result.settings) {
      state$.settings.set(result.settings);
      state$.settingsError.set("");
      return true;
    }
    state$.settingsError.set(result.message ?? "topology update failed");
    return false;
  } catch (error) {
    state$.settingsError.set(error instanceof Error ? error.message : String(error));
    return false;
  }
};

export const settingsSnapshot = (): Settings => state$.settings.peek();
