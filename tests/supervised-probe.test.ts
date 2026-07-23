import { describe, expect, it, vi } from "vitest";
import type { StationSupervisor } from "../src/main/vellum/supervision/contract";
import { createSupervisedProbe } from "../src/main/vellum/settings/supervised-probe";

const supervisor = (state: unknown) =>
  ({ observe: vi.fn(async () => state) }) as unknown as StationSupervisor;

describe("supervised station probe", () => {
  it.each([
    ["active", "installed"],
    ["inactive", "absent"],
    ["absent", "absent"],
    ["unsupported", "absent"],
    ["degraded", "unknown"],
    ["unknown", "unknown"],
  ] as const)("maps provider %s truthfully to %s", async (state, expected) => {
    const observation = state === "active"
      ? { provider: "systemd-user", state, ownership: "other" }
      : state === "inactive" || state === "absent"
      ? { provider: "systemd-user", state, ownership: "none" }
      : state === "unsupported"
      ? { provider: "standalone", state, ownership: "none", failure: { kind: "unsupported", diagnostic: "test" } }
      : { provider: "systemd-user", state, ownership: "unknown", failure: { kind: "service-degraded", diagnostic: "test" } };
    await expect(createSupervisedProbe(async () => supervisor(observation))()).resolves.toBe(expected);
  });

  it("fails closed when provider loading fails", async () => {
    await expect(createSupervisedProbe(async () => { throw new Error("no provider"); })()).resolves.toBe("unknown");
  });
});
