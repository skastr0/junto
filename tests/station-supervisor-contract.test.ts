import { describe, expect, it } from "vitest";
import {
  SUPERVISOR_DIAGNOSTIC_MAX_CHARACTERS,
  stationSupervisorFailure,
} from "../src/main/junto/supervision/contract";
import { createStandaloneStationSupervisor } from "../src/main/junto/supervision/standalone";

describe("standalone station supervisor", () => {
  it("does not claim a handoff on unsupported platforms", async () => {
    const supervisor = createStandaloneStationSupervisor();

    expect(supervisor.metadata).toMatchObject({
      provider: "standalone",
      displayName: "Standalone",
    });
    await expect(supervisor.requestHandoff()).resolves.toEqual({
      provider: "standalone",
      accepted: false,
      failure: {
        kind: "unsupported",
        diagnostic: "Supervised startup isn't available on this platform.",
      },
    });
  });

  it("bounds and sanitizes provider diagnostics", () => {
    const diagnostic = `unsafe\u0000${"x".repeat(
      SUPERVISOR_DIAGNOSTIC_MAX_CHARACTERS + 20,
    )}`;

    const failure = stationSupervisorFailure("process-error", diagnostic);

    expect(failure.diagnostic).toHaveLength(
      SUPERVISOR_DIAGNOSTIC_MAX_CHARACTERS,
    );
    expect(failure.diagnostic).not.toContain("\u0000");
    expect(Object.isFrozen(failure)).toBe(true);
  });
});
