import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { LinuxHostCapabilityObservation } from "./linux-host-capabilities";
import {
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
} from "./station-protocol";
import { DisplayTimestamp } from "./work-protocol";

/**
 * Release evidence for one exact Linux package exercised by one Command Center
 * and one Remote on real, disposable Linux VM guests.
 *
 * The receipt summarizes one root evidence log. Detailed observations belong
 * in that log, not in repeated per-phase witness wrappers.
 */
export const STATION_QUALIFICATION_SCHEMA =
  "vellum/station-two-installation-qualification/v3" as const;
export const STATION_QUALIFICATION_RECEIPT_FILE =
  "station-qualification-receipt.json" as const;
export const STATION_QUALIFICATION_MANIFEST_FILE =
  "release-manifest.json" as const;
export const STATION_QUALIFICATION_EVIDENCE_FILE =
  "station-qualification-observations.jsonl" as const;

export const StationQualificationSourceCommit = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{40}$/u),
  Schema.brand("StationQualificationSourceCommit"),
);
export type StationQualificationSourceCommit =
  typeof StationQualificationSourceCommit.Type;

export const StationQualificationSha256 = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/u),
  Schema.brand("StationQualificationSha256"),
);
export type StationQualificationSha256 = typeof StationQualificationSha256.Type;

export const StationQualificationPackageFile = Schema.String.pipe(
  Schema.pattern(/^vellum-runtime-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-linux-x64\.tar\.gz$/u),
  Schema.brand("StationQualificationPackageFile"),
);
export type StationQualificationPackageFile =
  typeof StationQualificationPackageFile.Type;

export const StationQualificationPackageBytes = Schema.Int.pipe(
  Schema.positive(),
  Schema.filter(Number.isSafeInteger, {
    message: () => "package bytes must be a positive safe integer",
  }),
);
export type StationQualificationPackageBytes =
  typeof StationQualificationPackageBytes.Type;

export const StationQualificationEvidenceFile = Schema.Literal(
  STATION_QUALIFICATION_EVIDENCE_FILE,
);
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
  virtualization: Schema.Literal("orbstack", "box"),
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
  Schema.filter(
    ({ commandCenter, remote }) =>
      commandCenter.installationId !== remote.installationId,
    { message: () => "qualification requires distinct installation IDs" },
  ),
  Schema.filter(
    ({ commandCenter, remote }) =>
      commandCenter.appVersion === remote.appVersion,
    {
      message: () =>
        "qualification requires the same app version on both installations",
    },
  ),
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

/**
 * The exact host Doctor observation used to admit the Remote. The full closed
 * observation stays in the signed receipt so a release cannot replace a real
 * capability probe with an ungrounded boolean.
 */
export const StationQualificationRemoteDoctorResult = Schema.Struct({
  observation: LinuxHostCapabilityObservation,
  browserPolicy: Schema.Literal("intentionally-unavailable-linux-beta"),
}).pipe(
  Schema.filter(
    ({ observation }) =>
      observation.status === "ready" &&
      observation.terminal.status === "ready" &&
      observation.browser.status === "unavailable",
    {
      message: () =>
        "qualification requires Doctor core and terminal ready with the beta browser intentionally unavailable",
    },
  ),
);
export type StationQualificationRemoteDoctorResult =
  typeof StationQualificationRemoteDoctorResult.Type;

export const StationQualificationStationVerbResult = Schema.Literal(
  "request-response-observed",
);
export type StationQualificationStationVerbResult =
  typeof StationQualificationStationVerbResult.Type;

/** Every current Station verb must complete over the packaged peer session. */
export const StationQualificationStationVerbs = Schema.Struct({
  pair: StationQualificationStationVerbResult,
  configure: StationQualificationStationVerbResult,
  project: StationQualificationStationVerbResult,
  report: StationQualificationStationVerbResult,
  status: StationQualificationStationVerbResult,
});
export type StationQualificationStationVerbs =
  typeof StationQualificationStationVerbs.Type;

export const StationQualificationPtyResult = Schema.Literal(
  "live-packaged-runtime-observed",
);
export type StationQualificationPtyResult =
  typeof StationQualificationPtyResult.Type;

/** Real PTY behavior through the installed Remote, including bounded closure. */
export const StationQualificationPtyProof = Schema.Struct({
  echo: StationQualificationPtyResult,
  utf8: StationQualificationPtyResult,
  resize: StationQualificationPtyResult,
  exit: StationQualificationPtyResult,
  shutdown: StationQualificationPtyResult,
});
export type StationQualificationPtyProof =
  typeof StationQualificationPtyProof.Type;

const NUMERIC_SEMVER_SOURCE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const SHA256_SOURCE = "[a-f0-9]{64}";
const GENERATION_SOURCE = `${NUMERIC_SEMVER_SOURCE}-${SHA256_SOURCE}`;
const SAFE_ABSOLUTE_PREFIX_SOURCE =
  "/(?:[A-Za-z0-9][A-Za-z0-9._-]*/)+";

export const StationQualificationGeneration = Schema.String.pipe(
  Schema.pattern(new RegExp(`^${GENERATION_SOURCE}$`, "u")),
  Schema.brand("StationQualificationGeneration"),
);
export type StationQualificationGeneration =
  typeof StationQualificationGeneration.Type;

export const StationQualificationInvocationId = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{32}$/u),
  Schema.brand("StationQualificationInvocationId"),
);
export type StationQualificationInvocationId =
  typeof StationQualificationInvocationId.Type;

