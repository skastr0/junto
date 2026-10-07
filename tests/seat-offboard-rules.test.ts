/**
 * The offboard rules: defaults, per-harness overrides, and the two checks
 * that tie them to the cache window. Also where they are stored (installation
 * settings) and the marker that records who ended a session without notes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OFFBOARD_RULES,
  OFFBOARD_MINUTES_MAX,
  OFFBOARD_REFUSAL_CODES,
  OFFBOARD_REFUSAL_REASON,
  OffboardRules,
  OffboardRulesPatch,
  applyOffboardRulesPatch,
  defaultOffboardRules,
  offboardRulesFor,
  offboardRulesProblem,
  summarizeOffboardRun,
  wholeMinutesBetween,
} from "../src/shared/seat-offboard";
import { applySettingsPatch, defaultSettings, offboardRules } from "../src/shared/settings";
import { applyAndValidatePatch, decodePatchInput } from "../src/main/junto/settings/patch";
import {
  endedPathOf,
  readEndedMarker,
  seatSessionNotesPath,
  writeEndedMarker,
} from "../src/main/junto/seat-sessions/notes-file";

describe("offboard rules", () => {
  it("default to: cache window 60, auto offboard on at 120, idle nudge off at 40", () => {
    expect(defaultOffboardRules()).toEqual({
      cacheWindowMinutes: 60,
      auto: { enabled: true, minutes: 120 },
      nudge: { enabled: false, minutes: 40 },
    });
    expect(offboardRulesProblem(DEFAULT_OFFBOARD_RULES)).toBeUndefined();
    // A fresh copy each time: nobody edits the shared default.
    expect(defaultOffboardRules()).not.toBe(defaultOffboardRules());
    expect(offboardRules(undefined)).toEqual(DEFAULT_OFFBOARD_RULES);
    expect(offboardRules(defaultSettings())).toEqual(DEFAULT_OFFBOARD_RULES);
  });

  it("the idle nudge must come before the cache window, even while it is off", () => {
    const at = applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { minutes: 60 } });
    expect(at.nudge.enabled).toBe(false);
    expect(offboardRulesProblem(at)).toBe(
      "The idle nudge must come before the cache window (60 min): it asks the agent for a turn, which is only cheap while the cache is warm.",
    );
    expect(offboardRulesProblem(applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { minutes: 59 } }))).toBeUndefined();
  });

  it("the auto offboard must come at or after the cache window", () => {
    const early = applyOffboardRulesPatch(defaultOffboardRules(), { auto: { minutes: 59 } });
    expect(offboardRulesProblem(early)).toBe(
      "The auto offboard must come at or after the cache window (60 min): before that the session is still cheap to continue.",
    );
    expect(offboardRulesProblem(applyOffboardRulesPatch(defaultOffboardRules(), { auto: { minutes: 60 } }))).toBeUndefined();
    // Moving the window alone can break either rule.
    expect(offboardRulesProblem(applyOffboardRulesPatch(defaultOffboardRules(), { cacheWindowMinutes: 30 }))).toContain("idle nudge");
    expect(offboardRulesProblem(applyOffboardRulesPatch(defaultOffboardRules(), { cacheWindowMinutes: 180 }))).toContain("auto offboard");
  });

  it("minutes are whole numbers from 1 to seven days", () => {
    const decode = Schema.decodeUnknownResult(OffboardRules);
    expect(Result.isSuccess(decode({ ...DEFAULT_OFFBOARD_RULES, nudge: { enabled: false, minutes: 1 } }))).toBe(true);
    for (const minutes of [0, -5, 1.5, OFFBOARD_MINUTES_MAX + 1]) {
      expect(Result.isFailure(decode({ ...DEFAULT_OFFBOARD_RULES, auto: { enabled: true, minutes } }))).toBe(true);
      expect(offboardRulesProblem({ ...DEFAULT_OFFBOARD_RULES, cacheWindowMinutes: minutes })).toContain(
        "whole number of minutes, from 1 to 10080",
      );
    }
    expect(OFFBOARD_MINUTES_MAX).toBe(10080);
  });

  it("a harness override changes only what it names, for that harness only", () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10, nudge: { minutes: 5 }, auto: { minutes: 15 } } },
    });
    expect(offboardRulesProblem(rules)).toBeUndefined();
    expect(offboardRulesFor(rules, "codex")).toEqual({
      cacheWindowMinutes: 10,
      auto: { enabled: true, minutes: 15 },
      nudge: { enabled: false, minutes: 5 },
    });
    expect(offboardRulesFor(rules, "claude")).toEqual(DEFAULT_OFFBOARD_RULES);
    expect(offboardRulesFor(rules, undefined)).toEqual(DEFAULT_OFFBOARD_RULES);
    expect(offboardRulesFor(rules, "not-a-harness")).toEqual(DEFAULT_OFFBOARD_RULES);
  });

  it("an override is checked against the installation values it does not replace", () => {
    // A short window for one harness leaves the installation's 40 min nudge outside it.
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10 } },
    });
    expect(offboardRulesProblem(rules)).toBe(
      "The idle nudge for codex must come before the cache window (10 min): it asks the agent for a turn, which is only cheap while the cache is warm.",
    );
  });

  it("a patch merges into an override, null removes it, and an emptied one disappears", () => {
    let rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { nudge: { minutes: 20 } }, claude: { auto: { enabled: false } } },
    });
    rules = applyOffboardRulesPatch(rules, { harness: { codex: { nudge: { enabled: true } } } });
    expect(rules.harness).toEqual({
      codex: { nudge: { minutes: 20, enabled: true } },
      claude: { auto: { enabled: false } },
    });
    rules = applyOffboardRulesPatch(rules, { harness: { codex: null } });
    expect(rules.harness).toEqual({ claude: { auto: { enabled: false } } });
    rules = applyOffboardRulesPatch(rules, { harness: { claude: null, grok: {} } });
    expect(rules).toEqual(DEFAULT_OFFBOARD_RULES);
    expect("harness" in rules).toBe(false);
    expect(Result.isSuccess(Schema.decodeUnknownResult(OffboardRulesPatch)({ harness: { codex: null } }))).toBe(true);
  });
});

describe("offboard rules in installation settings", () => {
  it("a settings patch changes them and leaves every other section alone", () => {
    const current = defaultSettings();
    const next = applySettingsPatch(current, { offboard: { nudge: { enabled: true, minutes: 30 } } });
    expect(next.offboard).toEqual({
      cacheWindowMinutes: 60,
      auto: { enabled: true, minutes: 120 },
      nudge: { enabled: true, minutes: 30 },
    });
    expect({ ...next, offboard: undefined }).toEqual({ ...current, offboard: undefined });
  });

  it("main refuses a patch that breaks a rule, with the shared sentence", () => {
    const patch = decodePatchInput({ offboard: { auto: { minutes: 30 } } });
    expect(Result.isSuccess(patch)).toBe(true);
    if (!Result.isSuccess(patch)) return;
    const applied = applyAndValidatePatch(defaultSettings(), patch.success);
    expect(Result.isFailure(applied)).toBe(true);
    if (!Result.isFailure(applied)) return;
    expect(applied.failure.code).toBe("validation");
    expect(applied.failure.message).toBe(
      "The auto offboard must come at or after the cache window (60 min): before that the session is still cheap to continue.",
    );
    const fine = applyAndValidatePatch(defaultSettings(), { offboard: { auto: { enabled: false } } });
    expect(Result.isSuccess(fine)).toBe(true);
  });

  it("refuses minutes outside the range at decode, and unknown fields", () => {
    expect(Result.isFailure(decodePatchInput({ offboard: { auto: { minutes: 0 } } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { auto: { minutes: 2.5 } } }))).toBe(true);
    expect(Result.isFailure(decodePatchInput({ offboard: { idleNudge: { on: true } } }))).toBe(true);
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

describe("who ended a session without notes", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const notes = (): string => {
    const root = mkdtempSync(join(tmpdir(), "junto-ended-marker-"));
    roots.push(root);
    return seatSessionNotesPath(root, "agent-1", "session-1");
  };

  it("is a marker beside the notes file, written and read back", () => {
    const path = notes();
    expect(endedPathOf(path).endsWith("/agent-1/sessions/session-1.ended.json")).toBe(true);
    expect(readEndedMarker(path)).toBeUndefined();
    writeEndedMarker(path, { by: "automatic", at: 1_791_000_000_000 });
    expect(readEndedMarker(path)).toEqual({ by: "automatic", at: 1_791_000_000_000 });
    writeEndedMarker(path, { by: "operator", at: 5 });
    expect(readEndedMarker(path)).toEqual({ by: "operator", at: 5 });
  });

  it("a malformed marker reads as none", () => {
    const path = notes();
    writeEndedMarker(path, { by: "overseer", at: 1 });
    for (const body of ["not json", '{"by":"agent","at":1}', '{"by":"operator"}', "[]"]) {
      writeFileSync(endedPathOf(path), body);
      expect(readEndedMarker(path)).toBeUndefined();
    }
  });
});
