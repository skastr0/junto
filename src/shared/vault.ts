/**
 * The vault contract (docs/machines.md, The vault): a region names a vault,
 * never a value, and each machine reads it with its own token. 1Password is
 * the first backend: a vault the operator made for Junto and one
 * service-account token per machine.
 */
import { Schema } from "effect";

/**
 * A 1Password vault name as Junto passes it. Never `:` or `,`, which would add
 * permissions or vaults to the mint's `--vault <name>:<permissions>`
 * argument, never `/`, which would split an `op://` reference, and never a
 * control character or an outer space.
 */
export const VaultName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[^\s:,/\u0000-\u001f\u007f](?:[^:,/\u0000-\u001f\u007f]*[^\s:,/\u0000-\u001f\u007f])?$/u)),
);
export type VaultName = typeof VaultName.Type;

/** The window machine's token writes; every other machine's only reads. */
export const VaultPermissions = Schema.Literals(["read_items", "read_items,write_items"]);
export type VaultPermissions = typeof VaultPermissions.Type;

/** `minted`: Junto ran the fixed create, so the scope is verified. `pasted`: the operator's word. */
export const VaultTokenOrigin = Schema.Literals(["minted", "pasted"]);
export type VaultTokenOrigin = typeof VaultTokenOrigin.Type;

/** The region's vault. */
export const RegionVault = Schema.Struct({
  backend: Schema.Literal("onepassword"),
  vault: VaultName,
});
export type RegionVault = typeof RegionVault.Type;

/** Does this `op://` reference point inside the vault, by its exact name. */
export const isRefInVault = (ref: string, vault: string): boolean => ref.startsWith(`op://${vault}/`);

/** The vault a reference names, or none for a reference that is not `op://<vault>/…`. */
export const vaultOfRef = (ref: string): string | undefined => {
  const match = /^op:\/\/([^/]+)\//u.exec(ref);
  return match?.[1];
};

/**
 * A 1Password service-account token: `ops_` then its encoded body. The shape
 * only, for refusing a paste that is plainly not one; 1Password decides the rest.
 */
export const VaultTokenSecret = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4096)),
  Schema.check(Schema.isPattern(/^ops_[A-Za-z0-9+/=_.-]{20,}$/u)),
);

/** The names-only scope record, as `machine_vault_tokens` holds it. */
export const VaultTokenRecord = Schema.Struct({
  machineName: Schema.String,
  vault: VaultName,
  permissions: VaultPermissions,
  origin: VaultTokenOrigin,
  /** The service account the mint made; only for `minted`. */
  accountName: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)))),
  setAtEpochMs: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type VaultTokenRecord = typeof VaultTokenRecord.Type;
