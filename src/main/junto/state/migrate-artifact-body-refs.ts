import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/work-canonical-json";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration that names every artifact version's body by content ref
 * (05 with 02's 64 KiB ruling row): `body_ref_json` on every version. The
 * required `body_json` retires for a nullable `inline_body_json`, so a replica
 * can hold a version whose bytes are still on their way (pending) and read
 * them from the content store once pulled.
 *
 * The table is rebuilt and every version kept. A stored body is rewritten as
 * its canonical JSON and its ref is the sha256 of exactly those bytes, as
 * `artifactBodyRef` names it. A body that does not parse stops the step.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */
const ARTIFACT_VERSIONS_BODY_REF_SQL = `
  CREATE TABLE artifact_versions (
    canvas_name TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    at INTEGER NOT NULL CHECK (at >= 0),
    edit_json TEXT CHECK (edit_json IS NULL OR json_valid(edit_json)),
    body_ref_json TEXT NOT NULL CHECK (json_valid(body_ref_json)),
    inline_body_json TEXT CHECK (inline_body_json IS NULL OR json_valid(inline_body_json)),
    PRIMARY KEY (canvas_name, artifact_id, version),
    CHECK ((version = 1) = (edit_json IS NULL)),
    FOREIGN KEY (canvas_name, artifact_id)
      REFERENCES artifact_heads (canvas_name, artifact_id)
      ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
`;

const KEPT = ["canvas_name", "artifact_id", "version", "op_id", "author_json", "at", "edit_json"] as const;

type StoredVersion = Record<(typeof KEPT)[number], string | number | null> & { readonly body_json: string };

export const migrateArtifactBodyRefs = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT.join(", ")}, body_json FROM artifact_versions ORDER BY canvas_name, artifact_id, version`)
    .all() as unknown as ReadonlyArray<StoredVersion>;
  database.exec("DROP TABLE artifact_versions");
  database.exec(ARTIFACT_VERSIONS_BODY_REF_SQL);
  const insert = database.prepare(
    `INSERT INTO artifact_versions (${KEPT.join(", ")}, body_ref_json, inline_body_json)
     VALUES (${KEPT.map(() => "?").join(", ")}, ?, ?)`,
  );
  for (const row of stored) {
    const body = canonicalJson(JSON.parse(row.body_json));
    const bytes = Buffer.from(body, "utf8");
    const ref = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "application/json",
    };
    insert.run(...KEPT.map((column) => row[column]), JSON.stringify(ref), body);
  }
  const kept = Number(database.prepare("SELECT count(*) AS n FROM artifact_versions").get()!.n);
  if (kept !== stored.length) throw new Error("an artifact version did not survive the step");
};
