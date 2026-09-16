import { describe, expect, it } from "vitest";
import {
  featureBunDefineArgs,
  featureFingerprint,
  featureViteDefines,
  resolveBuildFeatures,
} from "../scripts/build-features";
import {
  ALL_FEATURES,
  FEATURE_CATALOG,
  SHIP_FEATURES,
} from "../src/shared/feature-catalog";

describe("compile-time feature profiles", () => {
  it("keeps the approved SHIP feature set explicit", () => {
    const resolved = resolveBuildFeatures({});
    expect(resolved.profile).toBe("ship");
    expect(resolved.features).toEqual(SHIP_FEATURES);
    expect(resolved.features).toEqual({
      cron: false,
      relay: false,
      browser: false,
      board: false,
      pad: false,
      sheet: false,
      requests: false,
      artifacts: false,
      tasks: false,
      fleetUi: false,
      usage: false,
      helpMap: false,
      audio: false,
      liveOverseer: false,
      hermesIntegration: false,
      devTools: false,
      // Every managed harness ships ON; each gate remains the way back off.
      // The Hermes TUI seat is one of them; only the ACP integration stays off.
      harnessHermes: true,
      harnessKimi: true,
      harnessMuse: true,
      harnessFx: true,
      harnessAmp: true,
      harnessOmp: true,
      harnessPrimeAgent: true,
      harnessSettings: false,
    });
  });

  it("supports an explicit all-on regression profile", () => {
    const resolved = resolveBuildFeatures({
      JUNTO_FEATURE_PROFILE: "all-on",
    });
    expect(resolved.features).toEqual(ALL_FEATURES);
    expect(resolved.features.harnessPrimeAgent).toBe(true);
  });

  it("applies an explicit false override to the shipped Prime Agent gate", () => {
    const resolved = resolveBuildFeatures({
      JUNTO_HARNESS_PRIME_AGENT: "0",
    });
    expect(resolved.profile).toBe("ship");
    expect(resolved.features.harnessPrimeAgent).toBe(false);
    expect(resolved.overrides).toEqual(["harnessPrimeAgent"]);
  });

  it("applies typed per-feature overrides over the selected profile", () => {
    const resolved = resolveBuildFeatures({
      JUNTO_FEATURE_PROFILE: "all-on",
      JUNTO_BROWSER: "0",
      JUNTO_CRON: "0",
      JUNTO_AUDIO: "1",
    });
    expect(resolved.features.browser).toBe(false);
    expect(resolved.features.cron).toBe(false);
    expect(resolved.features.audio).toBe(true);
    expect(resolved.overrides).toEqual(["cron", "browser", "audio"]);
  });

  it("rejects malformed profiles and overrides", () => {
    expect(() =>
      resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "maybe" }),
    ).toThrow(/must be ship or all-on/u);
    expect(() => resolveBuildFeatures({ JUNTO_RELAY: "true" })).toThrow(
      /JUNTO_RELAY must be 0 or 1/u,
    );
  });

  it("generates identical Vite and Bun define values", () => {
    const resolved = resolveBuildFeatures({
      JUNTO_BROWSER: "1",
      JUNTO_USAGE: "1",
    });
    const vite = featureViteDefines(resolved);
    const bun = featureBunDefineArgs(resolved);
    for (const spec of Object.values(FEATURE_CATALOG)) {
      expect(bun).toContain(`--define=${spec.define}=${vite[spec.define]}`);
    }
    expect(resolved.fingerprint).toBe(featureFingerprint(resolved.features));
  });
});
