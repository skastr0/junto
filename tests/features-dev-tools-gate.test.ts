import { describe, expect, it } from "vitest";
import { DEV_TOOLS_ENABLED } from "../src/shared/features";
import { SHIP_FEATURES } from "../src/shared/feature-catalog";
import { resolveBuildFeatures } from "../scripts/build-features";

describe("dev tools compile-time gate", () => {
  it("is off on the ship profile (prod never injects true)", () => {
    expect(SHIP_FEATURES.devTools).toBe(false);
    expect(
      resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "ship" }).features
        .devTools,
    ).toBe(false);
  });

  it("is on for the all-on regression profile", () => {
    expect(
      resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "all-on" }).features
        .devTools,
    ).toBe(true);
  });

  it.runIf(!DEV_TOOLS_ENABLED)(
    "ship-profile build defines hide developer Advanced surfaces",
    () => {
      // Runtime mirror of the compile define for this vitest process (ship by default).
      expect(DEV_TOOLS_ENABLED).toBe(false);
    },
  );
});
