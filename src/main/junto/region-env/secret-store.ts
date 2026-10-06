/**
 * Junto's own secret store, as the rest of main uses it.
 *
 * A region source of `kind: "secret"` names a secret by id; the value lives
 * here, in the platform's store (macOS Keychain, Linux Secret Service) or in
 * owner-only files where neither exists. The canvas never holds it.
 *
 * A value comes in once, on save, and no call here returns it to a caller
 * outside main: `read` exists for the launch resolver alone. Operations act
 * on this machine's store and are never forwarded to another installation.
 */
import { randomUUID } from "node:crypto";
import {
  SECRET_STORE_ENV,
  forcedSecretStoreOf,
  openPlatformSecretStore,
  regionSecretDirectory,
  type CredentialStore,
  type OpenedSecretStore,
  type SecretStoreBackend,
} from "../credentials/store";
import {
  SECRET_ID_PATTERN,
  SECRET_VALUE_MAX_BYTES,
  secretValueProblem,
} from "@shared/region-secrets";
import { stateDatabasePath } from "../state/engine";

export { SECRET_ID_PATTERN, SECRET_VALUE_MAX_BYTES, secretValueProblem };

export type SecretResult<T = object> =
  | ({ readonly ok: true } & T)
  /** Plain words for the operator. Never contains the value. */
  | { readonly ok: false; readonly message: string };

export type RegionSecrets = {
  readonly backend: SecretStoreBackend;
  /** One sentence naming the active store. */
  readonly description: string;
  /** Save a value. With `secretId` the value behind it is replaced; without, a new id is minted. */
  readonly save: (input: {
    readonly value: string;
    readonly secretId?: string;
  }) => SecretResult<{ readonly secretId: string }>;
  /** Remove a secret. Removing an unknown id is ok. */
  readonly remove: (secretId: string) => SecretResult;
  /** Ids of the secrets saved on this machine. Never values. */
  readonly list: () => ReadonlyArray<string>;
  /** The value, for the launch resolver only. Undefined when there is none. */
  readonly read: (secretId: string) => string | undefined;
};

export const makeRegionSecrets = (opened: OpenedSecretStore): RegionSecrets => {
  const store: CredentialStore = opened.store;
  return {
    backend: opened.backend,
    description: opened.description,
    save: ({ value, secretId }) => {
      const problem = secretValueProblem(value);
      if (problem) return { ok: false, message: problem };
      if (secretId !== undefined && !SECRET_ID_PATTERN.test(secretId)) {
        return { ok: false, message: "That is not a secret id." };
      }
      if (!store.available) {
        return { ok: false, message: opened.description };
      }
      const id = (secretId ?? randomUUID()).toLowerCase();
      try {
        store.put(id, value);
        return { ok: true, secretId: id };
      } catch (error) {
        // Store errors are fixed sentences written in this codebase; a tool's
        // own output never reaches here.
        return {
          ok: false,
          message: `The secret was not saved: ${error instanceof Error ? error.message : "the store failed"}.`,
        };
      }
    },
    remove: (secretId) => {
      if (!SECRET_ID_PATTERN.test(secretId)) return { ok: true };
      try {
        store.delete(secretId.toLowerCase());
        return { ok: true };
      } catch {
        return { ok: false, message: "The secret could not be removed." };
      }
    },
    list: () => [...store.listIds()].sort(),
    read: (secretId) =>
      SECRET_ID_PATTERN.test(secretId) ? store.get(secretId.toLowerCase()) : undefined,
  };
};

let current: RegionSecrets | undefined;

/**
 * This machine's secret store, opened on first use. The backend is picked
 * once per process; `description` says which one is active.
 */
export const regionSecrets = (): RegionSecrets => {
  if (current === undefined) {
    current = makeRegionSecrets(
      openPlatformSecretStore({
        directory: regionSecretDirectory(stateDatabasePath()),
        // Read once, here: JUNTO_SECRET_STORE=file|keychain|keyring.
        forced: forcedSecretStoreOf(process.env[SECRET_STORE_ENV]),
      }),
    );
    // Said once, when the store is picked: which one is active on this machine.
    console.info(`[region-env] ${current.description}`);
  }
  return current;
};

/** Tests and embedders: put a store in place of the platform one, or clear it. */
export const setRegionSecrets = (next: RegionSecrets | undefined): void => {
  current = next;
};
