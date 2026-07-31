/**
 * Keep canvas_entities aligned with authorial canvas membership.
 *
 * - Every node present in the next doc is upserted as lifecycle=active.
 * - Every previously-active entity missing from the next doc is archived.
 * - soft_deleted rows are never reactivated by absence (only by re-membership).
 * - Re-adding a node id reactivates archived/soft_deleted → active
 *   (operator re-authorship; soft_delete is unindexed hide, not irreversible death).
 *
 * Order for active-only binding uniqueness:
 * 1. clear bindings on active rows that remain (allows co-active swaps)
 * 2. archive departures (frees bindings for replacements)
 * 3. upsert arrivals with final binding_id
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

  const activeRows = writer.all<EntityRow>(
    `
      SELECT canvas_name, entity_id, lifecycle
      FROM canvas_entities
      WHERE canvas_name = ?
        AND lifecycle = 'active'
    `,
    [canvasName],
  );

  // Free active-only unique binding index for in-place swaps before upserts.
  for (const row of activeRows) {
    if (!nextIds.has(row.entity_id)) continue;
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
      [now, canvasName, row.entity_id],
    );
  }

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

  // First-wins within one doc for duplicate binding_id among arrivals.
  const claimedBindings = new Set<string>();
  for (const node of nextDoc.nodes) {
    const kind = nodeKind(node);
    let bindingId = nodeBindingId(node);
    if (bindingId !== null) {
      if (claimedBindings.has(bindingId)) {
        bindingId = null;
      } else {
        claimedBindings.add(bindingId);
      }
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
