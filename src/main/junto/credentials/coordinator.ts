import { randomUUID } from "node:crypto";
import type { ProvidersSettings, Settings } from "@shared/settings";
import { PROVIDER_SECTION_KEYS, PROVIDER_SECRET_FIELDS } from "@shared/settings";
import type { StateReader, StateWriter } from "../state/service";
import {
  activeBindingForSlot,
  deleteBinding,
  insertBinding,
  listCredentialBindings,
  setBindingLifecycle,
} from "./bindings";
import { persistableProviders } from "./redact";
import {
  historicalProviderSecrets,
  parseProviderCredentialSlot,
  type ProviderCredentialFieldOp,
  type ProviderCredentialSlot,
} from "./slots";
import type { CredentialStore } from "./store";

export const resolveProviderSecrets = (
  reader: StateReader,
  store: CredentialStore,
  settings: Settings,
): ProvidersSettings => {
  const resolved: Record<string, unknown> = {
    enabledSources: [...(settings.providers?.enabledSources ?? [])],
    ...(settings.providers?.hermesHostSnapshots === true
      ? { hermesHostSnapshots: true }
      : {}),
  };
  const put = (provider: string, field: string, value: string): void => {
    const section = (resolved[provider] as Record<string, string> | undefined) ?? {};
    section[field] = value;
    resolved[provider] = section;
  };
  for (const binding of listCredentialBindings(reader)) {
    if (binding.lifecycle !== "active") continue;
    const value = store.get(binding.credentialId);
    if (value === undefined || value.length === 0) continue;
    const { provider, field } = parseProviderCredentialSlot(binding.slot);
    put(provider, field, value);
  }
  for (const leftover of historicalProviderSecrets(settings.providers)) {
    const { provider, field } = parseProviderCredentialSlot(leftover.slot);
    if (
      (resolved[provider] as Record<string, string> | undefined)?.[field] !==
      undefined
    ) {
      continue;
    }
    put(provider, field, leftover.value);
  }
  const organizationId = settings.providers?.devin?.organizationId;
  if (organizationId !== undefined && organizationId.length > 0) {
    put("devin", "organizationId", organizationId);
  }
  return resolved as ProvidersSettings;
};

const nowIso = (): string => new Date().toISOString();

export type StagedSecret = {
  readonly slot: ProviderCredentialSlot;
  readonly credentialId: string;
  readonly value: string;
};

export const stageSecretValues = (
  store: CredentialStore,
  ops: ReadonlyArray<{
    readonly slot: ProviderCredentialSlot;
    readonly op: ProviderCredentialFieldOp;
  }>,
): ReadonlyArray<StagedSecret> => {
  if (!store.available && ops.some((op) => op.op.kind === "set")) {
    throw new Error("credential vault is unavailable");
  }
  const staged: StagedSecret[] = [];
  try {
    for (const { slot, op } of ops) {
      if (op.kind !== "set") continue;
      const credentialId = randomUUID();
      staged.push({ slot, credentialId, value: op.value });
      store.put(credentialId, op.value);
      if (store.get(credentialId) !== op.value) {
        throw new Error("credential vault write could not be verified");
      }
    }
    return staged;
  } catch (error) {
    discardStagedSecrets(store, staged);
    throw error;
  }
};

export const commitProviderSecretOps = (
  writer: StateWriter,
  ops: ReadonlyArray<{
    readonly slot: ProviderCredentialSlot;
    readonly op: ProviderCredentialFieldOp;
  }>,
  staged: ReadonlyArray<StagedSecret>,
): ReadonlyArray<string> => {
  const stagedBySlot = new Map(staged.map((item) => [item.slot, item]));
  const retired: string[] = [];
  for (const { slot, op } of ops) {
    const current = activeBindingForSlot(writer, slot);
    if (op.kind === "clear") {
      if (current !== undefined) {
        setBindingLifecycle(writer, current.credentialId, "delete_pending");
        retired.push(current.credentialId);
      }
      continue;
    }
    const next = stagedBySlot.get(slot);
    if (next === undefined) {
      throw new Error("credential vault staging is incomplete");
    }
    if (current !== undefined) {
      setBindingLifecycle(writer, current.credentialId, "delete_pending");
      retired.push(current.credentialId);
    }
    insertBinding(writer, {
      credentialId: next.credentialId,
      slot,
      lifecycle: "active",
      createdAt: nowIso(),
    });
  }
  return retired;
};

export const retireVaultSecrets = (
  writer: StateWriter,
  store: CredentialStore,
  retired: ReadonlyArray<string>,
): void => {
  for (const id of retired) {
    try {
      store.delete(id);
      deleteBinding(writer, id);
    } catch {
      // Leave delete_pending so a later boot can retry.
    }
  }
};

export const discardStagedSecrets = (
  store: CredentialStore,
  staged: ReadonlyArray<StagedSecret>,
): void => {
  for (const item of staged) {
    try {
      store.delete(item.credentialId);
    } catch {
      // Best-effort rollback of vault items that never became active.
    }
  }
};

export const reconcileCredentialVault = (
  writer: StateWriter,
  store: CredentialStore,
): void => {
  const bindings = listCredentialBindings(writer);
  const known = new Set(bindings.map((binding) => binding.credentialId));
  for (const binding of bindings) {
    if (binding.lifecycle !== "delete_pending") continue;
    try {
      store.delete(binding.credentialId);
      deleteBinding(writer, binding.credentialId);
    } catch {
      // Retry next boot.
    }
  }
  if (!store.available) return;
  for (const id of store.listIds()) {
    if (known.has(id)) continue;
    try {
      store.delete(id);
    } catch {
      // Orphan sweep is best-effort.
    }
  }
};

export const migrateHistoricalProviderSecrets = (
  writer: StateWriter,
  store: CredentialStore,
  settings: Settings,
): { readonly settings: Settings; readonly retired: ReadonlyArray<string> } => {
  const leftovers = historicalProviderSecrets(settings.providers);
  if (leftovers.length === 0) {
    return {
      settings: {
        ...settings,
        providers: persistableProviders(settings.providers),
      },
      retired: [],
    };
  }
  if (!store.available) {
    return { settings, retired: [] };
  }
  const ops = leftovers.map((secret) => ({
    slot: secret.slot,
    op: { kind: "set" as const, value: secret.value },
  }));
  const staged = stageSecretValues(store, ops);
  try {
    const retired = commitProviderSecretOps(writer, ops, staged);
    return {
      settings: {
        ...settings,
        providers: persistableProviders(settings.providers),
      },
      retired,
    };
  } catch (error) {
    discardStagedSecrets(store, staged);
    throw error;
  }
};

export const clearAllProviderSecretOps = (): ReadonlyArray<{
  readonly slot: ProviderCredentialSlot;
  readonly op: ProviderCredentialFieldOp;
}> =>
  PROVIDER_SECTION_KEYS.flatMap((provider) =>
    PROVIDER_SECRET_FIELDS[provider].map((field) => ({
      slot: `${provider}/${field}` as ProviderCredentialSlot,
      op: { kind: "clear" as const },
    })),
  );
