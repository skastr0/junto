import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import {
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
} from "./station-protocol";
import { remoteStationContractVersion } from "./remote-station-release";
import { DisplayTimestamp } from "./work-protocol";

/**
 * Release evidence for one exact Linux package exercised by one Command Center
 * and one Remote on real OrbStack guests.
 *
 * The receipt summarizes one root evidence log. Detailed observations belong
 * in that log, not in repeated per-phase witness wrappers.
 */
export const STATION_QUALIFICATION_SCHEMA_VERSION =
  remoteStationContractVersion("Station qualification receipt", 1);
export const STATION_QUALIFICATION_SCHEMA =
  `vellum-command/station-two-installation-qualification/v${STATION_QUALIFICATION_SCHEMA_VERSION}` as const;
export const STATION_QUALIFICATION_RECEIPT_FILE =
  "station-qualification-receipt.json" as const;
export const STATION_QUALIFICATION_MANIFEST_FILE =
  "release-manifest.json" as const;
export const STATION_QUALIFICATION_EVIDENCE_FILE =
  "station-qualification-observations.jsonl" as const;

export const StationQualificationSourceCommit = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  Schema.brand("StationQualificationSourceCommit"),
);
export type StationQualificationSourceCommit =
  typeof StationQualificationSourceCommit.Type;

export const StationQualificationSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  Schema.brand("StationQualificationSha256"),
);
export type StationQualificationSha256 = typeof StationQualificationSha256.Type;

export const StationQualificationPackageFile = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^vellum-runtime-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-linux-x64\.tar\.gz$/u)),
  Schema.brand("StationQualificationPackageFile"),
);
export type StationQualificationPackageFile =
  typeof StationQualificationPackageFile.Type;

export const StationQualificationPackageBytes = Schema.Number.pipe(Schema.check(Schema.isInt()), 
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.makeFilter(Number.isSafeInteger, {
    message: "package bytes must be a positive safe integer",
  })),
);
export type StationQualificationPackageBytes =
  typeof StationQualificationPackageBytes.Type;

export const StationQualificationEvidenceFile = Schema.Literals([STATION_QUALIFICATION_EVIDENCE_FILE, ]);
export type StationQualificationEvidenceFile =
  typeof StationQualificationEvidenceFile.Type;

const SignedManifestBinding = Schema.Struct({
  file: Schema.Literal(STATION_QUALIFICATION_MANIFEST_FILE),
  sha256: StationQualificationSha256,
});
export type StationQualificationSignedManifest =
  typeof SignedManifestBinding.Type;

const PackageBinding = Schema.Struct({
  file: StationQualificationPackageFile,
  bytes: StationQualificationPackageBytes,
  sha256: StationQualificationSha256,
});
export type StationQualificationPackage = typeof PackageBinding.Type;

const EvidenceBinding = Schema.Struct({
  file: StationQualificationEvidenceFile,
  sha256: StationQualificationSha256,
});
export type StationQualificationEvidence = typeof EvidenceBinding.Type;

export const StationQualificationNativePlatform = Schema.Struct({
  os: Schema.Literal("linux"),
  distribution: Schema.Literal("ubuntu"),
  version: Schema.Literal("24.04"),
  architecture: Schema.Literal("x64"),
  virtualization: Schema.Literal("orbstack"),
});
export type StationQualificationNativePlatform =
  typeof StationQualificationNativePlatform.Type;

const QualifiedInstallation = Schema.Struct({
  installationId: InstallationId,
  appVersion: StationAppVersion,
  nativePlatform: StationQualificationNativePlatform,
});

const QualifiedInstallations = Schema.Struct({
  commandCenter: QualifiedInstallation,
  remote: QualifiedInstallation,
}).pipe(
  Schema.check(Schema.makeFilter(({ commandCenter, remote }) =>
    commandCenter.installationId !== remote.installationId,
  { message: "qualification requires distinct installation IDs" },)),
  Schema.check(Schema.makeFilter(({ commandCenter, remote }) =>
    commandCenter.appVersion === remote.appVersion,
  {
    message: "qualification requires the same app version on both installations",
  },)),
);
export type StationQualificationInstallations =
  typeof QualifiedInstallations.Type;

const StationProtocol = Schema.Literal(STATION_PROTOCOL_BASELINE);

export const StationQualificationPhaseResult = Schema.Literal("passed");
export type StationQualificationPhaseResult =
  typeof StationQualificationPhaseResult.Type;

