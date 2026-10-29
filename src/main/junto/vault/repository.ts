/**
 * The vault tokens' scope records (`machine_vault_tokens`, state step 62):
 * names only, machine-local, written only by this machine's owner through
 * the core. The token itself is a file (`./token-file.ts`), never a row.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { MachineName } from "@shared/machine-control";
import { VaultName, VaultPermissions, VaultTokenOrigin, VaultTokenRecord } from "@shared/vault";
import { StateTransactionOperation } from "../state/service";
import { withSqlRead } from "../state/sql-read";

export class VaultTokenPersistenceError extends Schema.TaggedError<VaultTokenPersistenceError>()(
  "VaultTokenPersistenceError", { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

export class VaultTokens extends Context.Service<VaultTokens, {
  readonly get: (machineName: string) => Effect.Effect<VaultTokenRecord | undefined, VaultTokenPersistenceError>;
  readonly list: Effect.Effect<ReadonlyArray<VaultTokenRecord>, VaultTokenPersistenceError>;
  /** One record per machine: a new token replaces the last one's record. */
  readonly put: (record: VaultTokenRecord) => Effect.Effect<VaultTokenRecord, VaultTokenPersistenceError>;
  readonly remove: (machineName: string) => Effect.Effect<void, VaultTokenPersistenceError>;
}>()("@junto/VaultTokens") {}

const Row = Schema.Struct({
  machine_name: MachineName,
  vault: VaultName,
  permissions: VaultPermissions,
  origin: VaultTokenOrigin,
  account_name: Schema.NullOr(Schema.String),
  set_at_epoch_ms: Schema.Number,
});
const fromRow = (row: typeof Row.Type): VaultTokenRecord => ({
  machineName: row.machine_name, vault: row.vault, permissions: row.permissions, origin: row.origin,
  ...(row.account_name === null ? {} : { accountName: row.account_name }), setAtEpochMs: row.set_at_epoch_ms,
});
const failure = (operation: string) => (cause: unknown): VaultTokenPersistenceError =>
  cause instanceof VaultTokenPersistenceError ? cause : VaultTokenPersistenceError.make({
    operation, message: cause instanceof Error ? cause.message : String(cause), cause,
  });

export const makeVaultTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`machine_name, vault, permissions, origin, account_name, set_at_epoch_ms`;
  const find = SqlSchema.findAll({ Request: Schema.String, Result: Row,
    execute: (name) => sql`SELECT ${columns} FROM machine_vault_tokens WHERE machine_name = ${name}` });
  const all = SqlSchema.findAll({ Request: Schema.Void, Result: Row,
    execute: () => sql`SELECT ${columns} FROM machine_vault_tokens ORDER BY machine_name` });
  const get = Effect.fn("VaultTokens.get")((name: string) =>
    withSqlRead(sql, find(name)).pipe(Effect.map((rows) => rows[0] === undefined ? undefined : fromRow(rows[0])), Effect.mapError(failure("get"))));
  const list = withSqlRead(sql, all(undefined)).pipe(Effect.map((rows) => rows.map(fromRow)), Effect.mapError(failure("list")));
  const put = Effect.fn("VaultTokens.put")(function* (input: VaultTokenRecord) {
    const record = yield* Schema.decodeUnknownEffect(VaultTokenRecord)(input, { onExcessProperty: "error" });
    yield* Schema.decodeUnknownEffect(MachineName)(record.machineName);
    yield* sql.withTransaction(sql`
      INSERT INTO machine_vault_tokens (machine_name, vault, permissions, origin, account_name, set_at_epoch_ms)
      VALUES (${record.machineName}, ${record.vault}, ${record.permissions}, ${record.origin}, ${record.accountName ?? null}, ${record.setAtEpochMs})
      ON CONFLICT (machine_name) DO UPDATE SET
        vault = excluded.vault, permissions = excluded.permissions, origin = excluded.origin,
        account_name = excluded.account_name, set_at_epoch_ms = excluded.set_at_epoch_ms
    `).pipe(Effect.provideService(StateTransactionOperation, "vault.put-token-record"));
    return record;
  }, Effect.mapError(failure("put")));
  const remove = Effect.fn("VaultTokens.remove")((name: string) =>
    sql.withTransaction(sql`DELETE FROM machine_vault_tokens WHERE machine_name = ${name}`).pipe(
      Effect.asVoid, Effect.provideService(StateTransactionOperation, "vault.remove-token-record"), Effect.mapError(failure("remove"))));
  return VaultTokens.of({ get, list, put, remove });
});

export const VaultTokensLive = Layer.effect(VaultTokens, makeVaultTokens);
