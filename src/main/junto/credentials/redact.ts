import {
  PROVIDER_SECTION_KEYS,
  PROVIDER_SECRET_FIELDS,
  type ProviderSectionKey,
  type ProvidersSettings,
} from "@shared/settings";
import { historicalProviderSecrets } from "./slots";

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Drop every provider secret field from a preferences JSON document.
 * Non-secret metadata (devin.organizationId) is preserved. Used for
 * durable settings rows and for every newly minted state backup.
 */
export const stripProviderSecretsFromPreferences = (
  preferences: unknown,
): unknown => {
  if (!isPlainObject(preferences)) return preferences;
  const providers = preferences.providers;
  if (providers === undefined) return preferences;
  if (!isPlainObject(providers)) {
    const { providers: _dropped, ...rest } = preferences;
    return rest;
  }
  const nextProviders: Record<string, unknown> = {};
  for (const key of PROVIDER_SECTION_KEYS) {
    const section = providers[key];
    if (!isPlainObject(section)) continue;
    const secretFields = new Set<string>(PROVIDER_SECRET_FIELDS[key]);
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(section)) {
      if (key === "openai" && field === "apiKeyConfigured") continue;
      if (secretFields.has(field)) continue;
      if (value === undefined) continue;
      kept[field] = value;
    }
    if (Object.keys(kept).length > 0) nextProviders[key] = kept;
  }
  return {
    ...preferences,
    providers: {
      ...(Array.isArray(providers.enabledSources)
        ? { enabledSources: providers.enabledSources }
        : {}),
      ...(providers.hermesHostSnapshots === true
        ? { hermesHostSnapshots: true }
        : {}),
      ...nextProviders,
    },
  };
};

export const stripProviderSecretsFromPreferencesBody = (body: string): string => {
  const parsed = JSON.parse(body) as unknown;
  return JSON.stringify(stripProviderSecretsFromPreferences(parsed));
};

export const persistableProviders = (
  providers: ProvidersSettings | undefined,
  options: {
    readonly retainHistorical?: ProvidersSettings;
    readonly migratedSlots?: ReadonlySet<string>;
  } = {},
): ProvidersSettings => {
  const stripped = stripProviderSecretsFromPreferences({
    providers: providers ?? {},
  }) as { readonly providers?: ProvidersSettings };
  const next = stripped.providers ?? {};
  if (options.retainHistorical === undefined) return next;
  return retainUnmigratedProviderSecrets(
    options.retainHistorical,
    next,
    options.migratedSlots ?? new Set(),
  );
};

/**
 * Keep unmigrated historical secret fields on disk until a vault write
 * succeeds. Ordinary preference patches must not drop them.
 */
export const retainUnmigratedProviderSecrets = (
  stored: ProvidersSettings | undefined,
  next: ProvidersSettings,
  migratedSlots: ReadonlySet<string>,
): ProvidersSettings => {
  const leftovers = historicalProviderSecrets(stored);
  if (leftovers.length === 0) return next;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    // Only provider sections merge field-by-field. Non-section keys
    // (enabledSources, hermesHostSnapshots) pass through verbatim: spreading
    // the enabledSources array into a plain object wrote an invalid row that
    // failed closed on the next decode.
    if (!PROVIDER_SECTION_KEYS.includes(key as ProviderSectionKey)) {
      merged[key] = value;
      continue;
    }
    merged[key] = { ...(value as Record<string, string>) };
  }
  for (const leftover of leftovers) {
    if (migratedSlots.has(leftover.slot)) continue;
    const slash = leftover.slot.indexOf("/");
    const provider = leftover.slot.slice(0, slash);
    const field = leftover.slot.slice(slash + 1);
    const section = (merged[provider] as Record<string, string>) ?? {};
    section[field] = leftover.value;
    merged[provider] = section;
  }
  return merged as ProvidersSettings;
};

export const preferencesBodyContainsProviderSecrets = (body: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) return false;
  const providers = parsed.providers;
  for (const key of PROVIDER_SECTION_KEYS) {
    const section = providers[key];
    if (!isPlainObject(section)) continue;
    for (const field of PROVIDER_SECRET_FIELDS[key]) {
      const value = section[field];
      if (typeof value === "string" && value.length > 0) return true;
    }
  }
  return false;
};

/**
 * Remove known secret values from text bound for a log, a trace, an error or
 * a report. Every occurrence of every value is replaced, longest first so a
 * value that contains another is not left half visible. Values shorter than
 * four characters are not searched for: they would match ordinary words, and
 * a caller holding one must not put free text beside it at all.
 */
export const REDACTED = "[redacted]";

export const redactSecretValues = (
  text: string,
  values: Iterable<string | undefined>,
): string => {
  const known = [...new Set([...values].filter((v): v is string => v !== undefined && v.length >= 4))]
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of known) {
    out = out.split(value).join(REDACTED);
    // The same value as a tool may echo it: without a trailing newline.
    const trimmed = value.trim();
    if (trimmed.length >= 4 && trimmed !== value) out = out.split(trimmed).join(REDACTED);
  }
  return out;
};
