import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  STATION_QUALIFICATION_EVIDENCE_FILE,
  STATION_QUALIFICATION_MANIFEST_FILE,
  STATION_QUALIFICATION_SCHEMA,
  StationQualificationPackageFile,
  StationQualificationSha256,
  StationQualificationSourceCommit,
  decodeStationQualification,
  pendingStationQualification,
} from "../src/shared/station-qualification";
import { STATION_PROTOCOL_BASELINE } from "../src/shared/station-protocol";

const hash = (character: string) => character.repeat(64);
const nativePlatform = () => ({
  os: "linux" as const,
  distribution: "ubuntu" as const,
  version: "24.04" as const,
  architecture: "x64" as const,
  virtualization: "orbstack" as const,
});
const commandCenterHealth = () => ({
  appProcess: "running" as const,
  station: "ready" as const,
});
const remoteHealth = () => ({
  package: "installed" as const,
  service: "running" as const,
  station: "ready" as const,
});
const commandCenterSecurity = () => ({
  rendererSandbox: "active" as const,
  rendererNoNewPrivileges: true as const,
  rendererSeccomp: "filtering" as const,
  userNamespaceIsolation: true as const,
  controlMaterialOwnerOnly: true as const,
  vellumTcpListeners: 0 as const,
});
const remoteSecurity = () => ({
  runtime: "displayless-node" as const,
  electronProcesses: 0 as const,
  chromiumRendererProcesses: 0 as const,
  displayEnvironment: "unset" as const,
  controlMaterialOwnerOnly: true as const,
  vellumTcpListeners: 0 as const,
});

const qualified = () => ({
  schema: STATION_QUALIFICATION_SCHEMA,
  ok: true as const,
  sourceCommit: "a".repeat(40),
  manifest: {
    file: STATION_QUALIFICATION_MANIFEST_FILE,
    sha256: hash("1"),
  },
  package: {
    file: "vellum-runtime-0.1.5-linux-x64.tar.gz",
    bytes: 252_000_000,
    sha256: hash("2"),
  },
  stationProtocol: STATION_PROTOCOL_BASELINE,
  installations: {
    commandCenter: {
      installationId: "cc-01",
      appVersion: "0.1.5",
      nativePlatform: nativePlatform(),
    },
    remote: {
      installationId: "remote-01",
      appVersion: "0.1.5",
      nativePlatform: nativePlatform(),
    },
  },
  phases: {
    managedDeploy: "passed" as const,
    initialSync: "passed" as const,
    workRoundTrip: "passed" as const,
    commandCenterOffline: "passed" as const,
    remoteRestart: "passed" as const,
    idempotentRedeploy: "passed" as const,
  },
  health: {
    commandCenter: commandCenterHealth(),
    remote: remoteHealth(),
  },
  security: {
    commandCenter: commandCenterSecurity(),
    remote: remoteSecurity(),
  },
  evidence: {
    file: STATION_QUALIFICATION_EVIDENCE_FILE,
    sha256: hash("3"),
  },
  completedAt: "2026-07-31T12:05:00.000Z",
});

