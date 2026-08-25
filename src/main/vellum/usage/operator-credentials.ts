import { Context, Effect, Layer, Result } from "effect";
import type { ProvidersSettings } from "@shared/settings";
import { SettingsService } from "../settings/service";

// Operator-configured provider credentials for the usage plane.
//
// The accessor holds a cached copy of settings.providers, refreshed on every
// committed settings mutation (SettingsService.subscribe fires after the row
// is durable) and primed once at layer construction. Usage sources read it at
// fetch time - never a stale import-time snapshot. Values are the RAW stored
// secrets: this service lives in main only and never crosses IPC (renderers
// get the redacted projection from the settings IPC adapter).
export class OperatorProviderCredentials extends Context.Service<OperatorProviderCredentials,
  {
    /** Current operator credentials keyed by provider section id. */
    readonly read: () => ProvidersSettings;
  }>()("@vellum/UsageOperatorProviderCredentials") {}

export const makeOperatorProviderCredentialsLive = Layer.effect(
  OperatorProviderCredentials,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const initial = yield* Effect.result(settings.get);
    let current: ProvidersSettings =
      Result.isSuccess(initial) ? (initial.success.providers ?? {}) : {};
    const unsubscribe = settings.subscribe((next) => {
      current = next.providers ?? {};
    });
    // The subscription intentionally lives for the process lifetime; the
    // layer is constructed once per app runtime and torn down with it.
    return OperatorProviderCredentials.of({ read: () => current });
  }),
);
