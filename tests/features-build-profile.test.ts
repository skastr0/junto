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
  it("keeps every ship-cut surface off by default", () => {
    const resolved = resolveBuildFeatures({});
    expect(resolved.profile).toBe("ship");
    expect(resolved.features).toEqual(SHIP_FEATURES);
    expect(Object.values(resolved.features)).toEqual(
      Object.values(resolved.features).map(() => false),
    );
  });

  it("supports an explicit all-on regression profile", () => {
    expect(
      resolveBuildFeatures({ VELLUM_COMMAND_FEATURE_PROFILE: "all-on" }).features,
    ).toEqual(ALL_FEATURES);
  });

  it("applies typed per-feature overrides over the selected profile", () => {
    const resolved = resolveBuildFeatures({
      VELLUM_COMMAND_FEATURE_PROFILE: "all-on",
      VELLUM_COMMAND_BROWSER: "0",
      VELLUM_COMMAND_CRON: "0",
      VELLUM_COMMAND_AUDIO: "1",
    });
    expect(resolved.features.browser).toBe(false);
    expect(resolved.features.cron).toBe(false);
    expect(resolved.features.audio).toBe(true);
    expect(resolved.overrides).toEqual(["cron", "browser", "audio"]);
  });

  it("rejects malformed profiles and overrides", () => {
    expect(() =>
      resolveBuildFeatures({ VELLUM_COMMAND_FEATURE_PROFILE: "maybe" }),
    ).toThrow(/must be ship or all-on/u);
    expect(() => resolveBuildFeatures({ VELLUM_COMMAND_RELAY: "true" })).toThrow(
      /VELLUM_COMMAND_RELAY must be 0 or 1/u,
    );
  });

  it("generates identical Vite and Bun define values", () => {
    const resolved = resolveBuildFeatures({
      VELLUM_COMMAND_BROWSER: "1",
      VELLUM_COMMAND_USAGE: "1",
    });
    const vite = featureViteDefines(resolved);
    const bun = featureBunDefineArgs(resolved);
    for (const spec of Object.values(FEATURE_CATALOG)) {
      expect(bun).toContain(`--define=${spec.define}=${vite[spec.define]}`);
    }
    expect(resolved.fingerprint).toBe(featureFingerprint(resolved.features));
  });
});
