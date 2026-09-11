import {
  MASKED_SECRET,
  PROVIDER_SECTION_KEYS,
  PROVIDER_SECRET_FIELDS,
  type ProviderSectionKey,
  type ProvidersSettings,
} from "@shared/settings";
import { PROVIDER_CREDENTIAL_SLOT_VALUES } from "./state-schema";

export type ProviderCredentialSlot =
  (typeof PROVIDER_CREDENTIAL_SLOT_VALUES)[number];

export type ProviderCredentialFieldOp =
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "clear" };

const SLOT_SET = new Set<string>(PROVIDER_CREDENTIAL_SLOT_VALUES);

export const isProviderCredentialSlot = (
  value: string,
): value is ProviderCredentialSlot => SLOT_SET.has(value);

export const providerCredentialSlot = (
  provider: ProviderSectionKey,
  field: string,
): ProviderCredentialSlot | undefined => {
  const slot = `${provider}/${field}`;
  return isProviderCredentialSlot(slot) ? slot : undefined;
};

export const parseProviderCredentialSlot = (
  slot: ProviderCredentialSlot,
): { readonly provider: ProviderSectionKey; readonly field: string } => {
  const slash = slot.indexOf("/");
  return {
    provider: slot.slice(0, slash) as ProviderSectionKey,
    field: slot.slice(slash + 1),
  };
};

/** Secret-field operations encoded in a providers patch. Mask echoes are omitted. */
export const providerSecretOpsFromPatch = (
  patch: ProvidersSettings,
): ReadonlyArray<{
  readonly slot: ProviderCredentialSlot;
  readonly op: ProviderCredentialFieldOp;
}> => {
  const ops: Array<{
    readonly slot: ProviderCredentialSlot;
    readonly op: ProviderCredentialFieldOp;
  }> = [];
  for (const provider of PROVIDER_SECTION_KEYS) {
    const section = patch[provider];
    if (section === undefined) continue;
    for (const field of PROVIDER_SECRET_FIELDS[provider]) {
      const raw = (section as Record<string, string | undefined>)[field];
      if (raw === undefined) continue;
      const trimmed = raw.trim();
      if (trimmed === MASKED_SECRET) continue;
      const slot = providerCredentialSlot(provider, field);
      if (slot === undefined) continue;
      if (trimmed.length === 0) ops.push({ slot, op: { kind: "clear" } });
      else ops.push({ slot, op: { kind: "set", value: trimmed } });
    }
  }
  return ops;
};

export const historicalProviderSecrets = (
  providers: ProvidersSettings | undefined,
): ReadonlyArray<{
  readonly slot: ProviderCredentialSlot;
  readonly value: string;
}> => {
  if (providers === undefined) return [];
  const found: Array<{
    readonly slot: ProviderCredentialSlot;
    readonly value: string;
  }> = [];
  for (const provider of PROVIDER_SECTION_KEYS) {
    const section = providers[provider];
    if (section === undefined) continue;
    for (const field of PROVIDER_SECRET_FIELDS[provider]) {
      const value = (section as Record<string, string | undefined>)[field];
      if (typeof value !== "string" || value.length === 0) continue;
      const slot = providerCredentialSlot(provider, field);
      if (slot === undefined) continue;
      found.push({ slot, value });
    }
  }
  return found;
};
