import { Context, Effect, Schema, Scope } from "effect";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
  type ReportRequest,
} from "@shared/station-api";
import type { StationControlEnvelope } from "@shared/station-api-envelope";
import type { StationPeerSession } from "./peer-session";

const StationPeerRouteTypeId: unique symbol = Symbol(
  "@vellum/station/StationPeerRoute",
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
    reason: Schema.Literal(
      "unsupported-route",
      "adapter-setup",
      "connect-failed",
    ),
    message: Schema.String,
  },
) {}

/**
 * The sole domain callback exposed to a configured Remote on the CC-opened
 * session. It cannot initiate pair/configure/project/status or arbitrary RPC.
 */
export type StationRemoteReportHandler = (
  request: ReportRequest,
) => Effect.Effect<StationControlEnvelope>;

/**
 * Transport-neutral Command Center peer-session port.
 *
 * `open` is scoped: leaving the scope closes the one connection and fails all
 * in-flight requests. Reconnection is an orchestration concern and always
 * creates a fresh ephemeral session.
 */
export class StationPeerExchange extends Context.Tag(
  "@vellum/StationPeerExchange",
)<
  StationPeerExchange,
  {
    readonly open: (
      route: StationPeerRoute,
      onRemoteReport: StationRemoteReportHandler,
    ) => Effect.Effect<
      StationPeerSession,
      StationPeerExchangeError,
      Scope.Scope
    >;
  }
>() {}
