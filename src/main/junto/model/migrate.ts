import { recordSystemLog } from "../observability/logger";
import { isDeepStrictEqual } from "node:util";
import type { StateSchemaMigrationDatabase } from "../state/migrations";
import {
  convertLegacyRow,
  sheetGridFromLegacyRow,
  wireFromLegacyRow,
  type LegacyNodeRow,
  type LegacyWireRow,
} from "@shared/model/from-legacy-row";
import { KIND_TABLES, MODEL_STATE_SCHEMA_SQL } from "./state-schema";
import {
  nodeFromRow,
  nodeToRow,
  wireFromRow,
  wireToRow,
  type SqlValues,
} from "./rows";

const insert = (
  database: StateSchemaMigrationDatabase,
  table: string,
  row: SqlValues,
) => {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
};

/** Copy forward and prove each domain row, without constructing a document. */
export const migrateCanvasKinds = (
  database: StateSchemaMigrationDatabase,
): void => {
  const oldNodes = database
    .prepare(
      `SELECT d.canvas_name,n.*,e.created_at
    FROM canvas_nodes n JOIN canvas_documents d USING(canvas_id)
    LEFT JOIN canvas_entities e ON e.canvas_name=d.canvas_name AND e.entity_id=n.node_id
    ORDER BY d.canvas_name,n.z_index,n.node_id`,
    )
    .all() as unknown as Array<
    LegacyNodeRow & { created_at: string | null; updated_at: string }
  >;
  const oldWires = database
    .prepare(
      `SELECT d.canvas_name,e.* FROM canvas_edges e
    JOIN canvas_documents d USING(canvas_id) ORDER BY d.canvas_name,e.z_index,e.edge_id`,
    )
    .all() as unknown as Array<
    LegacyWireRow & { z_index: number; updated_at: string }
  >;
  const generation =
    database
      .prepare("SELECT generation FROM canvas_portfolio_head WHERE singleton=1")
      .get()?.generation ?? "0";
  const initialSeq = Number(generation);
  if (!Number.isSafeInteger(initialSeq) || initialSeq < 0)
    throw new Error(
      "canvas change sequence cannot represent installed authority",
    );
  database.exec(MODEL_STATE_SCHEMA_SQL);
  database
    .prepare(
      `INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at,seq)
    SELECT canvas_name,canvas_id,created_at,modified_at,? FROM canvas_documents`,
    )
    .run(initialSeq);
  const bindings = new Map<string, Set<string>>();
  for (const old of oldNodes) {
    let { node, downgraded } = convertLegacyRow(old);
    if (node.kind === "agent" || node.kind === "terminal") {
      const occupied = bindings.get(old.canvas_name) ?? new Set<string>();
      if (occupied.has(node.bindingId)) {
        downgraded = { canvas: old.canvas_name, id: node.id, storedType: node.kind,
          reason: "session binding already belongs to an earlier node; preserved as a note" };
        node = convertLegacyRow({ ...old, type: "text", ether_json: null }).node;
      } else occupied.add(node.bindingId);
      bindings.set(old.canvas_name, occupied);
    }
    if (downgraded)
      recordSystemLog(`Junto migrated stored object ${JSON.stringify(downgraded)}`, "warn");
    const table = KIND_TABLES[node.kind];
    insert(database, table, {
      ...nodeToRow(old.canvas_name, node),
      created_at: old.created_at ?? old.updated_at,
      updated_at: old.updated_at,
    });
    const copied = database
      .prepare(`SELECT * FROM ${table} WHERE canvas_name=? AND id=?`)
      .get(old.canvas_name, node.id)!;
    if (!isDeepStrictEqual(nodeFromRow(node.kind, copied), node))
      throw new Error(`kind migration changed ${node.kind} ${node.id}`);
    const grid =
      node.kind === "sheet" ? sheetGridFromLegacyRow(old) : undefined;
    if (grid !== undefined)
      insert(database, "sheet_grids", {
        canvas_name: old.canvas_name,
        id: node.id,
        columns_json: JSON.stringify(grid.columns),
        rows_json: JSON.stringify(grid.rows),
        updated_at: old.updated_at,
      });
  }
  for (const old of oldWires) {
    const wire = wireFromLegacyRow(old);
    insert(database, "wires", {
      ...wireToRow(old.canvas_name, wire),
      created_at: old.updated_at,
      updated_at: old.updated_at,
    });
    const copied = database
      .prepare("SELECT * FROM wires WHERE canvas_name=? AND id=?")
      .get(old.canvas_name, wire.id)!;
    if (!isDeepStrictEqual(wireFromRow(copied), wire))
      throw new Error(`kind migration changed connection ${wire.id}`);
  }
  const total = Object.values(KIND_TABLES).reduce(
    (count, table) =>
      count +
      Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
    0,
  );
  if (
    total !== oldNodes.length ||
    Number(database.prepare("SELECT count(*) AS n FROM wires").get()!.n) !==
      oldWires.length
  )
    throw new Error("kind migration did not preserve every identity");
  // Explicit operator decision: the archive ledger is retired, not resurrected.
  database.exec(`
    DROP TABLE canvas_edges;
    DROP TABLE canvas_nodes;
    DROP TABLE canvas_entities;
    DROP TABLE canvas_documents;
    DROP TABLE canvas_portfolio_head;
  `);
};
