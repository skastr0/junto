// Login-item surface: opt-in "Start Vellum at login" via Electron's
// app.setLoginItemSettings / getLoginItemSettings. Never silent enrollment —
// only explicit toggle. Not stored in settings.json; OS is the source of truth.

import type { LoginItemOpResult, LoginItemState } from "@shared/ipc";

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
  state,
});

export const loginItemOpFail = (message: string): LoginItemOpResult => ({
  ok: false,
  message,
});
