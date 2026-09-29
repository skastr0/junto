import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { StateReader, StateWriter } from "../state/service";
import type { ProviderCredentialSlot } from "./slots";
import { isProviderCredentialSlot } from "./slots";

export type CredentialLifecycle = "staged" | "active" | "delete_pending";

export type ProviderCredentialBinding = {
  readonly credentialId: string;
  readonly slot: ProviderCredentialSlot;
  readonly lifecycle: CredentialLifecycle;
  readonly createdAt: string;
};

type BindingRow = {
  readonly credential_id: string;
  readonly slot: string;
  readonly lifecycle: string;
  readonly created_at: string;
};

const SELECT_ALL = `
  SELECT credential_id, slot, lifecycle, created_at
  FROM provider_credential_bindings
  UNION ALL
  SELECT credential_id, slot, lifecycle, created_at
  FROM openai_credential_bindings
`;

const tableForSlot = (slot: ProviderCredentialSlot): string =>
  slot === "openai/apiKey"
    ? "openai_credential_bindings"
    : "provider_credential_bindings";

const BINDING_TABLES = ["provider_credential_bindings", "openai_credential_bindings"] as const;

const decodeRow = (row: BindingRow): ProviderCredentialBinding | undefined => {
  if (!isProviderCredentialSlot(row.slot)) return undefined;
  if (
    row.lifecycle !== "staged" &&
    row.lifecycle !== "active" &&
    row.lifecycle !== "delete_pending"
  ) {
    return undefined;
  }
  return {
    credentialId: String(row.credential_id),
    slot: row.slot,
    lifecycle: row.lifecycle,
    createdAt: String(row.created_at),
  };
};

export const listCredentialBindings = (
  reader: StateReader,
): ReadonlyArray<ProviderCredentialBinding> =>
  reader
    .all<BindingRow>(SELECT_ALL)
    .flatMap((row) => {
      const decoded = decodeRow(row);
      return decoded === undefined ? [] : [decoded];
    });

export const activeBindingForSlot = (
  reader: StateReader,
  slot: ProviderCredentialSlot,
): ProviderCredentialBinding | undefined =>
  listCredentialBindings(reader).find(
    (binding) => binding.slot === slot && binding.lifecycle === "active",
  );

export const insertBinding = (
  writer: StateWriter,
  binding: ProviderCredentialBinding,
): void => {
  writer.run(
    `
      INSERT INTO ${tableForSlot(binding.slot)}(
        credential_id, slot, lifecycle, created_at
      ) VALUES (?, ?, ?, ?)
    `,
    [binding.credentialId, binding.slot, binding.lifecycle, binding.createdAt],
  );
};

export const setBindingLifecycle = (
  writer: StateWriter,
  credentialId: string,
  lifecycle: CredentialLifecycle,
): void => {
  for (const table of BINDING_TABLES) writer.run(
    `
      UPDATE ${table}
      SET lifecycle = ?
      WHERE credential_id = ?
    `,
    [lifecycle, credentialId],
  );
};

export const deleteBinding = (
  writer: StateWriter,
  credentialId: string,
): void => {
  for (const table of BINDING_TABLES) writer.run(
    `
      DELETE FROM ${table}
      WHERE credential_id = ?
    `,
    [credentialId],
  );
};

export class CredentialPersistenceError extends Schema.TaggedError<CredentialPersistenceError>()(
  "CredentialPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

const BindingRowSchema = Schema.Struct({
  credential_id: Schema.String,
  slot: Schema.String,
  lifecycle: Schema.String,
  created_at: Schema.String,
});

/** Lifecycle writes participate in the caller's SQL transaction. */
export class CredentialBindingRepository extends Context.Service<CredentialBindingRepository, {
  readonly list: Effect.Effect<ReadonlyArray<ProviderCredentialBinding>, CredentialPersistenceError>;
  readonly activeForSlot: (slot: ProviderCredentialSlot) => Effect.Effect<ProviderCredentialBinding | undefined, CredentialPersistenceError>;
  readonly insert: (binding: ProviderCredentialBinding) => Effect.Effect<void, CredentialPersistenceError>;
  readonly setLifecycle: (credentialId: string, lifecycle: CredentialLifecycle) => Effect.Effect<void, CredentialPersistenceError>;
  readonly remove: (credentialId: string) => Effect.Effect<void, CredentialPersistenceError>;
}>()("@junto/CredentialBindingRepository") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const persistence = (operation: string) => (cause: { readonly message: string }) =>
      new CredentialPersistenceError({ operation, message: cause.message, cause });
    const rows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: BindingRowSchema,
      execute: () => sql.unsafe(SELECT_ALL),
    });
    const list = Effect.fn("credentials.list")(function* () {
      return (yield* rows(undefined)).flatMap((row) => {
        const decoded = decodeRow(row);
        return decoded === undefined ? [] : [decoded];
      });
    }, Effect.mapError(persistence("list")))();
    const activeForSlot = Effect.fn("credentials.active-for-slot")(function* (slot: ProviderCredentialSlot) {
      return (yield* list).find((binding) => binding.slot === slot && binding.lifecycle === "active");
    });
    const insert = Effect.fn("credentials.insert")(function* (binding: ProviderCredentialBinding) {
      yield* sql`
        INSERT INTO ${sql(tableForSlot(binding.slot))}(credential_id, slot, lifecycle, created_at)
        VALUES (${binding.credentialId}, ${binding.slot}, ${binding.lifecycle}, ${binding.createdAt})
      `;
    }, Effect.mapError(persistence("insert")));
    const setLifecycle = Effect.fn("credentials.set-lifecycle")(function* (credentialId: string, lifecycle: CredentialLifecycle) {
      for (const table of BINDING_TABLES) {
        yield* sql`UPDATE ${sql(table)} SET lifecycle = ${lifecycle} WHERE credential_id = ${credentialId}`;
      }
    }, Effect.mapError(persistence("set-lifecycle")));
    const remove = Effect.fn("credentials.remove")(function* (credentialId: string) {
      for (const table of BINDING_TABLES) {
        yield* sql`DELETE FROM ${sql(table)} WHERE credential_id = ${credentialId}`;
      }
    }, Effect.mapError(persistence("remove")));
    return CredentialBindingRepository.of({ list, activeForSlot, insert, setLifecycle, remove });
  }));
}
