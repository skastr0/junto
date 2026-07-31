/**
 * Keep canvas_entities aligned with authorial canvas membership.
 *
 * - Every node present in the next doc is upserted as lifecycle=active.
 * - Every previously-active entity missing from the next doc is archived.
 * - soft_deleted rows are never reactivated by absence (only by re-membership).
 * - Re-adding a node id reactivates archived/soft_deleted → active.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { StateWriter } from "../state/service";

type EntityRow = {
  readonly canvas_name: string;
  readonly entity_id: string;
  readonly lifecycle: string;
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
  const nextIds = new Set(nextDoc.nodes.map((node) => node.id));

  // Archive departures first so active-only binding uniqueness can free a
  // binding for a replacement node in the same write.
  const activeRows = writer.all<EntityRow>(
    `
      SELECT canvas_name, entity_id, lifecycle
      FROM canvas_entities
      WHERE canvas_name = ?
        AND lifecycle = 'active'
    `,
    [canvasName],
  );

  for (const row of activeRows) {
    if (nextIds.has(row.entity_id)) continue;
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
      [now, now, canvasName, row.entity_id],
    );
  }

  for (const node of nextDoc.nodes) {
    const kind = nodeKind(node);
    const bindingId = nodeBindingId(node);
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
      [canvasName, node.id, kind, bindingId, now, now],
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
