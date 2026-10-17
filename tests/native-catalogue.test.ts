import { describe, expect, test } from "vitest";
import { HARNESS_PARAM_KEYS } from "../src/shared/harness-domain/params";
import { NATIVE_SETTINGS, nativeSettingsFor } from "../src/shared/harness-domain/native-catalogue";

describe("native config catalogue", () => {
  test("holds no key that names code, a program, a path, a URL, or an env block", () => {
    const forbidden = /env|hook|command|path|dir|url|helper|mcp|plugin|statusline|script|credential|apikey/i;
    expect(NATIVE_SETTINGS.filter((spec) => forbidden.test(spec.key)).map((spec) => spec.key)).toEqual([]);
  });

  test("names each harness's file by home-relative path and each param by its domain key", () => {
    for (const spec of NATIVE_SETTINGS) {
      expect(spec.file.startsWith("/")).toBe(false);
      if (spec.param !== undefined) expect(HARNESS_PARAM_KEYS).toContain(spec.param);
    }
  });

  test("offers a key only at a verified version", () => {
    expect(nativeSettingsFor("claude", "mini", "2.1.302").map((spec) => spec.key)).toContain("effortLevel");
    expect(nativeSettingsFor("claude", "mini", "2.1.300")).toEqual([]);
    expect(nativeSettingsFor("claude", "mini", undefined)).toEqual([]);
    expect(nativeSettingsFor("codex", "mini", "0.162.1").map((spec) => spec.key)).toEqual([
      "model",
      "model_reasoning_effort",
      "approval_policy",
      "sandbox_mode",
    ]);
  });
});
