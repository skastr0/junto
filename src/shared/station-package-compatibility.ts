import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import {
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationProtocolSupport,
  StationProtocolVersion,
  StationStateSchemaVersion,
} from "./station-protocol";
import { DisplayTimestamp } from "./work-protocol";
import { remoteStationContractVersion } from "./remote-station-release";

/**
 * Multi-Package Station Compatibility Qualification Matrix Contract.
 *
 * Captures machine-readable qualification proofs for independently built
 * Command Center and Remote packages with explicit recorded source commits,
 * package hashes, app versions, local schema versions, Station support ranges,
 * selected codecs, and platforms.
 */
export const STATION_PACKAGE_COMPATIBILITY_SCHEMA_VERSION =
  remoteStationContractVersion("Station package compatibility matrix", 1);

export const STATION_PACKAGE_COMPATIBILITY_SCHEMA =
  `vellum-command/station-package-compatibility-matrix/v${STATION_PACKAGE_COMPATIBILITY_SCHEMA_VERSION}` as const;

export const StationPackageProofCommit = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  Schema.brand("StationPackageProofCommit"),
);
export type StationPackageProofCommit = typeof StationPackageProofCommit.Type;

export const StationPackageProofSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  Schema.brand("StationPackageProofSha256"),
);
export type StationPackageProofSha256 = typeof StationPackageProofSha256.Type;

export const PackageRole = Schema.Literals(["command-center", "remote"]);
export type PackageRole = typeof PackageRole.Type;

export const PackagePlatform = Schema.Struct({
  os: Schema.Literals(["linux", "darwin"]),
  architecture: Schema.Literals(["x64", "arm64"]),
});
export type PackagePlatform = typeof PackagePlatform.Type;

export const PackageMetadata = Schema.Struct({
  packageHash: StationPackageProofSha256,
  sourceCommit: StationPackageProofCommit,
  appVersion: StationAppVersion,
  localSchemaVersion: StationStateSchemaVersion,
  stationSupport: StationProtocolSupport,
  selectedCodec: StationProtocolVersion,
  platform: PackagePlatform,
});
export type PackageMetadata = typeof PackageMetadata.Type;

export const CompatibilityScenarioName = Schema.Literals([
  "candidate-cc-older-remote",
  "older-cc-candidate-remote",
  "no-common-protocol",
  "below-warning-threshold",
  "upgrade-in-place-restart",
  "offline-work-replay",
  "last-projection-retention",
  "post-update-drain-reconciliation",
]);
export type CompatibilityScenarioName = typeof CompatibilityScenarioName.Type;

export const ScenarioResult = Schema.Struct({
  scenario: CompatibilityScenarioName,
  passed: Schema.Boolean,
  selectedProtocol: Schema.optionalKey(StationProtocolVersion),
  details: Schema.String,
  evidence: Schema.Struct({
    schemaMigrated: Schema.Boolean,
    exactCodecSelected: Schema.Boolean,
    byteCorpusCompatible: Schema.Boolean,
    projectionRetainedOrUpdated: Schema.Boolean,
    immutableWorkReplayed: Schema.Boolean,
    cursorMonotonic: Schema.Boolean,
    reconciledExactlyOnce: Schema.Boolean,
  }),
});
export type ScenarioResult = typeof ScenarioResult.Type;

export const CodecRetirementGate = Schema.Struct({
  codecVersion: StationProtocolVersion,
  enrolledStationsCount: Schema.Number,
  pendingRecordsCount: Schema.Number,
  retirementAdmitted: Schema.Boolean,
  refusalReason: Schema.optionalKey(Schema.String),
});
export type CodecRetirementGate = typeof CodecRetirementGate.Type;

export const StationPackageCompatibilityMatrixReceipt = Schema.Struct({
  schema: Schema.Literal(STATION_PACKAGE_COMPATIBILITY_SCHEMA),
  generatedAt: DisplayTimestamp,
  candidatePackage: PackageMetadata,
  comparatorPackage: PackageMetadata,
  scenarios: Schema.Array(ScenarioResult),
  codecRetirement: CodecRetirementGate,
  allScenariosPassed: Schema.Boolean,
});
export type StationPackageCompatibilityMatrixReceipt =
  typeof StationPackageCompatibilityMatrixReceipt.Type;

export const decodeStationPackageCompatibilityMatrixReceipt =
  Schema.decodeUnknownResult(StationPackageCompatibilityMatrixReceipt, {
    onExcessProperty: "error",
  });

export const encodeStationPackageCompatibilityMatrixReceipt =
  Schema.encodeResult(StationPackageCompatibilityMatrixReceipt);
