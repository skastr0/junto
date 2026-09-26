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
  experimentalFeatureSpec,
  type FeatureKey,
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
      // Sound ships on at a gentle default volume.
      audio: true,
      liveOverseer: false,
      hermesIntegration: false,
      devTools: false,
      // Seat awareness (Jev) and seat collaboration ship experimental: built
      // into the app, off until the operator turns them on in Settings.
      seatAwareness: "experimental",
      // Seats connect only as messages; the reviews family is off.
      reviews: false,
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
      /JUNTO_RELAY must be 0, 1 or experimental/u,
    );
  });

  it("refuses the experimental tier for a feature with no Settings toggle", () => {
    expect(() => resolveBuildFeatures({ JUNTO_RELAY: "experimental" })).toThrow(
      /JUNTO_RELAY=experimental is not available: relay has no Settings toggle/u,
    );
    // Every experimental entry in the shipped profiles has a toggle.
    for (const [key, tier] of Object.entries(SHIP_FEATURES)) {
      if (tier === "experimental") {
        expect(experimentalFeatureSpec(key as FeatureKey)).toBeDefined();
      }
    }
  });

  it("keeps the receipt and fingerprint honest about the three tiers", () => {
    const ship = resolveBuildFeatures({});
    expect(ship.experimental).toEqual(["seatAwareness"]);
    expect(ship.fingerprint).toContain("seatAwareness=x");
    expect(ship.fingerprint).toContain("cron=0");
    expect(ship.fingerprint).toContain("harnessKimi=1");
    // Experimental is not on: an all-on build and a ship build differ here.
    const allOn = resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "all-on" });
    expect(allOn.experimental).toEqual([]);
    expect(allOn.fingerprint).toContain("seatAwareness=1");
    // Compiled out is not experimental either.
    const out = resolveBuildFeatures({ JUNTO_SEAT_AWARENESS: "0" });
    expect(out.experimental).toEqual([]);
    expect(out.fingerprint).toContain("seatAwareness=0");
    expect(out.overrides).toEqual(["seatAwareness"]);
    // The define carries the tier itself, so the bundle knows the difference.
    expect(featureViteDefines(ship)[FEATURE_CATALOG.seatAwareness.define]).toBe('"experimental"');
    expect(featureBunDefineArgs(ship)).toContain(
      `--define=${FEATURE_CATALOG.seatAwareness.define}="experimental"`,
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
