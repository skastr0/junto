import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { KIND_TABLES_V13 } from "../src/main/junto/model/migrate";
import { machineNameAtMigration } from "../src/main/junto/state/machine-name-at-migration";
import { convertLegacyRow, type LegacyNodeRow } from "../src/shared/model/from-legacy-row";
import { fileSha256 } from "./preview-snapshot";

const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export const checkPreview = (home: string) => {
  const baselinePath = join(home, "before", "junto.db");
  const manifest = JSON.parse(readFileSync(join(home, "snapshot.json"), "utf8")) as { beforeSha256: string };
  const before = new DatabaseSync(baselinePath, { readOnly: true });
  const after = new DatabaseSync(join(home, ".junto", "state", "junto.db"), { readOnly: true });
  try {
    before.exec("PRAGMA query_only=ON; BEGIN");
    after.exec("PRAGMA query_only=ON; BEGIN");
    const failures: string[] = [];
    const unchangedBaseline = fileSha256(baselinePath) === manifest.beforeSha256;
    if (!unchangedBaseline) failures.push("Untouched baseline hash changed");
    const health = (db: DatabaseSync) => ({ version: db.prepare("PRAGMA user_version").get()?.user_version,
      integrity: db.prepare("PRAGMA integrity_check").all(), foreignKeys: db.prepare("PRAGMA foreign_key_check").all() });
    const baselineHealth = health(before), previewHealth = health(after);
    for (const [label, h] of [["before", baselineHealth], ["after", previewHealth]] as const) {
      if (h.integrity.length !== 1 || h.integrity[0]?.integrity_check !== "ok" || h.foreignKeys.length) failures.push(`${label}: database health check failed`);
    }
    const legacy = before.prepare(`SELECT d.canvas_name,n.* FROM canvas_nodes n JOIN canvas_documents d USING(canvas_id) ORDER BY d.canvas_name,n.z_index,n.node_id`).all() as unknown as LegacyNodeRow[];
    const expected = new Map<string, Map<string, number>>();
    const bindings = new Map<string, Set<string>>();
    const downgraded: Array<{ canvas: string; id: string; storedType: string; reason: string }> = [];
    const seatChanges: Array<{ canvas: string; id: string; changes: Record<string, unknown> }> = [];
    const thisMachine = machineNameAtMigration(before);
    for (const row of legacy) {
      let { node, downgraded: downgrade } = convertLegacyRow(row, thisMachine);
      if (node.kind === "agent" || node.kind === "terminal") {
        const seen = bindings.get(row.canvas_name) ?? new Set<string>();
        if (seen.has(node.bindingId)) {
          downgrade = { canvas: row.canvas_name, id: row.node_id, storedType: node.kind, reason: "session binding already belongs to an earlier node; preserved as a note" };
          node = convertLegacyRow({ ...row, type: "text", ether_json: null }, thisMachine).node;
        } else seen.add(node.bindingId);
        bindings.set(row.canvas_name, seen);
      }
      if (downgrade) {
        downgraded.push(downgrade);
        if (!after.prepare("SELECT id FROM notes WHERE canvas_name=? AND id=?").get(row.canvas_name, row.node_id)) failures.push(`${row.canvas_name}/${row.node_id}: downgraded note missing`);
      }
      const counts = expected.get(row.canvas_name) ?? new Map<string, number>();
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
      expected.set(row.canvas_name, counts);
      let raw: { entity?: { kind?: string }; terminal?: Record<string, unknown> } = {};
      try { raw = JSON.parse(row.ether_json ?? "{}"); } catch { /* malformed rows are reported above */ }
      if (raw.entity?.kind === "agent" || raw.entity?.kind === "terminal") {
        const migrated = after.prepare(`SELECT binding_id,${raw.entity.kind === "agent" ? "harness,session_id" : "NULL AS harness,NULL AS session_id"} FROM ${identifier(raw.entity.kind === "agent" ? "seats" : "terminals")} WHERE canvas_name=? AND id=?`).get(row.canvas_name, row.node_id);
        const changes: Record<string, unknown> = {};
        for (const [oldKey, newKey] of [["bindingId", "binding_id"], ["harness", "harness"], ["sessionId", "session_id"]]) {
          const old = raw.terminal?.[oldKey] ?? null, next = migrated?.[newKey] ?? null;
          if (old !== next) changes[oldKey] = { before: old, after: next };
        }
        if (!migrated) changes.kind = { before: raw.entity.kind, after: node.kind };
        if (Object.keys(changes).length) seatChanges.push({ canvas: row.canvas_name, id: row.node_id, changes });
      }
    }
    const canvases = before.prepare("SELECT canvas_name FROM canvas_documents ORDER BY canvas_name").all().map(({ canvas_name }) => {
      const canvas = String(canvas_name);
      // The check is of step 12 -> 13, so it walks the tables that step creates.
      const kinds = Object.entries(KIND_TABLES_V13).map(([kind, table]) => {
        const actual = Number(after.prepare(`SELECT count(*) AS n FROM ${identifier(table)} WHERE canvas_name=?`).get(canvas)?.n);
        const count = expected.get(canvas)?.get(kind) ?? 0;
        if (actual !== count) failures.push(`${canvas}/${kind}: ${count} expected, ${actual} actual`);
        return { kind, beforeConverted: count, after: actual };
      });
      const oldNodes = legacy.filter(row => row.canvas_name === canvas).length;
      const oldWires = Number(before.prepare("SELECT count(*) AS n FROM canvas_edges e JOIN canvas_documents d USING(canvas_id) WHERE d.canvas_name=?").get(canvas)?.n);
      const newWires = Number(after.prepare("SELECT count(*) AS n FROM wires WHERE canvas_name=?").get(canvas)?.n);
      if (oldWires !== newWires) failures.push(`${canvas}: wire count changed`);
      return { canvas, nodesBefore: oldNodes, nodesAfter: kinds.reduce((n, k) => n + k.after, 0), wiresBefore: oldWires, wiresAfter: newWires, kinds };
    });
    const workCounts = (db: DatabaseSync) => new Map(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_%' ORDER BY name").all().map(row => {
      const name = String(row.name);
      return [name, Number(db.prepare(`SELECT count(*) AS n FROM ${identifier(name)}`).get()?.n)] as const;
    }));
    const oldWork = workCounts(before), newWork = workCounts(after);
    const work = [...new Set([...oldWork.keys(), ...newWork.keys()])].sort().map(table => {
      const previous = oldWork.get(table) ?? null, current = newWork.get(table) ?? null;
      if (previous !== null && current !== previous) failures.push(`${table}: Work row count changed`);
      return { table, before: previous, after: current };
    });
    if (seatChanges.length) failures.push(`${seatChanges.length} seats changed binding, harness, session or kind`);
    const extraCanvases = after.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name").all().filter(row => !canvases.some(c => c.canvas === row.canvas_name)).map(row => row.canvas_name);
    return { ok: failures.length === 0, unchangedBaseline, baselineHealth, previewHealth, canvases, extraCanvases, downgraded, seatChanges, work, failures };
  } finally { before.close(); after.close(); }
};

if (process.argv[1]?.endsWith("/preview-db-check.ts") || process.argv[1]?.endsWith("/preview-db-check.mjs") || process.argv[1]?.endsWith("/preview-db-check.js")) {
  const result = checkPreview(resolve(process.env.JUNTO_HOME ?? join(homedir(), ".junto-preview-copy")));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
