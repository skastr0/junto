import { Effect, Either } from "effect";
import {
  stationControlErr,
  stationControlOk,
  type StationControlEnvelope,
  type StationControlErrorCode,
} from "@shared/station-api-envelope";
import type {
  StationApiRequest,
  StationApiResponse,
  StationReadiness,
} from "@shared/station-api";
import {
  StationApiService,
  type StationApiError,
  type StationApiPeerContext,
} from "./api";
import type { StationControlLocalHandoff } from "./peer-authority";
import {
  isStationPeerRoute,
  type StationPeerRoute,
} from "./peer-exchange";

/**
 * Transport admission token. Opaque and non-serializable — minted only after
 * an adapter-owned boundary admits its local handoff. OpenSSH authenticates at
 * the SSH daemon; the Remote-side token proves only that the request crossed
 * the owner-local Station socket.
 *
 * Branded and peer-bound via a module-private WeakMap so the token cannot be
 * forged as JSON or reconstructed across process boundaries.
 */
const admittedTransports = new WeakMap<object, StationApiPeerContext>();

export type StationTransportAdmission = {
  readonly _tag: "StationTransportAdmission";
};

/**
 * Mint an admission for the exact owner-local Station handoff accepted by the
 * Remote control server. This does not project SSH peer identity into main.
 */
export const admitOwnerLocalStationHandoff = (
  _handoff: StationControlLocalHandoff,
): StationTransportAdmission => {
  const admission: StationTransportAdmission = Object.freeze({
    _tag: "StationTransportAdmission" as const,
  });
  admittedTransports.set(admission, {
    _tag: "command-center-route",
  });
  return admission;
};

/**
 * Admit the Remote identity already bound into an enrolled, opaque
 * Command Center peer route. This is the CC-side counterpart to the Remote
 * helper admission above; callers cannot reconstruct a route from JSON.
 */
export const admitEnrolledStationPeer = (
  route: StationPeerRoute,
): StationTransportAdmission => {
  if (!isStationPeerRoute(route)) {
    throw new Error("cannot admit a forged Station peer route");
  }
  const admission: StationTransportAdmission = Object.freeze({
    _tag: "StationTransportAdmission" as const,
  });
  admittedTransports.set(admission, {
    _tag: "enrolled-remote",
    installationId: route.peerInstallationId,
  });
  return admission;
};

export type RunStationApi = <A, E>(
  effect: Effect.Effect<A, E, StationApiService>,
) => Promise<A>;

const errorTag = (error: unknown): string | undefined =>
  typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : undefined;

/**
 * Map domain / runtime failures onto the transport-neutral API envelope.
 * Sole place that translates `StationApiError` tags into control codes.
 */
export const stationControlErrorEnvelope = (
  error: StationApiError | unknown,
): StationControlEnvelope => {
  const tag = errorTag(error);
  let code: StationControlErrorCode;
  let message: string;
  let retryable = false;

  switch (tag) {
    case "StationPersistenceError":
    case "WorkRepositoryError":
    case "StationFleetTargetPersistenceError":
    case "StationApiDependencyError":
    case "CanvasError":
      code = "unavailable";
      message = "station state is temporarily unavailable";
      retryable = true;
      break;
    case "StationProjectionIntegrityError":
      code = "integrity_error";
      message = "station payload failed its integrity check";
      break;
    case "StationPairingConflictError":
    case "StationCursorError":
    case "WorkReplicationError":
      code = "state_conflict";
      message = "station state conflicts with the request";
      break;
    case "StationIdentityMismatchError":
    case "StationSelfPairingError":
    case "StationPairingTopologyError":
    case "StationConfigurationError":
    case "StationMetadataError":
    case "StationApiInvariantError":
    case "StationPortfolioError":
    case "StationFleetTargetConflictError":
    case "StationFleetTargetHostBindingImmutableError":
    case "StationFleetTargetMetadataError":
    case "StationFleetTargetCorruptRecordError":
      code = "request_rejected";
      message = "station request was rejected";
      break;
    default:
      code = "internal_error";
      message = "station request failed";
  }
  return stationControlErr(code, message, retryable);
};

/**
 * Sole path from any admitted transport into `StationApiService.handle`.
 * Transports own framing, local admission, and readiness probes;
 * this module owns decode-free request execution and envelope mapping.
 */
export const dispatchStationApiRequest = (
  admission: StationTransportAdmission,
  request: StationApiRequest,
  readiness: StationReadiness,
  run: RunStationApi,
): Promise<StationControlEnvelope> => {
  // WeakMap membership is the non-serializable proof of mint. A reconstituted
  // `{ _tag: "StationTransportAdmission" }` object is denied.
  const peer = admittedTransports.get(admission);
  if (peer === undefined) {
    return Promise.resolve(
      stationControlErr(
        "authorization_denied",
        "station control requires an admitted transport peer",
        false,
      ),
    );
  }

  return run(
    Effect.flatMap(StationApiService, (service) =>
      service.handle(request, readiness, peer).pipe(Effect.either)
    ),
  ).then(
    (outcome: Either.Either<StationApiResponse, unknown>) =>
      Either.isLeft(outcome)
        ? stationControlErrorEnvelope(outcome.left)
        : stationControlOk(outcome.right),
    (error: unknown) => stationControlErrorEnvelope(error),
  );
};
