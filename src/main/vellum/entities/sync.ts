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
import type { StateWriter } from "../state/service";

/** The registry columns this view maintains, read once per sync. */
type EntityRow = {
  readonly entity_id: string;
  readonly kind: string | null;
  readonly binding_id: string | null;
  readonly lifecycle: string;
};

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

/**
 * Sync entity registry for one canvas after an authorial document commit.
 * Must run in the same transaction as the canvas write.
 */
export const syncCanvasEntities = (
  writer: StateWriter,
  canvasName: string,
  nextDoc: CanvasDoc,
  now: string,
): void => {
  // Desired registry state. A later duplicate node id overwrites an earlier
  // one, which is how the previous per-node upsert loop resolved them too;
  // binding claims stay first-wins across the whole document.
  const desired = new Map<string, DesiredEntity>();
  const claimedBindings = new Set<string>();
  for (const node of nextDoc.nodes) {
    let bindingId = nodeBindingId(node);
    if (bindingId !== null) {
      if (claimedBindings.has(bindingId)) {
        bindingId = null;
      } else {
        claimedBindings.add(bindingId);
      }
    }
    desired.set(node.id, { kind: nodeKind(node), bindingId });
  }

  // The whole current view for this canvas in one read. Archived and
  // soft_deleted rows are included: re-membership has to see them to
  // reactivate, and a stale row is only detectable against what is stored.
  const rows = new Map<string, EntityRow>();
  for (const row of writer.all<EntityRow>(
    `
      SELECT entity_id, kind, binding_id, lifecycle
      FROM canvas_entities
      WHERE canvas_name = ?
    `,
    [canvasName],
  )) {
    rows.set(row.entity_id, row);
  }

  // Who holds each binding once this document is applied.
  const nextHolder = new Map<string, string>();
  for (const [entityId, entity] of desired) {
    if (entity.bindingId !== null) nextHolder.set(entity.bindingId, entityId);
  }

  // Free the active-only unique binding index only where a binding actually
  // changes hands between two rows that both stay active. A departing row
  // frees its binding by leaving the partial index in the archive pass below,
  // so departures never need the pre-clear.
  for (const [entityId, row] of rows) {
    if (row.lifecycle !== "active" || row.binding_id === null) continue;
    const entity = desired.get(entityId);
    if (entity === undefined || entity.bindingId === row.binding_id) continue;
    const successor = nextHolder.get(row.binding_id);
    if (successor === undefined || successor === entityId) continue;
    writer.run(
      `
        UPDATE canvas_entities
        SET
          binding_id = NULL,
          updated_at = ?
        WHERE canvas_name = ?
          AND entity_id = ?
          AND lifecycle = 'active'
      `,
      [now, canvasName, entityId],
    );
  }

  for (const [entityId, row] of rows) {
    if (row.lifecycle !== "active" || desired.has(entityId)) continue;
    writer.run(
      `
        UPDATE canvas_entities
        SET
          lifecycle = 'archived',
          updated_at = ?,
          archived_at = ?,
          soft_deleted_at = NULL
        WHERE canvas_name = ?
          AND entity_id = ?
          AND lifecycle = 'active'
      `,
      [now, now, canvasName, entityId],
    );
  }

  // The dirty set: a row is written only when it is absent, not active, or
  // holds a different kind or binding than the document asks for.
  for (const [entityId, entity] of desired) {
    const row = rows.get(entityId);
    if (
      row !== undefined &&
      row.lifecycle === "active" &&
      row.kind === entity.kind &&
      row.binding_id === entity.bindingId
    ) {
      continue;
    }
    writer.run(
      `
        INSERT INTO canvas_entities(
          canvas_name,
          entity_id,
          kind,
          binding_id,
          lifecycle,
          created_at,
          updated_at,
          archived_at,
          soft_deleted_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL)
        ON CONFLICT(canvas_name, entity_id) DO UPDATE SET
          kind = excluded.kind,
          binding_id = excluded.binding_id,
          lifecycle = 'active',
          updated_at = excluded.updated_at,
          archived_at = NULL,
          soft_deleted_at = NULL
      `,
      [canvasName, entityId, entity.kind, entity.bindingId, now, now],
    );
  }
};

/** Archive every active entity on a canvas (canvas remove). */
export const archiveAllCanvasEntities = (
  writer: StateWriter,
  canvasName: string,
  now: string,
): void => {
  writer.run(
    `
      UPDATE canvas_entities
      SET
        lifecycle = 'archived',
        updated_at = ?,
        archived_at = COALESCE(archived_at, ?),
        soft_deleted_at = NULL
      WHERE canvas_name = ?
        AND lifecycle = 'active'
    `,
    [now, now, canvasName],
  );
};

/**
 * Soft-delete an archived entity. Active entities cannot soft-delete
 * (must archive first — off-canvas). Soft-deleted is unindexed for historic search.
 */
export const softDeleteCanvasEntity = (
  writer: StateWriter,
  canvasName: string,
  entityId: string,
  now: string,
): "soft_deleted" | "not_archived" | "missing" => {
  const row = writer.get<{ readonly lifecycle: string }>(
    `
      SELECT lifecycle
      FROM canvas_entities
      WHERE canvas_name = ?
        AND entity_id = ?
    `,
    [canvasName, entityId],
  );
  if (row === undefined) return "missing";
  if (row.lifecycle !== "archived") return "not_archived";
  writer.run(
    `
      UPDATE canvas_entities
      SET
        lifecycle = 'soft_deleted',
        updated_at = ?,
        soft_deleted_at = ?
      WHERE canvas_name = ?
        AND entity_id = ?
        AND lifecycle = 'archived'
    `,
    [now, now, canvasName, entityId],
  );
  return "soft_deleted";
};
