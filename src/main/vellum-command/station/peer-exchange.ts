import { Context, Effect, Schema, Scope } from "effect";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
  type ReportRequest,
} from "@shared/station-api";
import type { StationControlEnvelope } from "@shared/station-api-envelope";
import type {
  OverseerCaller,
  OverseerRequest,
  OverseerResult,
} from "@shared/overseer-control";
import {
  StationAppVersion,
  StationProtocolSupport,
  StationStateSchemaVersion,
} from "@shared/station-protocol";
import { StationContextTagIds } from "./context-services";
import type { StationPeerSession } from "./peer-session";

const StationPeerRouteTypeId: unique symbol = Symbol(
  "@junto/station/StationPeerRoute",
);

/**
 * Opaque enrolled-route capability accepted by one peer-exchange adapter.
 *
 * The transport-neutral port exposes only peer installation identity. An
 * adapter retains its endpoint, platform witness, URL, or credential material
 * out of band and rejects a route minted by another adapter.
 */
export interface StationPeerRoute {
  readonly [StationPeerRouteTypeId]: typeof StationPeerRouteTypeId;
  readonly peerInstallationId: InstallationIdValue;
}

const stationPeerRoutes = new WeakSet<StationPeerRoute>();

/** @internal Transport adapters mint routes only after fleet enrollment. */
export const mintStationPeerRoute = (
  peerInstallationId: InstallationIdValue,
): StationPeerRoute => {
  const route = Object.freeze({
    [StationPeerRouteTypeId]: StationPeerRouteTypeId,
    peerInstallationId,
  }) as StationPeerRoute;
  stationPeerRoutes.add(route);
  return route;
};

/** @internal Adapter-side rejection of forged or reconstructed route values. */
export const isStationPeerRoute = (
  route: StationPeerRoute,
): boolean => stationPeerRoutes.has(route);

export class StationPeerExchangeError extends Schema.TaggedError<StationPeerExchangeError>()(
  "StationPeerExchangeError",
  {
    peerInstallationId: InstallationId,
    reason: Schema.Literals(["unsupported-route", "adapter-setup",
    "connect-failed",
    "protocol-incompatible",
    "protocol-negotiation",]),
    message: Schema.String,
    localProtocol: Schema.optional(
      Schema.Struct({
        appVersion: StationAppVersion,
        stateSchemaVersion: StationStateSchemaVersion,
        support: StationProtocolSupport,
      }),
    ),
    peerProtocol: Schema.optional(
      Schema.Struct({
        appVersion: StationAppVersion,
        stateSchemaVersion: StationStateSchemaVersion,
        support: StationProtocolSupport,
      }),
    ),
  },
) {}

/**
 * The sole domain callback exposed to a configured Remote on the CC-opened
 * session. It cannot initiate pair/configure/project/status or arbitrary RPC.
 */
export type StationRemoteReportHandler = (
  request: ReportRequest,
) => Effect.Effect<StationControlEnvelope>;

/** Identity authenticated by the verified live Station session. */
export interface StationAuthenticatedOverseerSource {
  readonly installationId: InstallationIdValue;
  readonly caller: OverseerCaller;
}

/** Main-owned authority validation and execution callback. */
export type StationRemoteOverseerHandler = (
  request: OverseerRequest,
  source: StationAuthenticatedOverseerSource,
) => Effect.Effect<OverseerResult, unknown>;

export interface StationRemoteHandlers {
  readonly report: StationRemoteReportHandler;
  readonly overseer: StationRemoteOverseerHandler;
}

/**
 * Transport-neutral Command Center peer-session port.
 *
 * `open` is scoped: leaving the scope closes the one connection and fails all
 * in-flight requests. Reconnection is an orchestration concern and always
 * creates a fresh ephemeral session.
 */
// Station plane: canonical Context.Service (effect v4).
export class StationPeerExchange extends Context.Service<StationPeerExchange,
  {
    readonly open: (
      route: StationPeerRoute,
      handlers: StationRemoteHandlers,
    ) => Effect.Effect<
      StationPeerSession,
      StationPeerExchangeError,
      Scope.Scope
    >;
  }>()(StationContextTagIds.peerExchange) {}