const QualificationPhases = Schema.Struct({
  managedDeploy: StationQualificationPhaseResult,
  initialSync: StationQualificationPhaseResult,
  workRoundTrip: StationQualificationPhaseResult,
  commandCenterOffline: StationQualificationPhaseResult,
  remoteRestart: StationQualificationPhaseResult,
  idempotentRedeploy: StationQualificationPhaseResult,
});
export type StationQualificationPhases = typeof QualificationPhases.Type;

export const StationQualificationCommandCenterHealthResult = Schema.Struct({
  appProcess: Schema.Literal("running"),
  station: Schema.Literal("ready"),
});
export type StationQualificationCommandCenterHealthResult =
  typeof StationQualificationCommandCenterHealthResult.Type;

export const StationQualificationRemoteHealthResult = Schema.Struct({
  package: Schema.Literal("installed"),
  service: Schema.Literal("running"),
  station: Schema.Literal("ready"),
});
export type StationQualificationRemoteHealthResult =
  typeof StationQualificationRemoteHealthResult.Type;

const QualificationHealth = Schema.Struct({
  commandCenter: StationQualificationCommandCenterHealthResult,
  remote: StationQualificationRemoteHealthResult,
});
export type StationQualificationHealth = typeof QualificationHealth.Type;

/** Trusted-renderer Command Center security observations. */
export const StationQualificationCommandCenterSecurityResult = Schema.Struct({
  rendererSandbox: Schema.Literal("active"),
  rendererNoNewPrivileges: Schema.Literal(true),
  rendererSeccomp: Schema.Literal("filtering"),
  userNamespaceIsolation: Schema.Literal(true),
  controlMaterialOwnerOnly: Schema.Literal(true),
  vellumTcpListeners: Schema.Literal(0),
});
export type StationQualificationCommandCenterSecurityResult =
  typeof StationQualificationCommandCenterSecurityResult.Type;

/**
 * Displayless Node Remote security observations.
 * Zero Electron/Chromium/renderer/Xvfb/display env is a hard product contract.
 */
export const StationQualificationRemoteSecurityResult = Schema.Struct({
  runtime: Schema.Literal("displayless-node"),
  electronProcesses: Schema.Literal(0),
  chromiumRendererProcesses: Schema.Literal(0),
  displayEnvironment: Schema.Literal("unset"),
  controlMaterialOwnerOnly: Schema.Literal(true),
  vellumTcpListeners: Schema.Literal(0),
});
export type StationQualificationRemoteSecurityResult =
  typeof StationQualificationRemoteSecurityResult.Type;

const QualificationSecurity = Schema.Struct({
  commandCenter: StationQualificationCommandCenterSecurityResult,
  remote: StationQualificationRemoteSecurityResult,
});
export type StationQualificationSecurity = typeof QualificationSecurity.Type;

const PassedQualification = Schema.Struct({
  schema: Schema.Literal(STATION_QUALIFICATION_SCHEMA),
  ok: Schema.Literal(true),
  sourceCommit: StationQualificationSourceCommit,
  manifest: SignedManifestBinding,
  package: PackageBinding,
  stationProtocol: StationProtocol,
  installations: QualifiedInstallations,
  phases: QualificationPhases,
  health: QualificationHealth,
  security: QualificationSecurity,
  evidence: EvidenceBinding,
  completedAt: DisplayTimestamp,
});
export type PassedStationQualification = typeof PassedQualification.Type;

/** A coordinator may mint only this non-passing binding before the real run. */
export const PendingStationQualification = Schema.Struct({
  schema: Schema.Literal(STATION_QUALIFICATION_SCHEMA),
  ok: Schema.Literal(false),
  status: Schema.Literal("pending"),
  reason: Schema.Literal("operator-run-required"),
  sourceCommit: StationQualificationSourceCommit,
  manifest: SignedManifestBinding,
  package: PackageBinding,
  stationProtocol: StationProtocol,
});
export type PendingStationQualification =
  typeof PendingStationQualification.Type;

export const StationQualification = Schema.Union([PendingStationQualification,
PassedQualification,]);
export type StationQualification = typeof StationQualification.Type;

export const decodeStationQualification = Schema.decodeUnknownResult(
  StationQualification,
  { onExcessProperty: "error" },
);

export const pendingStationQualification = (
  binding: Omit<
    PendingStationQualification,
    "schema" | "ok" | "status" | "reason" | "stationProtocol"
  >,
): PendingStationQualification =>
  PendingStationQualification.make({
    schema: STATION_QUALIFICATION_SCHEMA,
    ok: false,
    status: "pending",
    reason: "operator-run-required",
    stationProtocol: STATION_PROTOCOL_BASELINE,
    ...binding,
  });
