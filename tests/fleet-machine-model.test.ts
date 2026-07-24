import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  FLEET_MACHINE_MODELS,
  resolveFleetMachineModel,
  resolvePeerMachineModel,
} from "../src/renderer/lib/fleet-machine-model";

const host = (overrides: Partial<RemoteHost> = {}): RemoteHost => ({
  id: "workstation",
  label: "Workstation",
  kind: "remote",
  endpoint: "workstation",
  capabilities: ["terminal"],
  ...overrides,
});

describe("resolvePeerMachineModel", () => {
  it.each([
    ["macos", "macbook-pro"],
    ["ios", "terminal-dock"],
    ["android", "terminal-dock"],
    ["linux", "remote-anchor"],
    ["windows", "compute-tower"],
    [undefined, "relay-obelisk"],
  ] as const)("maps %s peers to %s", (os, expected) => {
    expect(resolvePeerMachineModel({ name: "peer", os })).toBe(expected);
  });
});

describe("resolveFleetMachineModel", () => {
  it("exposes the complete 12-object family plus three Apple editions", () => {
    expect(FLEET_MACHINE_MODELS).toHaveLength(15);
    expect(FLEET_MACHINE_MODELS).toContain("command-core");
    expect(FLEET_MACHINE_MODELS).toContain("mac-mini");
    expect(FLEET_MACHINE_MODELS).toContain("mac-studio");
    expect(FLEET_MACHINE_MODELS).toContain("macbook-pro");
  });

  it("honors an explicit library model", () => {
    expect(
      resolveFleetMachineModel(
        host({ appearance: { glyph: "artifact-vault" }, id: "mac-mini" }),
      ),
    ).toBe("artifact-vault");
  });

  it.each([
    ["mac-mini", "Mac mini", "mac-mini"],
    ["studio", "Build Mac Studio", "mac-studio"],
    ["travel", "MacBook Pro M4", "macbook-pro"],
    ["mbp-remote", "Laptop", "macbook-pro"],
  ] as const)("detects %s / %s as %s", (id, label, expected) => {
    expect(resolveFleetMachineModel(host({ id, label }))).toBe(expected);
  });

  it("lets Apple detection supersede a legacy generic glyph", () => {
    expect(
      resolveFleetMachineModel(
        host({ id: "mac-mini", appearance: { glyph: "server" } }),
      ),
    ).toBe("mac-mini");
  });

  it("keeps legacy glyph customizations meaningful for other hosts", () => {
    expect(
      resolveFleetMachineModel(host({ appearance: { glyph: "satellite" } })),
    ).toBe("relay-obelisk");
  });

  it("falls back to the compute tower", () => {
    expect(resolveFleetMachineModel(host())).toBe("compute-tower");
  });
});
