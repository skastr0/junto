/**
 * Keep canvas_entities aligned with authorial canvas membership.
 *
 * - Every node present in the next doc is active in the registry.
 * - Every previously-active entity missing from the next doc is archived.
 * - soft_deleted rows are never reactivated by absence (only by re-membership).
 * - Re-adding a node id reactivates archived/soft_deleted → active
 *   (operator re-authorship; soft_delete is unindexed hide, not irreversible death).
 *
 * Order for active-only binding uniqueness:
 * 1. clear bindings that change hands between two rows which both stay active
 * 2. archive departures (frees bindings for replacements)
 * 3. write the rows whose registry identity actually moved
 *
 * Cost law: one document write costs the DELTA, not the canvas. canvas_entities
 * is the materialized view of node membership, so this is ordinary incremental
 * view maintenance — read the current rows once, diff them against the next
 * document on the fields the view stores (kind, binding_id, lifecycle), and
 * write only the rows that differ. Moving one node on a 96-node canvas used to
 * cost 1 + 96 + 96 statements; it now costs 1 + 1.
 *
 * The diff is taken against the TABLE, never against a previous document. That
 * is deliberate and is what keeps the fast path from defeating the registry
 * healing in canvases.ts bootstrap: a row that is missing, or whose kind or
 * binding drifted away from the document, IS a diff and is repaired here on the
 * next write. Diffing two documents would silently skip exactly those rows.
 *
 * Consequence worth naming: updated_at now marks when a registry row last
 * changed rather than when the canvas was last written. That is the column's
 * documented meaning, and the bootstrap reconcile already skipped aligned
 * canvases, so no consumer could have read it as a canvas-wide write clock.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EntityLifecycle } from "@shared/entity";

/** What one node in the next document asks the registry to hold. */
type DesiredEntity = {
  readonly kind: string | null;
  readonly bindingId: string | null;
};

const nodeKind = (node: CanvasNode): string | null => {
  const kind = node.ether?.entity?.kind;
  if (typeof kind === "string" && kind.length > 0 && kind.length <= 128) {
    return kind;
  }
  return node.type;
};

const nodeBindingId = (node: CanvasNode): string | null => {
  const bindingId = node.ether?.terminal?.bindingId;
  if (
    typeof bindingId === "string" &&
    bindingId.length > 0 &&
    bindingId.length <= 256
  ) {
    return bindingId;
  }
  return null;
};

/** Registry mutations participate in the canvas/content caller's SQL transaction. */
const makeCanvasEntitySync = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rowsForCanvas = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      entity_id: Schema.String, kind: Schema.NullOr(Schema.String),
      binding_id: Schema.NullOr(Schema.String), lifecycle: EntityLifecycle,
    }),
    execute: (name) => sql`SELECT entity_id, kind, binding_id, lifecycle
      FROM canvas_entities WHERE canvas_name = ${name}`,
  });
  const syncCanvasEntities = Effect.fn("CanvasEntitySync.syncCanvasEntities")(function* (
    canvasName: string, nextDoc: CanvasDoc, now: string,
  ) {
    const desired = new Map<string, DesiredEntity>();
    const claimedBindings = new Set<string>();
    for (const node of nextDoc.nodes) {
      let bindingId = nodeBindingId(node);
      if (bindingId !== null) {
        if (claimedBindings.has(bindingId)) bindingId = null;
        else claimedBindings.add(bindingId);
      }
      desired.set(node.id, { kind: nodeKind(node), bindingId });
    }
    const rows = new Map((yield* rowsForCanvas(canvasName)).map((row) => [row.entity_id, row]));
    const nextHolder = new Map<string, string>();
    for (const [id, entity] of desired) {
      if (entity.bindingId !== null) nextHolder.set(entity.bindingId, id);
    }
    for (const [id, row] of rows) {
      if (row.lifecycle !== "active" || row.binding_id === null) continue;
      const entity = desired.get(id);
      if (entity === undefined || entity.bindingId === row.binding_id) continue;
      const successor = nextHolder.get(row.binding_id);
      if (successor === undefined || successor === id) continue;
      yield* sql`UPDATE canvas_entities SET binding_id = NULL, updated_at = ${now}
        WHERE canvas_name = ${canvasName} AND entity_id = ${id} AND lifecycle = 'active'`;
    }
    for (const [id, row] of rows) {
      if (row.lifecycle !== "active" || desired.has(id)) continue;
      yield* sql`UPDATE canvas_entities SET lifecycle = 'archived', updated_at = ${now},
        archived_at = ${now}, soft_deleted_at = NULL
        WHERE canvas_name = ${canvasName} AND entity_id = ${id} AND lifecycle = 'active'`;
    }
    for (const [id, entity] of desired) {
      const row = rows.get(id);
      if (row !== undefined && row.lifecycle === "active" && row.kind === entity.kind && row.binding_id === entity.bindingId) continue;
      yield* sql`INSERT INTO canvas_entities(canvas_name, entity_id, kind, binding_id,
        lifecycle, created_at, updated_at, archived_at, soft_deleted_at)
        VALUES (${canvasName}, ${id}, ${entity.kind}, ${entity.bindingId}, 'active', ${now}, ${now}, NULL, NULL)
        ON CONFLICT(canvas_name, entity_id) DO UPDATE SET kind = excluded.kind,
          binding_id = excluded.binding_id, lifecycle = 'active', updated_at = excluded.updated_at,
          archived_at = NULL, soft_deleted_at = NULL`;
    }
  });
  const archiveAllCanvasEntities = Effect.fn("CanvasEntitySync.archiveAllCanvasEntities")(function* (canvasName: string, now: string) {
    yield* sql`UPDATE canvas_entities SET lifecycle = 'archived', updated_at = ${now},
      archived_at = COALESCE(archived_at, ${now}), soft_deleted_at = NULL
      WHERE canvas_name = ${canvasName} AND lifecycle = 'active'`;
  });
  const softDeleteCanvasEntity = Effect.fn("CanvasEntitySync.softDeleteCanvasEntity")(function* (canvasName: string, entityId: string, now: string) {
    yield* sql`UPDATE canvas_entities SET lifecycle = 'soft_deleted', updated_at = ${now}, soft_deleted_at = ${now}
      WHERE canvas_name = ${canvasName} AND entity_id = ${entityId} AND lifecycle = 'archived'`;
  });
  const activeCanvasRows = SqlSchema.findAll({
    Request: Schema.Void, Result: Schema.Struct({ canvas_name: Schema.String }),
    execute: () => sql`SELECT DISTINCT canvas_name FROM canvas_entities WHERE lifecycle = 'active'`,
  });
  const activeCanvasNames = Effect.fn("CanvasEntitySync.activeCanvasNames")(
    () => activeCanvasRows(undefined).pipe(Effect.map((rows) => new Set(rows.map((row) => row.canvas_name)))),
  );
  return { syncCanvasEntities, archiveAllCanvasEntities, softDeleteCanvasEntity, activeCanvasNames };
});

export class CanvasEntitySync extends Context.Service<CanvasEntitySync, Effect.Success<typeof makeCanvasEntitySync>>()("@junto/CanvasEntitySync") {
  static readonly layer = Layer.effect(CanvasEntitySync, makeCanvasEntitySync);
}
