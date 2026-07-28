import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import {
  STATION_PROTOCOL_BASELINE,
  StationProtocolSupport,
  negotiateStationProtocol,
} from "./station-protocol";
import { DisplayTimestamp, RouteCursor } from "./work-protocol";

/**
 * Operator-run release evidence for one Command Center and one Remote.
 *
 * This is a receipt contract, not a test harness or a host-control surface.
 * A pending receipt is intentionally the only receipt a coordinator can mint
 * before the two real installations have been exercised.
 */
export const STATION_QUALIFICATION_SCHEMA =
  "vellum/station-two-installation-qualification/v2" as const;

export const StationQualificationSourceCommit = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{40}$/),
  Schema.brand("StationQualificationSourceCommit"),
);
export type StationQualificationSourceCommit =
  typeof StationQualificationSourceCommit.Type;

export const StationQualificationSha256 = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("StationQualificationSha256"),
);
export type StationQualificationSha256 = typeof StationQualificationSha256.Type;

const PackageBinding = Schema.Struct({
  file: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  sha256: StationQualificationSha256,
});
export type StationQualificationPackage = typeof PackageBinding.Type;

const Witness = Schema.Struct({
  evidenceSha256: StationQualificationSha256,
  observedAt: DisplayTimestamp,
});
export type StationQualificationWitness = typeof Witness.Type;

const QualifiedInstallations = Schema.Struct({
  commandCenter: Schema.Struct({
    installationId: InstallationId,
    appVersion: Schema.NonEmptyString.pipe(Schema.maxLength(64)),
  }),
  remote: Schema.Struct({
    installationId: InstallationId,
    appVersion: Schema.NonEmptyString.pipe(Schema.maxLength(64)),
  }),
}).pipe(
  Schema.filter(
    ({ commandCenter, remote }) =>
      commandCenter.installationId !== remote.installationId,
    { message: () => "qualification requires distinct installation IDs" },
  ),
);
export type StationQualificationInstallations =
  typeof QualifiedInstallations.Type;

const StationProtocol = Schema.Literal(STATION_PROTOCOL_BASELINE);

const PairWitness = Schema.Struct({ witness: Witness });
const ConfigureWitness = Schema.Struct({ witness: Witness });
const ProjectWitness = Schema.Struct({ witness: Witness });
const StatusWitness = Schema.Struct({ witness: Witness });

const ReportConvergence = Schema.Struct({
  /** Remote-originated facts received and cumulatively acknowledged by CC. */
  commandCenterReceived: RouteCursor,
  remoteAcknowledgedByCommandCenter: RouteCursor,
  /** Command-Center-originated facts received and cumulatively acknowledged by Remote. */
  remoteReceived: RouteCursor,
  commandCenterAcknowledgedByRemote: RouteCursor,
}).pipe(
  Schema.filter(
    (value) =>
      value.commandCenterReceived.eventHome ===
        value.remoteAcknowledgedByCommandCenter.eventHome &&
      value.commandCenterReceived.entityHome ===
        value.remoteAcknowledgedByCommandCenter.entityHome &&
      value.commandCenterReceived.through ===
        value.remoteAcknowledgedByCommandCenter.through &&
      value.remoteReceived.eventHome ===
        value.commandCenterAcknowledgedByRemote.eventHome &&
      value.remoteReceived.entityHome ===
        value.commandCenterAcknowledgedByRemote.entityHome &&
      value.remoteReceived.through ===
        value.commandCenterAcknowledgedByRemote.through,
    { message: () => "report convergence requires matching nonzero cursors" },
  ),
);
export type StationQualificationReportConvergence =
  typeof ReportConvergence.Type;

const ReportWitness = Schema.Struct({
  witness: Witness,
  convergence: ReportConvergence,
});

const OfflineClaimedTaskWitness = Schema.Struct({
  witness: Witness,
  taskId: Schema.NonEmptyString.pipe(Schema.maxLength(256)),
  advancedState: Schema.Literal("completed"),
});

const ProjectResponseRetryWitness = Schema.Struct({
  interruptionWitness: Witness,
  retryWitness: Witness,
  outcome: Schema.Literal("idempotent"),
});

const ReportResponseRetryWitness = Schema.Struct({
  interruptionWitness: Witness,
  retryWitness: Witness,
  convergence: ReportConvergence,
});

export const StationQualificationDoctorStatus = Schema.Literal("ok");
export type StationQualificationDoctorStatus =
  typeof StationQualificationDoctorStatus.Type;

const DoctorWitness = Schema.Struct({
  commandCenter: Schema.Struct({ status: StationQualificationDoctorStatus, witness: Witness }),
  remote: Schema.Struct({ status: StationQualificationDoctorStatus, witness: Witness }),
});

const SyntheticNoOverlapWitness = Schema.Struct({
  synthetic: Schema.Literal(true),
  witness: Witness,
  commandCenterSupport: StationProtocolSupport,
  remoteSupport: StationProtocolSupport,
  outcome: Schema.Literal("update-required"),
}).pipe(
  Schema.filter(
    ({ commandCenterSupport, remoteSupport }) =>
      negotiateStationProtocol(commandCenterSupport, remoteSupport)._tag ===
        "no-common",
    { message: () => "synthetic no-overlap evidence must have no common protocol" },
  ),
);

const PassedQualification = Schema.Struct({
  schema: Schema.Literal(STATION_QUALIFICATION_SCHEMA),
  ok: Schema.Literal(true),
  sourceCommit: StationQualificationSourceCommit,
  package: PackageBinding,
  stationProtocol: StationProtocol,
  installations: QualifiedInstallations,
  phases: Schema.Struct({
    pair: PairWitness,
    configure: ConfigureWitness,
    project: ProjectWitness,
    report: ReportWitness,
    status: StatusWitness,
    commandCenterOfflineClaimedTask: OfflineClaimedTaskWitness,
    projectResponseRetry: ProjectResponseRetryWitness,
    reportResponseRetry: ReportResponseRetryWitness,
    doctor: DoctorWitness,
    syntheticNoOverlap: SyntheticNoOverlapWitness,
  }),
  completedAt: DisplayTimestamp,
});
export type PassedStationQualification = typeof PassedQualification.Type;

/** A coordinator must replace this only with real, operator-run evidence. */
export const PendingStationQualification = Schema.Struct({
  schema: Schema.Literal(STATION_QUALIFICATION_SCHEMA),
  ok: Schema.Literal(false),
  status: Schema.Literal("pending"),
  reason: Schema.Literal("operator-run-required"),
  sourceCommit: StationQualificationSourceCommit,
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
  binding: Omit<PendingStationQualification, "schema" | "ok" | "status" | "reason" | "stationProtocol">,
): PendingStationQualification =>
  PendingStationQualification.make({
    schema: STATION_QUALIFICATION_SCHEMA,
    ok: false,
    status: "pending",
    reason: "operator-run-required",
    stationProtocol: STATION_PROTOCOL_BASELINE,
    ...binding,
  });
