import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { ProvidersSettings, Settings } from "@shared/settings";
import { PROVIDER_SECTION_KEYS, PROVIDER_SECRET_FIELDS } from "@shared/settings";
import { causeChain, describeCause } from "../failure-encode";
import type { CredentialBindingRepository } from "./bindings";
import { persistableProviders } from "./redact";
import {
  historicalProviderSecrets,
  parseProviderCredentialSlot,
  type ProviderCredentialFieldOp,
  type ProviderCredentialSlot,
} from "./slots";
import { CredentialStoreError, UnavailableCredentialStore, type CredentialStore } from "./store";

export class CredentialVaultError extends Schema.TaggedError<CredentialVaultError>()(
  "CredentialVaultError",
  { message: Schema.String, cause: Schema.Unknown },
) {}

const vaultError = (cause: unknown) => new CredentialVaultError({
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

type Bindings = typeof CredentialBindingRepository.Service;

/** A best-effort vault step that failed: its tag and scrubbed text, never an id or a value. */
const logVaultFailure = (message: string) => (cause: unknown): Effect.Effect<void> =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ area: "credentials", failure: describeCause(cause), causes: causeChain(cause).causes }));

export const resolveProviderSecrets = Effect.fn("credentials.resolve")(function* (
  bindings: Bindings,
  store: CredentialStore,
  settings: Settings,
) {
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
  for (const binding of yield* bindings.list) {
    if (binding.lifecycle !== "active") continue;
    const value = yield* Effect.try({ try: () => store.get(binding.credentialId), catch: vaultError });
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
});

const nowIso = (): string => new Date().toISOString();

export type StagedSecret = {
  readonly slot: ProviderCredentialSlot;
  readonly credentialId: string;
  readonly value: string;
};

export const stageSecretValues = Effect.fn("credentials.stage")(function* (
  store: CredentialStore,
  ops: ReadonlyArray<{
    readonly slot: ProviderCredentialSlot;
    readonly op: ProviderCredentialFieldOp;
  }>,
) {
  if (!store.available && ops.some((op) => op.op.kind === "set")) {
    const cause = store instanceof UnavailableCredentialStore ? store.cause : undefined;
    return yield* vaultError(new CredentialStoreError({
      check: "vault-unavailable", message: "credential vault is unavailable", ...(cause === undefined ? {} : { cause }),
    }));
  }
  const staged: StagedSecret[] = [];
  return yield* Effect.try({ try: (): ReadonlyArray<StagedSecret> => {
    for (const { slot, op } of ops) {
      if (op.kind !== "set") continue;
      const credentialId = randomUUID();
      staged.push({ slot, credentialId, value: op.value });
      store.put(credentialId, op.value);
      if (store.get(credentialId) !== op.value) {
        throw new CredentialStoreError({ check: "write-unverified", message: "credential vault write could not be verified" });
      }
    }
    return staged;
  }, catch: vaultError }).pipe(Effect.tapError(() => discardStaged(store, staged)));
});

export const commitProviderSecretOps = Effect.fn("credentials.commit")(function* (
  bindings: Bindings,
  ops: ReadonlyArray<{
    readonly slot: ProviderCredentialSlot;
    readonly op: ProviderCredentialFieldOp;
  }>,
  staged: ReadonlyArray<StagedSecret>,
) {
  const stagedBySlot = new Map(staged.map((item) => [item.slot, item]));
  const retired: string[] = [];
  for (const { slot, op } of ops) {
    const current = yield* bindings.activeForSlot(slot);
    if (op.kind === "clear") {
      if (current !== undefined) {
        yield* bindings.setLifecycle(current.credentialId, "delete_pending");
        retired.push(current.credentialId);
      }
      continue;
    }
    const next = stagedBySlot.get(slot);
    if (next === undefined) {
      return yield* vaultError(new CredentialStoreError({ check: "staging-incomplete", message: "credential vault staging is incomplete" }));
    }
    if (current !== undefined) {
      yield* bindings.setLifecycle(current.credentialId, "delete_pending");
      retired.push(current.credentialId);
    }
    yield* bindings.insert({
      credentialId: next.credentialId,
      slot,
      lifecycle: "active",
      createdAt: nowIso(),
    });
  }
  return retired;
});

export const retireVaultSecrets = Effect.fn("credentials.retire")(function* (
  bindings: Bindings,
  store: CredentialStore,
  retired: ReadonlyArray<string>,
) {
  for (const id of retired) {
    // Leave delete_pending so a later boot can retry.
    yield* Effect.try({ try: () => store.delete(id), catch: vaultError }).pipe(
      Effect.flatMap(() => bindings.remove(id)),
      Effect.catch(logVaultFailure("credential vault item left delete_pending for a later retry")),
    );
  }
});

/** Best-effort rollback of vault items that never became active; returns what it could not delete. */
export const discardStagedSecrets = (
  store: CredentialStore,
  staged: ReadonlyArray<StagedSecret>,
): ReadonlyArray<unknown> => {
  const failures: unknown[] = [];
  for (const item of staged) {
    try {
      store.delete(item.credentialId);
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
};

const discardStaged = Effect.fn("credentials.discard-staged")(function* (
  store: CredentialStore,
  staged: ReadonlyArray<StagedSecret>,
) {
  for (const cause of discardStagedSecrets(store, staged)) {
    yield* logVaultFailure("staged credential vault item could not be rolled back")(cause);
  }
});

export const reconcileCredentialVault = Effect.fn("credentials.reconcile")(function* (
  repository: Bindings,
  store: CredentialStore,
) {
  const bindings = yield* repository.list;
  const known = new Set(bindings.map((binding) => binding.credentialId));
  for (const binding of bindings) {
    if (binding.lifecycle !== "delete_pending") continue;
    yield* retireVaultSecrets(repository, store, [binding.credentialId]);
  }
  if (!store.available) return;
  const ids = yield* Effect.try({ try: () => store.listIds(), catch: vaultError });
  for (const id of ids) {
    if (known.has(id)) continue;
    yield* Effect.try({ try: () => store.delete(id), catch: vaultError }).pipe(
      Effect.catch(logVaultFailure("orphan credential vault item could not be deleted")),
    );
  }
});

export const migrateHistoricalProviderSecrets = Effect.fn("credentials.migrate-historical")(function* (
  bindings: Bindings,
  store: CredentialStore,
  settings: Settings,
) {
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
  const staged = yield* stageSecretValues(store, ops);
  const retired = yield* commitProviderSecretOps(bindings, ops, staged).pipe(
    Effect.onError(() => discardStaged(store, staged)),
  );
  return {
    settings: {
      ...settings,
      providers: persistableProviders(settings.providers),
    },
    retired,
  };
});

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
