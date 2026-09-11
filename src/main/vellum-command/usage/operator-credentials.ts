import { Context, Effect, Layer } from "effect";
import type { ProvidersSettings } from "@shared/settings";
import { SettingsService } from "../settings/service";

// Operator-configured provider credentials for the usage plane.
//
// Values come from SettingsService.resolveProviders, which reads the
// OS-adjacent credential vault. This service lives in main only and never
// crosses IPC. Renderers get the redacted projection from settings IPC.
export class OperatorProviderCredentials extends Context.Service<OperatorProviderCredentials,
  {
    /** Current operator credentials keyed by provider section id. */
    readonly read: () => ProvidersSettings;
  }>()("@vellum-command/UsageOperatorProviderCredentials") {}

export const makeOperatorProviderCredentialsLive = Layer.effect(
  OperatorProviderCredentials,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    return OperatorProviderCredentials.of({
      read: () => Effect.runSync(settings.resolveProviders),
    });
  }),
);
