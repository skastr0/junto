import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StationSupervisor } from "../src/main/junto/supervision/contract";
import { JUNTO_LAUNCHD_LABEL } from "../src/main/junto/settings/launchctl-runner";
import { createSupervisedProbe } from "../src/main/junto/settings/supervised-probe";

const supervisor = (state: unknown) =>
  ({ observe: vi.fn(async () => state) }) as unknown as StationSupervisor;

describe("supervised station probe", () => {
  it("keeps one canonical launchd service label", () => {
    const root = join(import.meta.dirname, "..");
    const runner = readFileSync(
      join(root, "src/main/junto/settings/launchctl-runner.ts"),
      "utf8",
    );
    const probe = readFileSync(
      join(root, "src/main/junto/settings/supervised-probe.ts"),
      "utf8",
    );
    expect(JUNTO_LAUNCHD_LABEL).toBe("skastr0.vellumcommand");
    expect(runner.match(/skastr0\.vellumcommand/gu)).toHaveLength(1);
    expect(probe).not.toContain("JUNTO_LAUNCHD_LABEL");
    expect(probe).not.toContain("skastr0.vellumcommand");
  });

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
