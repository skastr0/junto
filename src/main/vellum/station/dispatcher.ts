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
} from "./api";
import type { StationControlPeerAdmission } from "./peer-authority";

/**
 * Transport admission token. Opaque and non-serializable — minted only by a
 * transport adapter after it has proven the peer. OpenSSH unix-peer capture is
 * the sole producer today; HTTPS is intentionally out of scope.
 *
 * Branded via a module-private WeakSet so the token cannot be forged as JSON
 * or reconstructed across process boundaries.
 */
const admittedTransports = new WeakSet<object>();

export type StationTransportAdmission = {
  readonly _tag: "StationTransportAdmission";
};

/**
 * Mint an admission from an OpenSSH process-chain capture. The peer snapshot
 * is not retained on the token — revalidation stays on the transport server.
 */
export const admitOpenSshPeer = (
  _peer: StationControlPeerAdmission,
): StationTransportAdmission => {
  const admission: StationTransportAdmission = Object.freeze({
    _tag: "StationTransportAdmission" as const,
  });
  admittedTransports.add(admission);
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
 * Transports own framing, peer capture/revalidation, and readiness probes;
 * this module owns decode-free request execution and envelope mapping.
 */
export const dispatchStationApiRequest = (
  admission: StationTransportAdmission,
  request: StationApiRequest,
  readiness: StationReadiness,
  run: RunStationApi,
): Promise<StationControlEnvelope> => {
  // WeakSet membership is the non-serializable proof of mint. A reconstituted
  // `{ _tag: "StationTransportAdmission" }` object is denied.
  if (!admittedTransports.has(admission)) {
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
      service.handle(request, readiness).pipe(Effect.either)
    ),
  ).then(
    (outcome: Either.Either<StationApiResponse, unknown>) =>
      Either.isLeft(outcome)
        ? stationControlErrorEnvelope(outcome.left)
        : stationControlOk(outcome.right),
    (error: unknown) => stationControlErrorEnvelope(error),
  );
};
