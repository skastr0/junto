import { describe, expect, it } from "vitest";
import { productHostCapabilities } from "../src/shared/features";
import {
  defaultFleetEnrollCapabilities,
  fleetEnrollCapabilities,
} from "../src/renderer/components/fleet/FleetHostForm";

describe("FleetHostForm feature policy", () => {
  it("offers and persists only product-visible optional capabilities", () => {
    expect(
      fleetEnrollCapabilities().map((capability) => capability.id),
    ).toEqual(
      productHostCapabilities(["terminal", "browser", "herdr", "hermes"]),
    );
  });

  it("selects only product-visible defaults", () => {
    expect(defaultFleetEnrollCapabilities()).toEqual(
      productHostCapabilities(["terminal", "browser"]),
    );
  });
});
