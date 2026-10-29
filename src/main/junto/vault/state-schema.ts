/**
 * The vault token's scope record (docs/machines.md, The vault): which vault
 * a machine's 1Password service-account token is for, with which
 * permissions, and how that is known. `minted` means Junto ran the one fixed
 * `op service-account create` itself, so the argv is the proof of scope and
 * the account name it gave is kept; `pasted` means the operator handed the
 * token in, and the scope is the operator's word, unverified.
 *
 * Names only: the token itself is a 0600 file in the Junto home, never a row.
 * Machine-local by construction, written only by this machine's owner
 * through the core, not a fact, never in a copy, never named by the
 * exchange. On the window's machine a row per machine it handed a token to;
 * on any other, its own row. A vault name can never hold `:` or `,`, which
 * would add permissions or vaults to the mint's `--vault` argument. Added by
 * state migration 61 -> 62.
 */
export const MACHINE_VAULT_TOKENS_SQL = `
  CREATE TABLE IF NOT EXISTS machine_vault_tokens (
    machine_name TEXT NOT NULL CHECK (
      machine_name <> 'local'
      AND length(machine_name) BETWEEN 1 AND 64
      AND machine_name GLOB '[A-Za-z0-9]*'
      AND machine_name NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
    vault TEXT NOT NULL CHECK (
      length(vault) BETWEEN 1 AND 128
      AND instr(vault, ':') = 0
      AND instr(vault, ',') = 0
    ),
    permissions TEXT NOT NULL CHECK (permissions IN ('read_items', 'read_items,write_items')),
    origin TEXT NOT NULL CHECK (origin IN ('minted', 'pasted')),
    account_name TEXT CHECK (account_name IS NULL OR length(account_name) BETWEEN 1 AND 128),
    set_at_epoch_ms INTEGER NOT NULL CHECK (set_at_epoch_ms >= 0),
    CHECK ((origin = 'minted') = (account_name IS NOT NULL)),
    PRIMARY KEY (machine_name)
  ) STRICT, WITHOUT ROWID;
`;

/** The tables this file creates, for the test that the exchange never names them. */
export const MACHINE_VAULT_TOKEN_TABLES = ["machine_vault_tokens"] as const;
