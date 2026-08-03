import { describe, expect, it } from "vitest";
import {
  HERDR_ENABLED,
  productHostCapabilities,
} from "../src/shared/features";
import { LOCAL_STATION_CAPABILITIES } from "../src/shared/remote-hosts";

describe("HERDR product gate", () => {
  it("exposes a boolean compile/runtime flag", () => {
    expect(typeof HERDR_ENABLED).toBe("boolean");
  });

  it("productHostCapabilities strips herdr when the surface is off", () => {
    const caps = ["terminal", "herdr", "hermes"] as const;
    const shown = productHostCapabilities(caps);
    if (HERDR_ENABLED) {
      expect(shown).toEqual(["terminal", "herdr", "hermes"]);
    } else {
      expect(shown).toEqual(["terminal", "hermes"]);
      expect(shown).not.toContain("herdr");
    }
  });

  it("local station capabilities mirror the gate", () => {
    if (HERDR_ENABLED) {
      expect(LOCAL_STATION_CAPABILITIES).toContain("herdr");
    } else {
      expect(LOCAL_STATION_CAPABILITIES).not.toContain("herdr");
    }
    expect(LOCAL_STATION_CAPABILITIES).toContain("terminal");
    expect(LOCAL_STATION_CAPABILITIES).toContain("browser");
    expect(LOCAL_STATION_CAPABILITIES).toContain("hermes");
  });
});
