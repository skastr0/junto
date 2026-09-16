/**
 * Station plane — Context.Service inventory
 * (docs/END_STATE-effect-foundation.md §S4, effect-v4-IRON V4-SERVICE-CORE).
 *
 * Product pin: effect@4.x — live services are `Context.Service` only.
 *
 * - one canonical `Context.Service` per identifier (no dual v1/v2)
 * - no accessor proxies (prefer `yield*` + service methods)
 * - one Live `Layer` per service
 * - string ids centralized here so service keys cannot drift
 *
 * ```ts
 * class X extends Context.Service<X, Shape>()(StationContextTagIds.x) {}
 * ```
 *
 * See `docs/END_STATE-effect-foundation.md` for the migration inventory.
 *
 * | Identifier | Definition | Live layer |
 * |---|---|---|
 * | `@junto/StationRepository` | `repository.ts` | `StationRepositoryLive` / `makeStationRepositoryLive` |
 * | `@junto/StationApiService` | `api.ts` | `StationApiLive` |
 * | `@junto/StationPropagation` | `propagation.ts` | `StationPropagationLive` |
 * | `@junto/StationPeerExchange` | `peer-exchange.ts` | `OpenSshStationPeerExchangeLive` |
 * | `@junto/StationFleetTargetRepository` | `fleet-target-repository.ts` | `StationFleetTargetRepositoryLive` |
 * | `@junto/StationLivePeerRegistry` | `session-registry.ts` | `StationLivePeerRegistryLive` |
 * | `@junto/StationPeerRouteResolver` | `fleet-propagation.ts` | `OpenSshStationPeerRouteResolverLive` |
 * | `@junto/StationFleetPropagation` | `fleet-propagation.ts` | `StationFleetPropagationLive` |
 *
 * Sole product store remains `junto.db` via StateEngine; station services
 * never open a second product DB.
 */

/** Stable Context.Service keys for the station plane — single source of truth. */
export const StationContextTagIds = {
  repository: "@junto/StationRepository",
  api: "@junto/StationApiService",
  propagation: "@junto/StationPropagation",
  peerExchange: "@junto/StationPeerExchange",
  fleetTargetRepository: "@junto/StationFleetTargetRepository",
  livePeerRegistry: "@junto/StationLivePeerRegistry",
  peerRouteResolver: "@junto/StationPeerRouteResolver",
  fleetPropagation: "@junto/StationFleetPropagation",
} as const;

export type StationContextTagId =
  (typeof StationContextTagIds)[keyof typeof StationContextTagIds];
