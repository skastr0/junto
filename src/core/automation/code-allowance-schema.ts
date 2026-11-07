/**
 * The code allowance (docs/security-doctrine.md, Code steps, check 4):
 * whether this machine runs code steps for a canvas, who may have authored
 * them, and the ruling installations it trusts for that canvas. Machine-local
 * by construction: written only by this machine's owner through the core, not
 * a fact, never in a copy, never named by the exchange. A canvas's delete
 * takes its allowance with it. Added by state migration 56 -> 57.
 *
 * Unread: the operator ruled that code steps have no per-machine allowance
 * (5020cea97). The step is committed, so the tables stay, empty, until a
 * consolidate step the operator approves removes them.
 */
export const MACHINE_CODE_ALLOWANCES_SQL = `
  CREATE TABLE IF NOT EXISTS machine_code_allowances (
    canvas_name TEXT NOT NULL
      CHECK (length(canvas_name) BETWEEN 1 AND 256)
      REFERENCES canvases (canvas_name) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('operator', 'operator-and-overseers')),
    PRIMARY KEY (canvas_name)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS machine_code_allowance_installations (
    canvas_name TEXT NOT NULL
      REFERENCES machine_code_allowances (canvas_name) ON DELETE CASCADE,
    installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, installation_id)
  ) STRICT, WITHOUT ROWID;
`;

/** The tables this file creates, for the test that the exchange never names them. */
export const MACHINE_CODE_ALLOWANCE_TABLES = ["machine_code_allowances", "machine_code_allowance_installations"] as const;
