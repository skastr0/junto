import { describe, expect, it, vi } from "vitest";
import {
  applyE2eMacOsFocusIsolation,
  e2eFocusIsolationActive,
  e2eMainWindowOptions,
  e2ePresentationFromEnv,
} from "../src/main/vellum-command/e2e-presentation";

describe("e2eFocusIsolationActive", () => {
  it("is on only for E2E without VELLUM_COMMAND_E2E_SHOW", () => {
    expect(e2eFocusIsolationActive({ e2e: true, showWindows: false })).toBe(true);
    expect(e2eFocusIsolationActive({ e2e: true, showWindows: true })).toBe(false);
    expect(e2eFocusIsolationActive({ e2e: false, showWindows: false })).toBe(false);
  });
});

describe("e2eMainWindowOptions", () => {
  it("hides and de-focuses windows under E2E isolation", () => {
    expect(e2eMainWindowOptions({ e2e: true, showWindows: false })).toEqual({
      show: false,
      focusable: false,
      skipTaskbar: true,
    });
  });

  it("is a no-op for production and visible E2E debug", () => {
    expect(e2eMainWindowOptions({ e2e: false, showWindows: false })).toEqual({});
    expect(e2eMainWindowOptions({ e2e: true, showWindows: true })).toEqual({});
  });
});

describe("e2ePresentationFromEnv", () => {
  it("reads VELLUM_COMMAND_E2E and VELLUM_COMMAND_E2E_SHOW", () => {
    expect(e2ePresentationFromEnv({ VELLUM_COMMAND_E2E: "1" })).toEqual({
      e2e: true,
      showWindows: false,
    });
    expect(e2ePresentationFromEnv({ VELLUM_COMMAND_E2E: "1", VELLUM_COMMAND_E2E_SHOW: "1" })).toEqual({
      e2e: true,
      showWindows: true,
    });
    expect(e2ePresentationFromEnv({})).toEqual({ e2e: false, showWindows: false });
  });
});

describe("applyE2eMacOsFocusIsolation", () => {
  it("sets accessory policy and hides dock only on darwin when active", () => {
    const setActivationPolicy = vi.fn();
    const hideDock = vi.fn();
    applyE2eMacOsFocusIsolation({
      active: true,
      platform: "darwin",
      setActivationPolicy,
      hideDock,
    });
    expect(setActivationPolicy).toHaveBeenCalledWith("accessory");
    expect(hideDock).toHaveBeenCalledTimes(1);

    setActivationPolicy.mockClear();
    hideDock.mockClear();
    applyE2eMacOsFocusIsolation({
      active: true,
      platform: "linux",
      setActivationPolicy,
      hideDock,
    });
    expect(setActivationPolicy).not.toHaveBeenCalled();
    expect(hideDock).not.toHaveBeenCalled();

    applyE2eMacOsFocusIsolation({
      active: false,
      platform: "darwin",
      setActivationPolicy,
      hideDock,
    });
    expect(setActivationPolicy).not.toHaveBeenCalled();
  });

  it("tolerates missing dock/policy APIs and thrown policy errors", () => {
    expect(() =>
      applyE2eMacOsFocusIsolation({
        active: true,
        platform: "darwin",
        setActivationPolicy: () => {
          throw new Error("too late");
        },
        hideDock: () => {
          throw new Error("no dock");
        },
      }),
    ).not.toThrow();

    expect(() =>
      applyE2eMacOsFocusIsolation({
        active: true,
        platform: "darwin",
      }),
    ).not.toThrow();
  });
});
