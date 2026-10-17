import { describe, expect, test } from "vitest";
import { applySettingsPatch, defaultSettings, harnessPrefsFor, machineHarnessPrefsFor } from "../src/shared/settings";
import { HARNESS_SETTINGS_ENABLED } from "../src/shared/features";
import { resolveHarnessLaunchDefaults } from "../src/shared/harness-settings";

describe("per-machine harness overrides", () => {
  test("a machine override is kept apart from the app-wide default", () => {
    const set = applySettingsPatch(defaultSettings(), {
      harnesses: {
        byHarness: { claude: { model: "opus" } },
        byMachine: { "mac-mini": { byHarness: { claude: { model: "sonnet", effort: "high" } } } },
      },
    });
    expect(harnessPrefsFor(set, "claude")).toEqual({ model: "opus" });
    expect(machineHarnessPrefsFor(set, "mac-mini", "claude")).toEqual({ model: "sonnet", effort: "high" });
    expect(machineHarnessPrefsFor(set, "macbook", "claude")).toEqual({});
  });

  test("clearing the last override removes the machine", () => {
    const set = applySettingsPatch(defaultSettings(), {
      harnesses: { byMachine: { "mac-mini": { byHarness: { codex: { effort: "low" } } } } },
    });
    const cleared = applySettingsPatch(set, {
      harnesses: { byMachine: { "mac-mini": { byHarness: { codex: { effort: "" } } } } },
    });
    expect(machineHarnessPrefsFor(cleared, "mac-mini", "codex")).toEqual({});
    expect(cleared.harnesses?.byMachine).toBeUndefined();
  });

  test("a machine can say no extra arguments over the app-wide list, and inherit it back", () => {
    const set = applySettingsPatch(defaultSettings(), {
      harnesses: {
        byHarness: { claude: { extraArgs: ["--verbose"] } },
        byMachine: { "mac-mini": { byHarness: { claude: { extraArgs: [] } } } },
      },
    });
    expect(machineHarnessPrefsFor(set, "mac-mini", "claude")).toEqual({ extraArgs: [] });
    const back = applySettingsPatch(set, {
      harnesses: { byMachine: { "mac-mini": { byHarness: { claude: { inherit: ["extraArgs"] } } } } },
    });
    expect(back.harnesses?.byMachine).toBeUndefined();
    expect(harnessPrefsFor(back, "claude").extraArgs).toEqual(["--verbose"]);
  });

  test("a machine patch leaves the app-wide default alone", () => {
    const set = applySettingsPatch(defaultSettings(), { harnesses: { byHarness: { pi: { model: "x" } } } });
    const next = applySettingsPatch(set, {
      harnesses: { byMachine: { "mac-mini": { byHarness: { pi: { model: "y" } } } } },
    });
    expect(harnessPrefsFor(next, "pi")).toEqual({ model: "x" });
  });
});

describe("launch defaults per machine", () => {
  const settings = applySettingsPatch(defaultSettings(), {
    harnesses: {
      byHarness: { claude: { model: "opus", effort: "high" }, codex: { permissionMode: "untrusted" } },
      byMachine: { "mac-mini": { byHarness: { claude: { model: "sonnet", extraArgs: [] } } } },
    },
  });

  test.runIf(HARNESS_SETTINGS_ENABLED)("the seat's machine override wins over the app-wide default", () => {
    expect(resolveHarnessLaunchDefaults(settings, "claude", "mac-mini")).toEqual({
      model: "sonnet",
      effort: "high",
      extraArgs: [],
    });
    expect(resolveHarnessLaunchDefaults(settings, "claude", "macbook")).toEqual({ model: "opus", effort: "high" });
  });

  test.runIf(HARNESS_SETTINGS_ENABLED)("an explicit choice wins over both", () => {
    expect(resolveHarnessLaunchDefaults(settings, "claude", "mac-mini", { model: "haiku" }).model).toBe("haiku");
  });

  test.runIf(HARNESS_SETTINGS_ENABLED)("a saved value the harness refuses is not passed", () => {
    expect(resolveHarnessLaunchDefaults(settings, "codex", "mac-mini").permissionMode).toBeUndefined();
  });
});
