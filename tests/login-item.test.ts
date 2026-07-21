import { describe, expect, it, vi } from "vitest";
import {
  loginItemOpFail,
  loginItemOpOk,
  readLoginItemState,
  setLoginItemOpenAtLogin,
  type LoginItemApp,
} from "../src/main/vellum/login-item";

const mockApp = (initial: {
  openAtLogin?: boolean;
  openAsHidden?: boolean;
  wasOpenedAtLogin?: boolean;
  wasOpenedAsHidden?: boolean;
}): LoginItemApp & { readonly sets: Array<{ openAtLogin: boolean; openAsHidden?: boolean }> } => {
  let state = {
    openAtLogin: initial.openAtLogin ?? false,
    openAsHidden: initial.openAsHidden ?? false,
    wasOpenedAtLogin: initial.wasOpenedAtLogin ?? false,
    wasOpenedAsHidden: initial.wasOpenedAsHidden ?? false,
  };
  const sets: Array<{ openAtLogin: boolean; openAsHidden?: boolean }> = [];
  return {
    sets,
    getLoginItemSettings: () => ({ ...state }),
    setLoginItemSettings: (next) => {
      sets.push({ ...next });
      state = {
        ...state,
        openAtLogin: next.openAtLogin,
        openAsHidden: next.openAsHidden ?? false,
      };
    },
  };
};

describe("login item state round-trip", () => {
  it("reads real getLoginItemSettings — never assumes off", () => {
    const app = mockApp({ openAtLogin: true, openAsHidden: true, wasOpenedAtLogin: true });
    expect(readLoginItemState(app)).toEqual({
      openAtLogin: true,
      openAsHidden: true,
      wasOpenedAtLogin: true,
      wasOpenedAsHidden: false,
    });
  });

  it("default-shaped read when OS reports nothing set", () => {
    const app = mockApp({});
    expect(readLoginItemState(app).openAtLogin).toBe(false);
  });

  it("set openAtLogin true then false round-trips via OS mock", () => {
    const app = mockApp({ openAtLogin: false });
    const on = setLoginItemOpenAtLogin(app, true);
    expect(on.openAtLogin).toBe(true);
    expect(app.sets).toEqual([{ openAtLogin: true, openAsHidden: false }]);

    const off = setLoginItemOpenAtLogin(app, false);
    expect(off.openAtLogin).toBe(false);
    expect(app.sets.at(-1)).toEqual({ openAtLogin: false, openAsHidden: false });
    expect(readLoginItemState(app).openAtLogin).toBe(false);
  });

  it("never writes openAsHidden true on explicit toggle", () => {
    const app = mockApp({ openAtLogin: false, openAsHidden: true });
    setLoginItemOpenAtLogin(app, true);
    expect(app.sets[0]).toEqual({ openAtLogin: true, openAsHidden: false });
  });

  it("setLoginItemSettings is only invoked on explicit toggle helper", () => {
    const set = vi.fn();
    const app: LoginItemApp = {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: set,
    };
    readLoginItemState(app);
    expect(set).not.toHaveBeenCalled();
    setLoginItemOpenAtLogin(app, true);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("op result helpers", () => {
    const state = readLoginItemState(mockApp({ openAtLogin: true }));
    expect(loginItemOpOk(state)).toEqual({ ok: true, state });
    expect(loginItemOpFail("boom")).toEqual({ ok: false, message: "boom" });
  });
});
