/**
 * S4-station — Context.Tag inventory for the station plane
 * (docs/END_STATE-effect-foundation.md §S4).
 *
 * Product pin: effect@3.21.x — `Context.Service` is not available yet.
 * Do **not** half-migrate to a fake Service shim. This pack is already
 * V4-ready in structure:
 *
 * - one canonical class `Context.Tag` per identifier (no dual v1/v2)
 * - no `Effect.Tag` / accessor proxies (prefer `yield*` + service methods)
 * - one Live `Layer` per Tag
 * - string ids centralized here so Tag keys cannot drift
 *
 * V4 rename (when `@effect/*` pins allow `Context.Service`):
 *
 * ```ts
 * // v3 (today)
 * class X extends Context.Service<X, Shape>()(StationContextTagIds.x) {}
 * // v4
 * class X extends Context.Service<X, Shape>()(StationContextTagIds.x) {}
 * ```
 *
 * See `/Users/developer/Playground/effect/migration/services.md`.
 *
 * | Identifier | Definition | Live layer |
 * |---|---|---|
 * | `@vellum/StationRepository` | `repository.ts` | `StationRepositoryLive` / `makeStationRepositoryLive` |
 * | `@vellum/StationApiService` | `api.ts` | `StationApiLive` |
 * | `@vellum/StationPropagation` | `propagation.ts` | `StationPropagationLive` |
 * | `@vellum/StationPeerExchange` | `peer-exchange.ts` | `OpenSshStationPeerExchangeLive` |
 * | `@vellum/StationFleetTargetRepository` | `fleet-target-repository.ts` | `StationFleetTargetRepositoryLive` |
 * | `@vellum/StationLivePeerRegistry` | `session-registry.ts` | `StationLivePeerRegistryLive` |
 * | `@vellum/StationPeerRouteResolver` | `fleet-propagation.ts` | `OpenSshStationPeerRouteResolverLive` |
 * | `@vellum/StationFleetPropagation` | `fleet-propagation.ts` | `StationFleetPropagationLive` |
 *
 * Sole product store remains `vellum.db` via StateEngine; station services
 * never open a second product DB.
 */

/** Stable Context.Tag keys for the station plane — single source of truth. */
export const StationContextTagIds = {
  repository: "@vellum/StationRepository",
  api: "@vellum/StationApiService",
  propagation: "@vellum/StationPropagation",
  peerExchange: "@vellum/StationPeerExchange",
  fleetTargetRepository: "@vellum/StationFleetTargetRepository",
  livePeerRegistry: "@vellum/StationLivePeerRegistry",
  peerRouteResolver: "@vellum/StationPeerRouteResolver",
  fleetPropagation: "@vellum/StationFleetPropagation",
} as const;

export type StationContextTagId =
  (typeof StationContextTagIds)[keyof typeof StationContextTagIds];
