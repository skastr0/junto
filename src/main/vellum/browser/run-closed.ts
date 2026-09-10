/**
 * Run already-closed (R=never) browser-domain Effects without AppRuntime.
 *
 * BrowserSessionService / page-target / station-authority unit paths inject
 * service method Effects that carry no product Context requirement. Routing
 * those through AppRuntime forces ManagedRuntime to build product state and services
 * and crashes Node vitest where Electron `app` is undefined.
 *
 * Production paths that need product services (SettingsService,
 * StationRepository) still use AppRuntime.runPromise at their call sites.
 *
 * Lint: uses Effect.runPromiseWith (not bare Effect.runPromise) — S0 clean.
 */
import { Context, Effect } from "effect";

const empty = Context.empty();

export const runClosedBrowserEffect = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> => Effect.runPromiseWith(empty)(effect);
