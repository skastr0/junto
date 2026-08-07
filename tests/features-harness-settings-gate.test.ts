import { describe, expect, it } from "vitest";
import { HARNESS_SETTINGS_ENABLED } from "../src/shared/features";
import {
  applySettingsPatch,
  defaultSettings,
  harnessPrefsFor,
  harnessUserEnabled,
} from "../src/shared/settings";
import {
  harnessVisibleInPalette,
  mergeHarnessLaunchDefaults,
} from "../src/shared/harness-settings";
import { resolveBuildFeatures } from "../scripts/build-features";
import { SHIP_FEATURES } from "../src/shared/feature-catalog";

describe("harness settings product gate", () => {
  it("ship profile defaults harnessSettings off", () => {
    const ship = resolveBuildFeatures({});
    expect(ship.features.harnessSettings).toBe(false);
    expect(SHIP_FEATURES.harnessSettings).toBe(false);
  });

  it("default settings include empty harnesses section", () => {
    const settings = defaultSettings();
    expect(settings.harnesses?.byHarness).toEqual({});
  });

  it("patches per-harness prefs and clears empty strings", () => {
    const next = applySettingsPatch(defaultSettings(), {
      harnesses: {
        byHarness: {
          claude: {
            model: "sonnet",
            effort: "high",
            permissionMode: "acceptEdits",
            enabled: true,
          },
        },
      },
    });
    expect(harnessPrefsFor(next, "claude")).toEqual({
      model: "sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
      enabled: true,
    });
    const cleared = applySettingsPatch(next, {
      harnesses: {
        byHarness: {
          claude: { model: "", effort: "" },
        },
      },
    });
    expect(harnessPrefsFor(cleared, "claude").model).toBeUndefined();
    expect(harnessPrefsFor(cleared, "claude").effort).toBeUndefined();
    expect(harnessPrefsFor(cleared, "claude").permissionMode).toBe(
      "acceptEdits",
    );
  });

  it.runIf(!HARNESS_SETTINGS_ENABLED)(
    "ignores stored defaults when feature is off",
    () => {
      const settings = applySettingsPatch(defaultSettings(), {
        harnesses: {
          byHarness: {
            claude: { model: "sonnet", enabled: false },
          },
        },
      });
      expect(
        mergeHarnessLaunchDefaults(settings, "claude", { model: "opus" }),
      ).toEqual({ model: "opus" });
      // Feature off → palette visibility ignores user opt-out.
      expect(harnessVisibleInPalette(settings, "claude")).toBe(true);
      expect(harnessUserEnabled(settings, "claude")).toBe(false);
    },
  );

  it.runIf(HARNESS_SETTINGS_ENABLED)(
    "merges defaults under explicit cascade picks when feature is on",
    () => {
      const settings = applySettingsPatch(defaultSettings(), {
        harnesses: {
          byHarness: {
            claude: {
              model: "sonnet",
              effort: "high",
              enabled: false,
            },
          },
        },
      });
      expect(mergeHarnessLaunchDefaults(settings, "claude", {})).toEqual({
        model: "sonnet",
        effort: "high",
      });
      expect(
        mergeHarnessLaunchDefaults(settings, "claude", { model: "opus" }),
      ).toEqual({
        model: "opus",
        effort: "high",
      });
      expect(harnessVisibleInPalette(settings, "claude")).toBe(false);
    },
  );
});
