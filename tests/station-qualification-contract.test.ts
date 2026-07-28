import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  STATION_QUALIFICATION_SCHEMA,
  StationQualificationPackageFile,
  StationQualificationSha256,
  StationQualificationSourceCommit,
  decodeStationQualification,
  pendingStationQualification,
} from "../src/shared/station-qualification";

const hash = (character: string) => character.repeat(64);
const witness = (character: string) => ({
  evidenceSha256: hash(character),
  observedAt: "2026-07-28T12:00:00.000Z",
});
const cursor = (eventHome: string, entityHome: string, through = "1") => ({
  eventHome,
  entityHome,
  through,
});
const nativePlatform = () => ({
  os: "linux",
  distribution: "ubuntu",
  version: "24.04",
  architecture: "x64",
});

const qualified = () => ({
  schema: STATION_QUALIFICATION_SCHEMA,
  ok: true as const,
  sourceCommit: "a".repeat(40),
  package: { file: "vellum.deb", sha256: hash("b") },
  stationProtocol: 2,
  installations: {
    commandCenter: {
      installationId: "cc-01",
      appVersion: "0.1.0",
      nativePlatform: nativePlatform(),
    },
    remote: {
      installationId: "remote-01",
      appVersion: "0.1.0",
      nativePlatform: nativePlatform(),
    },
  },
  phases: {
    pair: { witness: witness("c") },
    configure: { witness: witness("d") },
    project: { witness: witness("e") },
    report: {
      witness: witness("f"),
      convergence: {
        commandCenterReceived: cursor("remote-01", "remote-01"),
        remoteAcknowledgedByCommandCenter: cursor("remote-01", "remote-01"),
        remoteReceived: cursor("cc-01", "cc-01"),
        commandCenterAcknowledgedByRemote: cursor("cc-01", "cc-01"),
      },
    },
    status: { witness: witness("1") },
    commandCenterOfflineClaimedTask: {
      witness: witness("2"),
      taskId: "task-01",
      advancedState: "completed" as const,
    },
    projectResponseRetry: {
      interruptionWitness: witness("3"),
      retryWitness: witness("4"),
      outcome: "idempotent" as const,
    },
    reportResponseRetry: {
      interruptionWitness: witness("5"),
      retryWitness: witness("6"),
      convergence: {
        commandCenterReceived: cursor("remote-01", "remote-01", "2"),
        remoteAcknowledgedByCommandCenter: cursor("remote-01", "remote-01", "2"),
        remoteReceived: cursor("cc-01", "cc-01", "2"),
        commandCenterAcknowledgedByRemote: cursor("cc-01", "cc-01", "2"),
      },
    },
    doctor: {
      commandCenter: { status: "ok" as const, witness: witness("7") },
      remote: { status: "ok" as const, witness: witness("8") },
    },
    syntheticNoOverlap: {
      synthetic: true as const,
      witness: witness("9"),
      commandCenterSupport: { preferred: 4, compatibleFrom: 3, warnBelow: 3 },
      remoteSupport: { preferred: 2, compatibleFrom: 1, warnBelow: 1 },
      outcome: "update-required" as const,
    },
  },
  completedAt: "2026-07-28T12:05:00.000Z",
});

