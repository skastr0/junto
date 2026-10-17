import { describe, expect, test } from "vitest";
import { applySettingsPatch, defaultSettings, harnessPrefsFor, machineHarnessPrefsFor } from "../src/shared/settings";

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
    expect(cleared.harnesses?.byMachine?.["mac-mini"]?.byHarness.codex).toEqual({});
  });

  test("a machine patch leaves the app-wide default alone", () => {
    const set = applySettingsPatch(defaultSettings(), { harnesses: { byHarness: { pi: { model: "x" } } } });
    const next = applySettingsPatch(set, {
      harnesses: { byMachine: { "mac-mini": { byHarness: { pi: { model: "y" } } } } },
    });
    expect(harnessPrefsFor(next, "pi")).toEqual({ model: "x" });
  });
});
