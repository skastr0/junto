import { Effect } from "effect";

// @skastr0/tower-sdk's TowerClient service methods are typed via
// `typeof <core function>` (e.g. `listGlyphs: typeof Glyphs.listGlyphs`),
// which still carries `HttpClient.HttpClient | TowerConfig` in the
// requirement channel at the TYPE level — even though `TowerClientLive`'s
// `bindFn` wrapper (client.ts) already resolves that context at RUNTIME via
// `Effect.provide` before handing the method back. The SDK's declared
// service shape hasn't caught up with what it actually returns; this is a
// type-vs-runtime mismatch in the current @skastr0/tower-sdk build, not a
// vellum design choice, and tower-cli is read-only from here.
//
// `resolved` is the single, localized correction: it restates a call's
// result with the same A/E, requirement channel erased to `never`, matching
// what `bindFn` actually produces at runtime. Every TowerClient method call
// below is wrapped in it.
export const resolved = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
  effect as Effect.Effect<A, E>;