describe("two-installation Station qualification contract", () => {
  it("accepts a complete real-operator receipt", () => {
    expect(Either.isRight(decodeStationQualification(qualified()))).toBe(true);
  });

  it("can only mint pending evidence before a coordinator completes the run", () => {
    const pending = pendingStationQualification({
      sourceCommit: Schema.decodeUnknownSync(StationQualificationSourceCommit)("a".repeat(40)),
      package: {
        file: Schema.decodeUnknownSync(StationQualificationPackageFile)(
          "vellum.deb",
        ),
        sha256: Schema.decodeUnknownSync(StationQualificationSha256)(hash("b")),
      },
    });
    expect(pending).toMatchObject({ ok: false, status: "pending" });
    expect(Either.isRight(decodeStationQualification(pending))).toBe(true);
  });

  it("cannot represent ok evidence without every required phase", () => {
    const receipt = qualified();
    const { report: _report, ...phases } = receipt.phases;
    expect(Either.isLeft(decodeStationQualification({ ...receipt, phases }))).toBe(true);
  });

  it("rejects zero, divergent, and missing report convergence witnesses", () => {
    const zero = qualified();
    zero.phases.report.convergence.commandCenterReceived.through = "0";
    expect(Either.isLeft(decodeStationQualification(zero))).toBe(true);

    const divergent = qualified();
    divergent.phases.reportResponseRetry.convergence.remoteReceived.through = "3";
    expect(Either.isLeft(decodeStationQualification(divergent))).toBe(true);
  });

  it("binds every converged cursor to the outer qualified installations", () => {
    const unrelatedReport = qualified();
    unrelatedReport.phases.report.convergence = {
      commandCenterReceived: cursor("unrelated-remote", "unrelated-remote"),
      remoteAcknowledgedByCommandCenter:
        cursor("unrelated-remote", "unrelated-remote"),
      remoteReceived: cursor("unrelated-cc", "unrelated-cc"),
      commandCenterAcknowledgedByRemote:
        cursor("unrelated-cc", "unrelated-cc"),
    };
    expect(Either.isLeft(decodeStationQualification(unrelatedReport))).toBe(true);

    const unrelatedRetry = qualified();
    unrelatedRetry.phases.reportResponseRetry.convergence = {
      commandCenterReceived:
        cursor("unrelated-remote", "unrelated-remote", "2"),
      remoteAcknowledgedByCommandCenter:
        cursor("unrelated-remote", "unrelated-remote", "2"),
      remoteReceived: cursor("unrelated-cc", "unrelated-cc", "2"),
      commandCenterAcknowledgedByRemote:
        cursor("unrelated-cc", "unrelated-cc", "2"),
    };
    expect(Either.isLeft(decodeStationQualification(unrelatedRetry))).toBe(true);
  });

  it("permits either exact installation as entity home", () => {
    const crossHome = qualified();
    crossHome.phases.report.convergence = {
      commandCenterReceived: cursor("remote-01", "cc-01"),
      remoteAcknowledgedByCommandCenter: cursor("remote-01", "cc-01"),
      remoteReceived: cursor("cc-01", "remote-01"),
      commandCenterAcknowledgedByRemote: cursor("cc-01", "remote-01"),
    };
    expect(Either.isRight(decodeStationQualification(crossHome))).toBe(true);
  });

  it("requires distinct installations, protocol v2, and a labelled synthetic no-overlap", () => {
    const sameInstallation = qualified();
    sameInstallation.installations.remote.installationId = "cc-01";
    expect(Either.isLeft(decodeStationQualification(sameInstallation))).toBe(true);

    const wrongProtocol = qualified();
    wrongProtocol.stationProtocol = 3;
    expect(Either.isLeft(decodeStationQualification(wrongProtocol))).toBe(true);

    const overlap = qualified();
    overlap.phases.syntheticNoOverlap.remoteSupport = {
      preferred: 3,
      compatibleFrom: 2,
      warnBelow: 2,
    };
    expect(Either.isLeft(decodeStationQualification(overlap))).toBe(true);

    const invalidPlatformFact = qualified();
    invalidPlatformFact.installations.commandCenter.nativePlatform.os =
      "linux/other";
    expect(Either.isLeft(decodeStationQualification(invalidPlatformFact)))
      .toBe(true);
  });

  it("strictly rejects receipt excess", () => {
    expect(Either.isLeft(decodeStationQualification({ ...qualified(), extra: true }))).toBe(true);
  });

  it("has one first-shipped v1 discriminator and safe package basenames", () => {
    expect(STATION_QUALIFICATION_SCHEMA).toBe(
      "vellum/station-two-installation-qualification/v1",
    );
    expect(Either.isLeft(decodeStationQualification({
      ...qualified(),
      schema: "vellum/station-two-installation-qualification/v2",
    }))).toBe(true);
    const { phases: _phases, ...legacyHeader } = qualified();
    expect(Either.isLeft(decodeStationQualification({
      ...legacyHeader,
      checks: [{ name: "pair", status: "passed" }],
    }))).toBe(true);

    for (
      const file of [
        ".",
        "..",
        "../vellum.deb",
        "nested/vellum.deb",
        "bad\0.deb",
      ]
    ) {
      const receipt = qualified();
      receipt.package.file = file;
      expect(Either.isLeft(decodeStationQualification(receipt))).toBe(true);
    }
  });
});
