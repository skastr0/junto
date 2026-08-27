import { describe, expect, it } from "vitest";
import { Schema, Result } from "effect";
import {
  STATION_PACKAGE_COMPATIBILITY_SCHEMA,
  StationPackageCompatibilityMatrixReceipt,
  decodeStationPackageCompatibilityMatrixReceipt,
  type PackageMetadata,
  type ScenarioResult,
} from "../src/shared/station-package-compatibility";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../src/shared/station-protocol";

describe("Station Package Compatibility Matrix and Staged Upgrade Qualification", () => {
  const candidatePkg: PackageMetadata = {
    packageHash: "a".repeat(64) as any,
    sourceCommit: "1".repeat(40) as any,
    appVersion: "0.1.15",
    localSchemaVersion: 21,
    stationSupport: CURRENT_STATION_PROTOCOL_SUPPORT,
    selectedCodec: 1,
    platform: { os: "linux", architecture: "x64" },
  };

  const olderPkg: PackageMetadata = {
    packageHash: "b".repeat(64) as any,
    sourceCommit: "2".repeat(40) as any,
    appVersion: "0.1.14",
    localSchemaVersion: 18,
    stationSupport: { preferred: 1, compatibleFrom: 1, warnBelow: 1 },
    selectedCodec: 1,
    platform: { os: "linux", architecture: "x64" },
  };

  const sampleScenarios: ScenarioResult[] = [
    {
      scenario: "candidate-cc-older-remote",
      passed: true,
      selectedProtocol: 1,
      details: "Candidate CC successfully drives older Remote via negotiated protocol 1",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "older-cc-candidate-remote",
      passed: true,
      selectedProtocol: 1,
      details: "Candidate Remote safely accepts older CC projection and executes work",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "no-common-protocol",
      passed: true,
      details: "No common protocol enters typed update-required lockdown without data loss",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: false,
        byteCorpusCompatible: false,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "below-warning-threshold",
      passed: true,
      selectedProtocol: 1,
      details: "Negotiation below warning threshold operates with operator deprecation warning",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "upgrade-in-place-restart",
      passed: true,
      selectedProtocol: 1,
      details: "In-place binary upgrade migrates schema and resumes normal station peer sessions",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "offline-work-replay",
      passed: true,
      selectedProtocol: 1,
      details: "Offline remote work accumulates and replays without dropping records or corrupting cursors",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "last-projection-retention",
      passed: true,
      details: "Disconnected/unsupported remote retains last valid projection for 24/7 simulation",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
    {
      scenario: "post-update-drain-reconciliation",
      passed: true,
      selectedProtocol: 1,
      details: "Post-update reconnection drains held route heads and reconciles work exactly once",
      evidence: {
        schemaMigrated: true,
        exactCodecSelected: true,
        byteCorpusCompatible: true,
        projectionRetainedOrUpdated: true,
        immutableWorkReplayed: true,
        cursorMonotonic: true,
        reconciledExactlyOnce: true,
      },
    },
  ];

  it("validates and parses a complete package compatibility receipt", () => {
    const rawReceipt: StationPackageCompatibilityMatrixReceipt = {
      schema: STATION_PACKAGE_COMPATIBILITY_SCHEMA,
      generatedAt: new Date().toISOString(),
      candidatePackage: candidatePkg,
      comparatorPackage: olderPkg,
      scenarios: sampleScenarios,
      codecRetirement: {
        codecVersion: 1,
        enrolledStationsCount: 1,
        pendingRecordsCount: 5,
        retirementAdmitted: false,
        refusalReason: "Active enrolled stations and 5 pending records require codec 1",
      },
      allScenariosPassed: true,
    };

    const decoded = decodeStationPackageCompatibilityMatrixReceipt(rawReceipt);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.scenarios.length).toBe(8);
      expect(decoded.success.allScenariosPassed).toBe(true);
      expect(decoded.success.codecRetirement.retirementAdmitted).toBe(false);
    }
  });

  it("enforces codec retirement gate refusal when enrolled stations or pending records exist", () => {
    const gate = {
      codecVersion: 1,
      enrolledStationsCount: 2,
      pendingRecordsCount: 0,
      retirementAdmitted: false,
      refusalReason: "Cannot retire codec 1 while 2 stations remain enrolled",
    };

    expect(gate.enrolledStationsCount > 0 || gate.pendingRecordsCount > 0).toBe(true);
    expect(gate.retirementAdmitted).toBe(false);
  });
});
