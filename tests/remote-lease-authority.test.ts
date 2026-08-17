/**
 * FLEET-D2 proofs: Remote lease renewal gates, CC maintenance hold on fleet
 * synchronize, and absence of customer/Dodo secrets on Station / deploy paths.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fleetPropagationHeldByLicense,
  productLicenseAdmission,
} from "../src/main/vellum/license/admission";
import {
  mayRenewRemoteLease,
  REMOTE_LEASE_NON_RENEWAL_OPS,
  REMOTE_LEASE_RENEWAL_OPS,
} from "../src/main/vellum/license/remote-lease-renewal";
import { remoteLeaseState } from "../src/main/vellum/license/remote-lease-state";
import { evaluateRemoteLease } from "../src/main/vellum/license/remote-lease";

const root = join(import.meta.dirname, "..");

afterEach(() => {
  remoteLeaseState.resetForTests();
  productLicenseAdmission.revoke();
});

describe("remote lease renewal inventory", () => {
  it("enumerates exactly the Station ops that may renew on success", () => {
    expect([...REMOTE_LEASE_RENEWAL_OPS]).toEqual([
      "pair",
      "configure",
      "project",
      "status",
    ]);
    expect([...REMOTE_LEASE_NON_RENEWAL_OPS]).toEqual(["report"]);
  });

  it("renews pair/configure/project after success regardless of prior pairing flag", () => {
    for (const op of ["pair", "configure", "project"] as const) {
      expect(mayRenewRemoteLease(op, { paired: false })).toBe(true);
      expect(mayRenewRemoteLease(op, { paired: true })).toBe(true);
    }
  });

  it("renews status only when the Remote is already paired", () => {
    expect(mayRenewRemoteLease("status", { paired: false })).toBe(false);
    expect(mayRenewRemoteLease("status", { paired: true })).toBe(true);
  });

  it("never renews report or unknown ops", () => {
    expect(mayRenewRemoteLease("report", { paired: true })).toBe(false);
    expect(mayRenewRemoteLease("malformed", { paired: true })).toBe(false);
    expect(mayRenewRemoteLease("", { paired: true })).toBe(false);
  });

  it("pins api.ts stamp sites to the inventory (source contract)", () => {
    const api = readFileSync(
      join(root, "src/main/vellum/station/api.ts"),
      "utf8",
    );
    expect(api).toContain('from "../license/remote-lease-renewal"');
    expect(api).toContain("mayRenewRemoteLease");
    expect(api).toContain('stampRemoteLeaseIfEligible("pair")');
    expect(api).toContain('stampRemoteLeaseIfEligible("configure")');
    expect(api).toContain('stampRemoteLeaseIfEligible("status")');
    expect(api).toContain('mayRenewRemoteLease("project"');
    // report must not stamp
    expect(api).not.toMatch(/case "report":[\s\S]{0,400}remoteLeaseState\.stamp/);
  });

  it("does not stamp on failed eligibility (unpaired status)", () => {
    expect(remoteLeaseState.read()).toBeNull();
    // Simulate the gate used by StationApi after a successful unpaired status.
    if (mayRenewRemoteLease("status", { paired: false })) {
      remoteLeaseState.stamp(1_000);
    }
    expect(remoteLeaseState.read()).toBeNull();
    if (mayRenewRemoteLease("status", { paired: true })) {
      remoteLeaseState.stamp(2_000);
    }
    expect(remoteLeaseState.read()).toBe(2_000);
  });
});

describe("CC maintenance holds renewal-producing fleet propagation", () => {
  it("is not held when product is unadmitted (unit / pre-product fixtures)", () => {
    expect(productLicenseAdmission.snapshot()).toEqual({ admitted: false });
    expect(fleetPropagationHeldByLicense()).toBe(false);
  });

  it("is not held in full product mode", () => {
    productLicenseAdmission.admit("license", "full");
    expect(fleetPropagationHeldByLicense()).toBe(false);
  });

  it("holds while admitted in maintenance mode", () => {
    productLicenseAdmission.admit("license", "full");
    productLicenseAdmission.setMode("maintenance");
    expect(fleetPropagationHeldByLicense()).toBe(true);
  });

  it("clears hold when mode returns to full", () => {
    productLicenseAdmission.admit("license", "maintenance");
    expect(fleetPropagationHeldByLicense()).toBe(true);
    productLicenseAdmission.setMode("full");
    expect(fleetPropagationHeldByLicense()).toBe(false);
  });

  it("wires StationPropagation.synchronize to refuse maintenance hold", () => {
    const propagation = readFileSync(
      join(root, "src/main/vellum/station/propagation.ts"),
      "utf8",
    );
    expect(propagation).toContain("fleetPropagationHeldByLicense");
    expect(propagation).toContain("license-maintenance-hold");
    expect(propagation).toContain(
      "Command Center is in license maintenance; fleet propagation is held so Remote leases cannot be renewed",
    );
  });

  it("documents custody entry without permanent fleet beginShutdown", () => {
    const index = readFileSync(join(root, "src/main/index.ts"), "utf8");
    const maintenance = index.slice(
      index.indexOf("const enterLicenseMaintenance ="),
      index.indexOf("const returnFromLicenseMaintenance ="),
    );
    expect(maintenance).toContain("fleetPropagationHeldByLicense");
    expect(maintenance).not.toContain(
      "beginStationFleetPropagationShutdown()",
    );
  });
});

describe("customer secrets never propagate on Station or deploy surfaces", () => {
  const secretTokens = [
    "licenseKey",
    "license_key",
    "activationInstance",
    "activation_instance",
    "activated_license",
    "activatedLicense",
    "dodoResponse",
    "dodo_response",
    "customerKey",
    "customer_key",
  ];

  const stationSurfaces = [
    "src/shared/station-api.ts",
    "src/shared/station-session.ts",
    "src/shared/station-protocol.ts",
    "src/shared/station-api-envelope.ts",
    "src/shared/station-status.ts",
    "src/main/vellum/station/api.ts",
    "src/main/vellum/station/propagation.ts",
    "src/main/vellum/station/peer-session.ts",
    "src/main/vellum/station/openssh-peer-exchange.ts",
    "src/main/vellum/station/fleet-propagation.ts",
  ];

  it("Station wire and peer surfaces omit customer key / activation / Dodo response fields", () => {
    for (const rel of stationSurfaces) {
      const body = readFileSync(join(root, rel), "utf8");
      for (const token of secretTokens) {
        expect(body, `${rel} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it("packaged license profile never embeds a customer key", () => {
    const profile = readFileSync(
      join(root, "scripts/license-build-profile.ts"),
      "utf8",
    );
    expect(profile).toContain("packaged builds must use the pinned Dodo production business ID");
    for (const token of [
      "licenseKey:",
      "customerKey",
      "vellum_live_",
      "activationInstance",
    ]) {
      expect(profile).not.toMatch(new RegExp(`\\b${token}\\b`));
    }
  });

  it("renderer license projection documents secret exclusion", () => {
    const shared = readFileSync(join(root, "src/shared/license.ts"), "utf8");
    expect(shared).toContain(
      "license key, activation-instance identifier, Dodo response bodies",
    );
    expect(shared).toContain("never cross this boundary");
    // LicenseStatus must not carry secrets; activate takes a key as input only.
    const statusBlock = shared.slice(
      shared.indexOf("export interface LicenseStatus"),
      shared.indexOf("export type LicenseActivationErrorCode"),
    );
    expect(statusBlock).not.toContain("licenseKey");
    expect(statusBlock).not.toContain("activationInstance");
    expect(statusBlock).not.toContain("dodo");
  });
});

describe("remote lease decision record and product contract", () => {
  it("ships the FLEET-D2 decision record with accepted model and rejected alternatives", () => {
    const decision = readFileSync(
      join(root, "docs/license-remote-lease-authority.md"),
      "utf8",
    );
    expect(decision).toContain("Accepted model");
    expect(decision).toContain("Rejected alternatives");
    expect(decision).toContain("Renewal-path inventory");
    expect(decision).toContain("Copy Dodo key");
    expect(decision).toContain("Activate every Remote");
    expect(decision).toContain("license-maintenance-hold");
    expect(decision).toContain("not a second Dodo seat");
  });

  it("keeps product contract seats as one CC and lease-shaped Remotes", () => {
    const contract = readFileSync(
      join(root, "docs/license-product-contract.md"),
      "utf8",
    );
    expect(contract).toContain("1 license = 1 Command Center");
    expect(contract).toContain("Command Center check-in lease");
    expect(contract).toContain("3 days");
    expect(contract).toContain("license-remote-lease-authority.md");
  });
});

describe("diagnostics do not imply a second Dodo seat", () => {
  it("Remote custody copy names Command Center lease, not a Remote paid seat", () => {
    const gate = readFileSync(
      join(root, "src/renderer/components/license/LicenseGate.tsx"),
      "utf8",
    );
    expect(gate).toContain("Command Center lease expired");
    expect(gate).toContain("not a separate paid seat");
    expect(gate).not.toContain("Remote license key");

    const section = readFileSync(
      join(root, "src/renderer/components/license/LicenseSection.tsx"),
      "utf8",
    );
    expect(section).toContain("Command Center lease");
    expect(section).toContain("not a second Dodo seat");
    expect(section).not.toContain(">Remote support<");
  });

  it("evaluate + remote-support status remain non-activated", () => {
    const never = evaluateRemoteLease(null, { now: () => 1 });
    expect(never).toMatchObject({ ok: false, reason: "remote-lease-never" });
    const ok = evaluateRemoteLease(Date.now(), { now: () => Date.now() });
    expect(ok).toMatchObject({ ok: true, reason: "remote-lease-ok" });
  });
});
