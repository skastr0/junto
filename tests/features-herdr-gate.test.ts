import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HERDR_ENABLED,
  HERMES_INTEGRATION_ENABLED,
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
    expect(shown.includes("herdr")).toBe(HERDR_ENABLED);
    expect(shown.includes("hermes")).toBe(HERMES_INTEGRATION_ENABLED);
  });

  it("local station capabilities mirror the gate", () => {
    expect(LOCAL_STATION_CAPABILITIES).toContain("herdr");
    expect(LOCAL_STATION_CAPABILITIES).toContain("terminal");
    expect(LOCAL_STATION_CAPABILITIES).toContain("browser");
    expect(LOCAL_STATION_CAPABILITIES).toContain("hermes");
  });

  it.runIf(!HERDR_ENABLED)(
    "does not acquire or start the Remote Herdr plane in ship builds",
    () => {
      const remote = readFileSync("src/main/vellum-remote.ts", "utf8");

      expect(remote).toContain(
        "HERDR_ENABLED\n      ? RemoteRuntime.runPromise(HerdrPlane)\n      : Promise.resolve(undefined)",
      );
      expect(remote).toContain(
        "if (herdr) await RemoteRuntime.runPromise(herdr.start);",
      );
      expect(remote).toContain("handles.herdr?.beginShutdown();");
    },
  );

  it.runIf(HERDR_ENABLED)(
    "retains Remote Herdr startup in the all-on profile",
    () => {
      const remote = readFileSync("src/main/vellum-remote.ts", "utf8");

      expect(remote).toContain("RemoteRuntime.runPromise(HerdrPlane)");
      expect(remote).toContain("RemoteRuntime.runPromise(herdr.start)");
    },
  );
});
