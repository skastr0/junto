/**
 * The offboard rules: the cache window, the one setting, per machine and per
 * harness. Also where they are stored (installation settings), how rules
 * saved before the window was the one rule load, and the marker that records
 * who ended a session without notes.
 */
import { join } from "node:path";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CACHE_MODES,
  DEFAULT_CACHE_MODE,
  DEFAULT_CACHE_WINDOW_MINUTES,
  OFFBOARD_MINUTES_MAX,
  OFFBOARD_REFUSAL_CODES,
  OFFBOARD_REFUSAL_REASON,
  OFFBOARD_WORTH,
  OffboardRules,
  OffboardRulesPatch,
  applyOffboardRulesPatch,
  defaultOffboardRules,
  offboardRulesFor,
  offboardRulesProblem,
  sessionWorthCutting,
  summarizeOffboardRun,
  wholeMinutesBetween,
} from "../src/shared/seat-offboard";
import { SETTINGS_VERSION, applySettingsPatch, defaultSettings, offboardRules } from "../src/shared/settings";
import { applyAndValidatePatch, decodePatchInput } from "../src/main/junto/settings/patch";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

describe("offboard rules", () => {
  it("default to one cache window of 60 minutes, with no per-harness windows", () => {
    expect(defaultOffboardRules()).toEqual({ cacheWindowMinutes: 60 });
    expect(DEFAULT_CACHE_WINDOW_MINUTES).toBe(60);
    expect(offboardRulesProblem(defaultOffboardRules())).toBeUndefined();
    // A fresh copy each time: nobody edits the shared default.
    expect(defaultOffboardRules()).not.toBe(defaultOffboardRules());
    expect(offboardRules(undefined)).toEqual(defaultOffboardRules());
    expect(offboardRules(defaultSettings())).toEqual(defaultOffboardRules());
  });

  it("a cache window is a whole number of minutes from 1 to seven days, and any such window can be saved", () => {
    const decode = Schema.decodeUnknownResult(OffboardRules);
    for (const minutes of [1, 5, 60, 180, OFFBOARD_MINUTES_MAX]) {
      expect(Result.isSuccess(decode({ cacheWindowMinutes: minutes }))).toBe(true);
      expect(offboardRulesProblem({ cacheWindowMinutes: minutes })).toBeUndefined();
    }
    for (const minutes of [0, -5, 1.5, OFFBOARD_MINUTES_MAX + 1]) {
      expect(Result.isFailure(decode({ cacheWindowMinutes: minutes }))).toBe(true);
      expect(offboardRulesProblem({ cacheWindowMinutes: minutes })).toContain("whole number of minutes, from 1 to 10080");
    }
    expect(offboardRulesProblem({ cacheWindowMinutes: 60, harness: { codex: { cacheWindowMinutes: 0 } } })).toBe(
      "The cache window for codex must be a whole number of minutes, from 1 to 10080.",
    );
    expect(OFFBOARD_MINUTES_MAX).toBe(10080);
  });

  it("a harness window applies to that harness only; worth is the internal guard for every seat", () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), { harness: { codex: { cacheWindowMinutes: 10 } } });
    expect(offboardRulesProblem(rules)).toBeUndefined();
    expect(offboardRulesFor(rules, "codex")).toEqual({ cacheWindowMinutes: 10, cacheMode: "hybrid", worth: OFFBOARD_WORTH });
    for (const harness of ["claude", undefined, "not-a-harness"]) {
      expect(offboardRulesFor(rules, harness)).toEqual({ cacheWindowMinutes: 60, cacheMode: "hybrid", worth: OFFBOARD_WORTH });
    }
    expect(OFFBOARD_WORTH).toEqual({ workMinutes: 30, tokens: 200_000 });
  });

  it("a patch sets a harness window, null removes it, and an emptied map disappears", () => {
    let rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10 }, pi: { cacheWindowMinutes: 5 } },
    });
    rules = applyOffboardRulesPatch(rules, { cacheWindowMinutes: 90, harness: { codex: { cacheWindowMinutes: 20 } } });
    expect(rules).toEqual({ cacheWindowMinutes: 90, harness: { codex: { cacheWindowMinutes: 20 }, pi: { cacheWindowMinutes: 5 } } });
    rules = applyOffboardRulesPatch(rules, { harness: { codex: null, pi: null } });
    expect(rules).toEqual({ cacheWindowMinutes: 90 });
    expect("harness" in rules).toBe(false);
    const decode = Schema.decodeUnknownResult(OffboardRulesPatch);
    expect(Result.isSuccess(decode({ harness: { codex: null } }))).toBe(true);
    // A harness entry in a patch sets a window; an empty one sets nothing and is refused.
    expect(Result.isFailure(decode({ harness: { codex: {} } }))).toBe(true);
  });

  it("an override saved without a window sets nothing, and the next change drops it", () => {
    const rules: OffboardRules = { cacheWindowMinutes: 60, harness: { claude: {} } };
    expect(offboardRulesFor(rules, "claude").cacheWindowMinutes).toBe(60);
    expect(applyOffboardRulesPatch(rules, {})).toEqual({ cacheWindowMinutes: 60 });
  });

  it("the cache mode is off, manual, auto or hybrid, one per machine; rules without one are hybrid", () => {
    expect(CACHE_MODES).toEqual(["off", "manual", "auto", "hybrid"]);
    expect(DEFAULT_CACHE_MODE).toBe("hybrid");
    expect(offboardRulesFor(defaultOffboardRules(), "claude").cacheMode).toBe("hybrid");
    const decode = Schema.decodeUnknownResult(OffboardRules);
    for (const cacheMode of CACHE_MODES) expect(Result.isSuccess(decode({ cacheWindowMinutes: 60, cacheMode }))).toBe(true);
    expect(Result.isFailure(decode({ cacheWindowMinutes: 60, cacheMode: "never" }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(OffboardRulesPatch)({ cacheMode: "never" }))).toBe(true);
  });

  it("a patch sets the mode for every harness, and a later window change keeps it", () => {
    let rules = applyOffboardRulesPatch(defaultOffboardRules(), { cacheMode: "manual", harness: { codex: { cacheWindowMinutes: 10 } } });
    expect(rules).toEqual({ cacheWindowMinutes: 60, harness: { codex: { cacheWindowMinutes: 10 } }, cacheMode: "manual" });
    for (const harness of ["codex", "claude"]) expect(offboardRulesFor(rules, harness).cacheMode).toBe("manual");
    rules = applyOffboardRulesPatch(rules, { cacheWindowMinutes: 90, harness: { codex: null } });
    expect(rules).toEqual({ cacheWindowMinutes: 90, cacheMode: "manual" });
    expect(offboardRulesProblem(rules)).toBeUndefined();
  });
});

