/**
 * Whose settings a machine-scoped Settings page shows: the machine chosen in
 * its dropdown while that machine is still linked, else this machine.
 */
import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { MachineFacts } from "../src/renderer/lib/machines";
import { settingsMachineIn, settingsMachinesIn } from "../src/renderer/lib/settings-machine";

const row = (id: string, more: Partial<RemoteHost> = {}): RemoteHost => ({
  id,
  label: id,
  isThisMachine: false,
  capabilities: ["terminal"],
  ...more,
});

const machines = [
  row("zeta", { label: "Zeta box" }),
  row("macbook", { label: "Desk", isThisMachine: true }),
  row("mac-mini", { label: "Mini" }),
  row("spare", { label: "Spare" }),
];
const facts: Record<string, MachineFacts> = {
  zeta: { setUp: true, needsUpdate: false },
  "mac-mini": { setUp: true, needsUpdate: false, reachable: false },
  spare: { setUp: false, needsUpdate: false },
};

describe("the machines a Settings page can be about", () => {
  it("are this machine first, then every set-up machine by label", () => {
    expect(settingsMachinesIn(machines, facts, "macbook").map((machine) => machine.id)).toEqual([
      "macbook",
      "mac-mini",
      "zeta",
    ]);
  });

  it("hold this machine before the list is read", () => {
    expect(settingsMachinesIn([], {}, "macbook").map((machine) => machine.id)).toEqual(["macbook"]);
  });
});

describe("the machine a Settings page shows", () => {
  it("is this machine until one is chosen", () => {
    expect(settingsMachineIn(undefined, machines, facts, "macbook")).toEqual({
      name: "macbook",
      label: "Desk",
      isThisMachine: true,
      reachable: true,
    });
  });

  it("is the chosen machine, unreachable included", () => {
    expect(settingsMachineIn("mac-mini", machines, facts, "macbook")).toEqual({
      name: "mac-mini",
      label: "Mini",
      isThisMachine: false,
      reachable: false,
    });
  });

  it("does not claim an answer from a machine never asked", () => {
    expect(settingsMachineIn("zeta", machines, facts, "macbook")).not.toHaveProperty("reachable");
  });

  it("falls back to this machine when the chosen one is not linked", () => {
    expect(settingsMachineIn("spare", machines, facts, "macbook").name).toBe("macbook");
    expect(settingsMachineIn("gone", machines, facts, "macbook").name).toBe("macbook");
  });
});
