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
  // Under the 4 KiB a stdin delivery may carry, with its JSON around it.
  Schema.check(Schema.isMaxLength(3072)),
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

/**
 * Can this machine's token reach the vault right now: `op vault get` on the
 * one vault, a liveness check and never proof of scope.
 */
export const VaultLiveness = Schema.Literals(["ready", "token-refused", "vault-missing", "op-missing", "unreachable", "no-token"]);
export type VaultLiveness = typeof VaultLiveness.Type;

/** What the machine list and a placement show of one machine's token: names, never the token. */
export const MachineVaultView = Schema.Struct({
  vault: VaultName,
  permissions: VaultPermissions,
  origin: VaultTokenOrigin,
  /** `verified` only for a token Junto minted with the fixed argv; a pasted one is the operator's word. */
  scope: Schema.Literals(["verified", "unverified"]),
  accountName: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
  setAtEpochMs: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Whole days since it was set: the operator revokes it in 1Password, Junto only shows its age. */
  ageDays: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MachineVaultView = typeof MachineVaultView.Type;

export const vaultView = (record: VaultTokenRecord, nowMs: number): MachineVaultView => ({
  vault: record.vault, permissions: record.permissions, origin: record.origin,
  scope: record.origin === "minted" ? "verified" : "unverified",
  ...(record.accountName === undefined ? {} : { accountName: record.accountName }),
  setAtEpochMs: record.setAtEpochMs,
  ageDays: Math.max(0, Math.floor((nowMs - record.setAtEpochMs) / 86_400_000)),
});

/**
 * `junto machine vault-token <machine> --vault <V>`, on the window's machine:
 * the token comes from the command's stdin and rides only the owner socket
 * to this core, then that machine's SSH stdin. Never argv, an environment
 * value, a row or a log. With `mint`, no token comes in: this core mints it
 * under the operator's own 1Password session.
 */
export const MachineVaultTokenInput = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  vault: VaultName,
  token: Schema.optionalKey(VaultTokenSecret),
  mint: Schema.optionalKey(Schema.Literal(true)),
}).pipe(Schema.check(Schema.makeFilter((input) => (input.token === undefined) !== (input.mint === undefined) || "a vault token is pasted in or minted, one of the two")));
export type MachineVaultTokenInput = typeof MachineVaultTokenInput.Type;

/** The service account a mint makes for a machine: its name says which machine and which token. */
export const VaultAccountName = Schema.String.pipe(Schema.check(Schema.isPattern(/^junto-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-(?:read|write)$/u)));

/** What `vault-token-local` reads from its stdin on the receiving machine; `accountName` only for a minted token. */
export const VaultTokenDelivery = Schema.Struct({
  vault: VaultName, permissions: VaultPermissions, token: VaultTokenSecret,
  accountName: Schema.optionalKey(VaultAccountName),
});
export type VaultTokenDelivery = typeof VaultTokenDelivery.Type;

/**
 * The receiving machine's own record, written through its core once
 * `vault-token-local` has placed the token file. Names only.
 */
export const MachineVaultRecordInput = Schema.Struct({
  vault: VaultName,
  permissions: VaultPermissions,
  origin: VaultTokenOrigin,
  accountName: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)))),
});
export type MachineVaultRecordInput = typeof MachineVaultRecordInput.Type;

/** A token placed: the machine's record, and whether the token reaches the vault from there. */
export const MachineVaultTokenData = Schema.Struct({
  machineName: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64))),
  token: MachineVaultView,
  liveness: VaultLiveness,
  /** Best effort, unverified for service accounts: `op vault list` showed more than this one vault. */
  seesOtherVaults: Schema.optionalKey(Schema.Literal(true)),
});
export type MachineVaultTokenData = typeof MachineVaultTokenData.Type;
