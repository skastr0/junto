import { Context, Effect, Layer, Result } from "effect";
import type { ProvidersSettings } from "@shared/settings";
import { SettingsService } from "../settings/service";

// Operator-configured provider access and credentials for the usage plane.
//
// The accessor holds a cached copy of settings.providers, refreshed on every
// committed settings mutation (SettingsService.subscribe fires after the row
// is durable) and primed once at layer construction. Usage sources read it at
// fetch time - never a stale import-time snapshot. Values are the RAW stored
// secrets: this service lives in main only and never crosses IPC (renderers
// get the redacted projection from the settings IPC adapter).
export class UsagePreferences extends Context.Service<UsagePreferences,
  {
    /** Current operator credentials keyed by provider section id. */
    readonly read: () => ProvidersSettings;
    /** Sources explicitly allowed to touch local provider state and the network. */
    readonly enabledSources: () => ReadonlySet<string>;
    readonly subscribeEnabledSources: (
      listener: (enabled: ReadonlySet<string>) => void,
    ) => () => void;
  }>()("@vellum-command/UsagePreferences") {}

export const UsagePreferencesLive = Layer.effect(
  UsagePreferences,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const initial = yield* Effect.result(settings.get);
    let current: ProvidersSettings =
      Result.isSuccess(initial) ? (initial.success.providers ?? { enabledSources: [] }) : {
        enabledSources: [],
      };
    const enabledListeners = new Set<
      (enabled: ReadonlySet<string>) => void
    >();
    const enabledSources = (): ReadonlySet<string> =>
      new Set(current.enabledSources ?? []);
    const unsubscribe = settings.subscribe((next) => {
      const before = (current.enabledSources ?? []).join("\0");
      current = next.providers ?? {};
      if ((current.enabledSources ?? []).join("\0") !== before) {
        const enabled = enabledSources();
        for (const listener of enabledListeners) listener(enabled);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return UsagePreferences.of({
      read: () => current,
      enabledSources,
      subscribeEnabledSources: (listener) => {
        enabledListeners.add(listener);
        return () => enabledListeners.delete(listener);
      },
    });
  }),
);
