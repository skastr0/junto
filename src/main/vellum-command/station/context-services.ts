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
 * | `@vellum/StationRepository` | `repository.ts` | `StationRepositoryLive` / `makeStationRepositoryLive` |
 * | `@vellum/StationApiService` | `api.ts` | `StationApiLive` |
 * | `@vellum/StationPropagation` | `propagation.ts` | `StationPropagationLive` |
 * | `@vellum/StationPeerExchange` | `peer-exchange.ts` | `OpenSshStationPeerExchangeLive` |
 * | `@vellum/StationFleetTargetRepository` | `fleet-target-repository.ts` | `StationFleetTargetRepositoryLive` |
 * | `@vellum/StationLivePeerRegistry` | `session-registry.ts` | `StationLivePeerRegistryLive` |
 * | `@vellum/StationPeerRouteResolver` | `fleet-propagation.ts` | `OpenSshStationPeerRouteResolverLive` |
 * | `@vellum/StationFleetPropagation` | `fleet-propagation.ts` | `StationFleetPropagationLive` |
 *
 * Sole product store remains `vellum-command.db` via StateEngine; station services
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