const StationQualificationRemoteLauncherPath = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${SAFE_ABSOLUTE_PREFIX_SOURCE}\\.vellum/runtime/releases/${GENERATION_SOURCE}/resources/systemd/vellum-remote-launch$`,
      "u",
    ),
  ),
);
const StationQualificationRemoteExecutablePath = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${SAFE_ABSOLUTE_PREFIX_SOURCE}\\.vellum/runtime/releases/${GENERATION_SOURCE}/resources/bin/vellum-remote$`,
      "u",
    ),
  ),
);
const StationQualificationRemoteNodePath = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${SAFE_ABSOLUTE_PREFIX_SOURCE}\\.vellum/runtime/releases/${GENERATION_SOURCE}/resources/bin/node$`,
      "u",
    ),
  ),
);

const QualifiedGenerationState = Schema.Struct({
  generation: StationQualificationGeneration,
  installationId: InstallationId,
  invocationId: StationQualificationInvocationId,
});

export const StationQualificationDeploymentProof = Schema.Struct({
  activation: Schema.Struct({
    generation: StationQualificationGeneration,
    unitExecStart: StationQualificationRemoteLauncherPath,
    conditionExecutable: StationQualificationRemoteExecutablePath,
  }),
  corruptCandidate: Schema.Struct({
    candidateSha256: StationQualificationSha256,
    outcome: Schema.Literal("rejected-before-activation"),
    before: QualifiedGenerationState,
    after: QualifiedGenerationState,
  }),
  restart: Schema.Struct({
    before: QualifiedGenerationState,
    after: QualifiedGenerationState,
  }),
  idempotentRedeploy: Schema.Struct({
    outcome: Schema.Literal("already-active"),
    before: QualifiedGenerationState,
    after: QualifiedGenerationState,
  }),
  hostMutation: Schema.Struct({
    sudoInvocations: Schema.Literal(0),
    privilegedInstallInvocations: Schema.Literal(0),
    systemPathMutations: Schema.Literal(0),
  }),
});
export type StationQualificationDeploymentProof =
  typeof StationQualificationDeploymentProof.Type;

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
  mainExecutable: StationQualificationRemoteNodePath,
  electronProcesses: Schema.Literal(0),
  chromiumRendererProcesses: Schema.Literal(0),
  xvfbProcesses: Schema.Literal(0),
  displayEnvironment: Schema.Literal("unset"),
  controlMaterialOwnerOnly: Schema.Literal(true),
  vellumTcpListeners: Schema.Literal(0),
  cdpListeners: Schema.Literal(0),
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
  doctor: StationQualificationRemoteDoctorResult,
  stationVerbs: StationQualificationStationVerbs,
  pty: StationQualificationPtyProof,
  deployment: StationQualificationDeploymentProof,
  security: QualificationSecurity,
  evidence: EvidenceBinding,
  completedAt: DisplayTimestamp,
}).pipe(
  Schema.filter(
    (receipt) => {
      const packageVersion =
        /^vellum-runtime-([0-9]+\.[0-9]+\.[0-9]+)-linux-x64\.tar\.gz$/u.exec(
          receipt.package.file,
        )?.[1];
      if (packageVersion === undefined) return false;
      const expectedGeneration =
        `${packageVersion}-${receipt.package.sha256}`;
      const remoteInstallationId =
        receipt.installations.remote.installationId;
      if (
        receipt.installations.commandCenter.appVersion !== packageVersion ||
        receipt.installations.remote.appVersion !== packageVersion ||
        receipt.deployment.activation.generation !== expectedGeneration
      ) {
        return false;
      }

      const launcherSuffix =
        `/${expectedGeneration}/resources/systemd/vellum-remote-launch`;
      if (!receipt.deployment.activation.unitExecStart.endsWith(launcherSuffix)) {
        return false;
      }
      const releasesRoot =
        receipt.deployment.activation.unitExecStart.slice(
          0,
          -launcherSuffix.length,
        );
      if (
        receipt.deployment.activation.conditionExecutable !==
          `${releasesRoot}/${expectedGeneration}/resources/bin/vellum-remote` ||
        receipt.security.remote.mainExecutable !==
          `${releasesRoot}/${expectedGeneration}/resources/bin/node`
      ) {
        return false;
      }

      const stateMatchesRelease = (
        state: typeof QualifiedGenerationState.Type,
      ): boolean =>
        state.generation === expectedGeneration &&
        state.installationId === remoteInstallationId;
      const { corruptCandidate, restart, idempotentRedeploy } =
        receipt.deployment;
      return (
        corruptCandidate.candidateSha256 !== receipt.package.sha256 &&
        stateMatchesRelease(corruptCandidate.before) &&
        stateMatchesRelease(corruptCandidate.after) &&
        corruptCandidate.before.invocationId ===
          corruptCandidate.after.invocationId &&
        stateMatchesRelease(restart.before) &&
        stateMatchesRelease(restart.after) &&
        restart.before.invocationId !== restart.after.invocationId &&
        stateMatchesRelease(idempotentRedeploy.before) &&
        stateMatchesRelease(idempotentRedeploy.after) &&
        idempotentRedeploy.before.invocationId ===
          idempotentRedeploy.after.invocationId
      );
    },
    {
      message: () =>
        "qualification proof must bind the exact package generation, Remote identity, and mutation-free deploy observations",
    },
  ),
);
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

export const StationQualification = Schema.Union(
  PendingStationQualification,
  PassedQualification,
);
export type StationQualification = typeof StationQualification.Type;

export const decodeStationQualification = Schema.decodeUnknownEither(
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
