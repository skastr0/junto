import {
  MASKED_SECRET,
  PROVIDER_SECTION_KEYS,
  PROVIDER_SECRET_FIELDS,
  type ProvidersSettings,
  type Settings,
} from "@shared/settings";
import { persistableProviders } from "./redact";
import { historicalProviderSecrets } from "./slots";
import type { ProviderCredentialBinding } from "./bindings";

export const projectProvidersForRead = (
  providers: ProvidersSettings | undefined,
  bindings: ReadonlyArray<ProviderCredentialBinding>,
): ProvidersSettings => {
  const persisted = persistableProviders(providers);
  const configured = new Set<string>();
  for (const secret of historicalProviderSecrets(providers)) {
    configured.add(secret.slot);
  }
  for (const binding of bindings) {
    if (binding.lifecycle === "active") configured.add(binding.slot);
  }
  const next: Record<string, unknown> = {
    enabledSources: [...(persisted.enabledSources ?? [])],
    ...(persisted.hermesHostSnapshots === true
      ? { hermesHostSnapshots: true }
      : {}),
  };
  for (const key of PROVIDER_SECTION_KEYS) {
    const section: Record<string, string> = {
      ...((persisted[key] ?? {}) as Record<string, string>),
    };
    for (const field of PROVIDER_SECRET_FIELDS[key]) {
      if (configured.has(`${key}/${field}`)) {
        section[field] = MASKED_SECRET;
      }
    }
    if (Object.keys(section).length > 0) next[key] = section;
  }
  return next as ProvidersSettings;
};

export const projectSettingsForRead = (
  settings: Settings,
  bindings: ReadonlyArray<ProviderCredentialBinding>,
): Settings => ({
  ...settings,
  providers: projectProvidersForRead(settings.providers, bindings),
});
