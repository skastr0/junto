// Login-item surface: opt-in "Start Vellum at login" via Electron's
// app.setLoginItemSettings / getLoginItemSettings. Never silent enrollment —
// only explicit toggle. The OS is the source of truth.

import type { LoginItemOpResult, LoginItemState, StartupProvider } from "@shared/ipc";

export type { LoginItemOpResult, LoginItemState };

/** Minimal Electron app surface used by login-item helpers (mockable in tests). */
export interface LoginItemApp {
  readonly getLoginItemSettings: () => {
    readonly openAtLogin: boolean;
    readonly openAsHidden?: boolean;
    readonly wasOpenedAtLogin?: boolean;
    readonly wasOpenedAsHidden?: boolean;
  };
  readonly setLoginItemSettings: (settings: {
    readonly openAtLogin: boolean;
    readonly openAsHidden?: boolean;
  }) => void;
}

export interface StartupProviderPort {
  readonly provider: StartupProvider;
  readonly get: () => LoginItemOpResult;
  readonly set: (openAtLogin: unknown) => LoginItemOpResult;
}

const unsupportedStartupProvider = (platform: NodeJS.Platform): StartupProvider =>
  platform === "linux" ? "systemd-supervision" : "unsupported";

const unsupportedStartupMessage = (provider: StartupProvider): string =>
  provider === "systemd-supervision"
    ? "Apple Login Items are unavailable on Linux; Remotes run under systemd user supervision."
    : "Apple Login Items are only available on macOS.";

export const readLoginItemState = (electronApp: LoginItemApp): LoginItemState => {
  const raw = electronApp.getLoginItemSettings();
  return {
    openAtLogin: Boolean(raw.openAtLogin),
    openAsHidden: Boolean(raw.openAsHidden),
    wasOpenedAtLogin: Boolean(raw.wasOpenedAtLogin),
    wasOpenedAsHidden: Boolean(raw.wasOpenedAsHidden),
  };
};

/**
 * Apply an explicit operator toggle. Always re-reads after set so callers see
 * the OS-reported state (never assume the write stuck).
 */
export const setLoginItemOpenAtLogin = (
  electronApp: LoginItemApp,
  openAtLogin: boolean,
): LoginItemState => {
  electronApp.setLoginItemSettings({
    openAtLogin: Boolean(openAtLogin),
    // Explicit product path: never hide at login by default.
    openAsHidden: false,
  });
  return readLoginItemState(electronApp);
};

export const loginItemOpOk = (state: LoginItemState): LoginItemOpResult => ({
  ok: true,
  provider: "apple-login-items",
  state,
});

export const loginItemOpFail = (
  message: string,
  provider: StartupProvider = "apple-login-items",
): LoginItemOpResult => ({
  ok: false,
  provider,
  message,
});

/**
 * The sole main-process boundary for Apple Login Items. Unsupported platforms
 * return a typed failure before Electron's Apple-only API can be reached.
 */
export const createStartupProvider = (
  electronApp: LoginItemApp,
  platform: NodeJS.Platform = process.platform,
): StartupProviderPort => {
  if (platform !== "darwin") {
    const provider = unsupportedStartupProvider(platform);
    const message = unsupportedStartupMessage(provider);
    return Object.freeze({
      provider,
      get: () => loginItemOpFail(message, provider),
      set: () => loginItemOpFail(message, provider),
    });
  }

  return Object.freeze({
    provider: "apple-login-items",
    get: () => {
      try {
        return loginItemOpOk(readLoginItemState(electronApp));
      } catch (error) {
        return loginItemOpFail(error instanceof Error ? error.message : String(error));
      }
    },
    set: (openAtLogin: unknown) => {
      if (typeof openAtLogin !== "boolean") return loginItemOpFail("openAtLogin must be a boolean");
      try {
        return loginItemOpOk(setLoginItemOpenAtLogin(electronApp, openAtLogin));
      } catch (error) {
        return loginItemOpFail(error instanceof Error ? error.message : String(error));
      }
    },
  });
};
