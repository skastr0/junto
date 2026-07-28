import { describe, expect, it } from "vitest";
import {
  decodeUpdateStatus,
  idleUpdateStatus,
} from "../src/shared/update";

describe("shared update schemas", () => {
  it("decodes idle status", () => {
    const status = decodeUpdateStatus(idleUpdateStatus("0.1.0"));
    expect(status.phase).toBe("idle");
    expect(status.canInstall).toBe(false);
    expect(status.currentVersion).toBe("0.1.0");
  });

  it("decodes ready with available release", () => {
    const status = decodeUpdateStatus({
      phase: "ready",
      currentVersion: "0.1.0",
      available: { version: "0.2.0", releaseName: "next" },
      canInstall: false,
      lastCheckedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(status.available?.version).toBe("0.2.0");
  });

  it("rejects unknown phases", () => {
    expect(() =>
      decodeUpdateStatus({
        phase: "shipped",
        currentVersion: "0.1.0",
        canInstall: false,
      }),
    ).toThrow();
  });
});