describe("two-installation Station qualification contract", () => {
  it("accepts the strict v2 receipt for the exact exercised release", () => {
    expect(Result.isSuccess(decodeStationQualification(qualified()))).toBe(true);
  });

  it("mints only a non-passing artifact binding before the real run", () => {
    const pending = pendingStationQualification({
      sourceCommit: Schema.decodeUnknownSync(StationQualificationSourceCommit)(
        "a".repeat(40),
      ),
      manifest: {
        file: STATION_QUALIFICATION_MANIFEST_FILE,
        sha256: Schema.decodeUnknownSync(StationQualificationSha256)(hash("1")),
      },
      package: {
        file: Schema.decodeUnknownSync(StationQualificationPackageFile)(
          "vellum-runtime-0.1.5-linux-x64.tar.gz",
        ),
        bytes: 252_000_000,
        sha256: Schema.decodeUnknownSync(StationQualificationSha256)(hash("2")),
      },
    });

    expect(pending).toMatchObject({
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: false,
      status: "pending",
      reason: "operator-run-required",
    });
    expect(Result.isSuccess(decodeStationQualification(pending))).toBe(true);
  });

  it.each([
    "managedDeploy",
    "initialSync",
    "workRoundTrip",
    "commandCenterOffline",
    "remoteRestart",
    "idempotentRedeploy",
  ] as const)("requires the %s phase", (phase) => {
    const receipt = qualified();
    const phases = { ...receipt.phases } as Record<string, unknown>;
    delete phases[phase];
    expect(
      Result.isFailure(decodeStationQualification({ ...receipt, phases })),
    ).toBe(true);
  });

  it("requires exact health and runtime-security results for both installations", () => {
    const unhealthy = qualified();
    (
      unhealthy.health.remote as {
        service: string;
      }
    ).service = "failed";
    expect(Result.isFailure(decodeStationQualification(unhealthy))).toBe(true);

    const commandCenterService = qualified();
    (
      commandCenterService.health.commandCenter as Record<string, unknown>
    ).service = "running";
    expect(
      Result.isFailure(decodeStationQualification(commandCenterService)),
    ).toBe(true);

    const unsandboxed = qualified();
    (
      unsandboxed.security.commandCenter as {
        rendererSandbox: string;
      }
    ).rendererSandbox = "disabled";
    expect(Result.isFailure(decodeStationQualification(unsandboxed))).toBe(true);

    const electronRemote = qualified();
    (
      electronRemote.security.remote as {
        electronProcesses: number;
      }
    ).electronProcesses = 1;
    expect(Result.isFailure(decodeStationQualification(electronRemote))).toBe(
      true,
    );

    const displayRemote = qualified();
    (
      displayRemote.security.remote as {
        displayEnvironment: string;
      }
    ).displayEnvironment = "set";
    expect(Result.isFailure(decodeStationQualification(displayRemote))).toBe(true);

    const exposedControlMaterial = qualified();
    (
      exposedControlMaterial.security.commandCenter as {
        controlMaterialOwnerOnly: boolean;
      }
    ).controlMaterialOwnerOnly = false;
    expect(
      Result.isFailure(decodeStationQualification(exposedControlMaterial)),
    ).toBe(true);

    const listening = qualified();
    (
      listening.security.remote as {
        vellumTcpListeners: number;
      }
    ).vellumTcpListeners = 1;
    expect(Result.isFailure(decodeStationQualification(listening))).toBe(true);
  });

  it("binds the exact positive safe-integer package size", () => {
    for (const bytes of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const receipt = qualified();
      receipt.package.bytes = bytes;
      expect(Result.isFailure(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("requires two distinct installations running the same app version", () => {
    const sameInstallation = qualified();
    sameInstallation.installations.remote.installationId = "cc-01";
    expect(Result.isFailure(decodeStationQualification(sameInstallation))).toBe(
      true,
    );

    const versionSkew = qualified();
    versionSkew.installations.remote.appVersion = "0.1.4";
    expect(Result.isFailure(decodeStationQualification(versionSkew))).toBe(true);
  });

  it("accepts only Ubuntu 24.04 x64 OrbStack guests", () => {
    for (const [field, value] of [
      ["os", "darwin"],
      ["distribution", "debian"],
      ["version", "22.04"],
      ["architecture", "arm64"],
      ["virtualization", "bare-metal"],
    ] as const) {
      const receipt = qualified();
      const platform = receipt.installations.commandCenter.nativePlatform as
        Record<string, string>;
      platform[field] = value;
      expect(Result.isFailure(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("binds one signed manifest, one userland runtime archive, and one root evidence log", () => {
    const wrongManifest = qualified();
    (wrongManifest.manifest as { file: string }).file = "other.json";
    expect(Result.isFailure(decodeStationQualification(wrongManifest))).toBe(true);

    const wrongEvidence = qualified();
    (wrongEvidence.evidence as { file: string }).file = "attestation.txt";
    expect(Result.isFailure(decodeStationQualification(wrongEvidence))).toBe(true);

    for (const file of [
      ".",
      "..",
      "-option.tar.gz",
      "../vellum-runtime-0.1.5-linux-x64.tar.gz",
      "nested/vellum-runtime-0.1.5-linux-x64.tar.gz",
      "vellum",
      "vellum-runtime-0.1.5-linux-x64.tar.gz\0",
    ]) {
      const receipt = qualified();
      receipt.package.file = file;
      expect(Result.isFailure(decodeStationQualification(receipt))).toBe(true);
    }
  });

  it("rejects v1, removed theater fields, and all excess properties", () => {
    expect(
      Result.isFailure(
        decodeStationQualification({
          ...qualified(),
          schema: "vellum-command/station-two-installation-qualification/v1",
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeStationQualification({
          ...qualified(),
          phases: {
            ...qualified().phases,
            syntheticNoOverlap: { outcome: "update-required" },
          },
        }),
      ),
    ).toBe(true);

    expect(
      Result.isFailure(
        decodeStationQualification({ ...qualified(), extra: true }),
      ),
    ).toBe(true);
  });
});