describe("worth cutting", () => {
  it("a session qualifies on either measure, never with no work, and an unknown size does not count", () => {
    const worth = { workMinutes: 30, tokens: 200_000 };
    const MINUTE = 60_000;
    expect(sessionWorthCutting(worth, { workMs: 30 * MINUTE })).toBe(true);
    expect(sessionWorthCutting(worth, { workMs: 29 * MINUTE })).toBe(false);
    expect(sessionWorthCutting(worth, { workMs: MINUTE, tokens: 200_000 })).toBe(true);
    expect(sessionWorthCutting(worth, { workMs: MINUTE, tokens: 199_999 })).toBe(false);
    expect(sessionWorthCutting(worth, { workMs: 0, tokens: 5_000_000 })).toBe(false);
    expect(sessionWorthCutting(worth, { workMs: MINUTE })).toBe(false);
  });
});

describe("offboard rules in installation settings", () => {
  it("a settings patch changes them and leaves every other section alone", () => {
    const current = defaultSettings();
    const next = applySettingsPatch(current, { offboard: { cacheWindowMinutes: 30, harness: { pi: { cacheWindowMinutes: 5 } } } });
    expect(next.offboard).toEqual({ cacheWindowMinutes: 30, harness: { pi: { cacheWindowMinutes: 5 } } });
    expect({ ...next, offboard: undefined }).toEqual({ ...current, offboard: undefined });
  });

  it("main saves any window in range, and refuses minutes outside it and the retired fields at decode", () => {
    for (const offboard of [{ cacheWindowMinutes: 5 }, { cacheWindowMinutes: 600 }]) {
      const patch = decodePatchInput({ offboard });
      expect(Result.isSuccess(patch)).toBe(true);
      if (!Result.isSuccess(patch)) return;
      expect(Result.isSuccess(applyAndValidatePatch(defaultSettings(), patch.success))).toBe(true);
    }
    const mode = decodePatchInput({ offboard: { cacheMode: "auto" } });
    expect(Result.isSuccess(mode)).toBe(true);
    if (Result.isSuccess(mode)) {
      const saved = applyAndValidatePatch(defaultSettings(), mode.success);
      expect(Result.isSuccess(saved) && offboardRules(saved.success)).toEqual({ cacheWindowMinutes: 60, cacheMode: "auto" });
    }
    expect(Result.isFailure(decodePatchInput({ offboard: { cacheMode: "never" } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { cacheWindowMinutes: 0 } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { cacheWindowMinutes: 2.5 } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { auto: { minutes: 120 } } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { nudge: { enabled: true } } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { worth: { tokens: 1_000 } } }))).toBe(true);
  });

  it("rules saved with the auto offboard, the idle nudge and worth load as their window, and save clean", () => {
    const stored = {
      ...preferencesFromSettings(defaultSettings()),
      offboard: {
        cacheWindowMinutes: 45,
        auto: { enabled: true, minutes: 120 },
        nudge: { enabled: true, minutes: 30 },
        worth: { workMinutes: 10, tokens: 50_000 },
        harness: { codex: { cacheWindowMinutes: 10, auto: { minutes: 15 } }, claude: { nudge: { enabled: false } } },
      },
    };
    const settings = decodeStoredSettings(SETTINGS_VERSION, stored, defaultSettings().machine);
    expect(settings.offboard).toEqual({ cacheWindowMinutes: 45, harness: { codex: { cacheWindowMinutes: 10 }, claude: {} } });
    expect(offboardRulesFor(offboardRules(settings), "codex").cacheWindowMinutes).toBe(10);
    expect(offboardRulesFor(offboardRules(settings), "claude").cacheWindowMinutes).toBe(45);
    // The next persist writes the row clean.
    expect(preferencesFromSettings(settings).offboard).toEqual(settings.offboard);
  });
});

describe("the refusals and the run summary", () => {
  it("every refusal code has one sentence, with no middle dot", () => {
    for (const code of OFFBOARD_REFUSAL_CODES) {
      expect(OFFBOARD_REFUSAL_REASON[code].length).toBeGreaterThan(10);
      expect(OFFBOARD_REFUSAL_REASON[code]).not.toContain("·");
      expect(OFFBOARD_REFUSAL_REASON[code].endsWith(".")).toBe(true);
    }
  });

  it("counts closed, asked and refused rows", () => {
    expect(
      summarizeOffboardRun([
        { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: true },
        { seatId: "b", ok: true, action: "ask", outcome: "asked", pastWindow: false },
        { seatId: "c", ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
        { seatId: "d", ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
      ]),
    ).toMatchObject({ closed: 1, asked: 1, refused: 2 });
    expect(wholeMinutesBetween(0, 119_999)).toBe(1);
    expect(wholeMinutesBetween(5_000, 1_000)).toBe(0);
  });
});

