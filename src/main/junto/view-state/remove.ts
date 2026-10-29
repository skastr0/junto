/**
 * The rows a node or canvas delete takes with it (0.11, 04). The FK from each
 * canvas-scoped table to `canvases` cascades the canvas case; this is the
 * explicit pass, and the only pass for a node, since nodes live in one of
 * many kind tables and no single foreign key names one.
 *
 * Shared by `ViewStateRepository` (the IPC write path) and the model delete
 * seam (`model-dependents.ts`), so a node or canvas delete makes one trip.
 */
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";

/** A canvas went: every row keyed by it goes. Machine-wide rows stay. */
export const removeViewCanvas = (
  sql: SqlClient.SqlClient,
  canvas: string,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM view_command_slots WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_command_extras WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_artifacts_filters WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_tasks_filters WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_open_items WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_expanded_folders WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_collapsed_sidebars WHERE canvas_name = ${canvas}`;
    yield* sql`DELETE FROM view_capture_inboxes WHERE canvas_name = ${canvas}`;
  });

/**
 * Nodes went: their rows go, their fixed slots go, and their members leave
 * the groups and the groups past nine. A group whose last member went goes.
 */
export const removeViewNodes = (
  sql: SqlClient.SqlClient,
  canvas: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    if (ids.length === 0) return;
    yield* sql`DELETE FROM view_artifacts_filters WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_tasks_filters WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_open_items WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_expanded_folders WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_collapsed_sidebars WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_capture_inboxes WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_command_slot_members WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
    yield* sql`DELETE FROM view_command_slots WHERE canvas_name = ${canvas}
      AND ((kind = 'fixed' AND ${sql.in("node_id", ids)}) OR (kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM view_command_slot_members member
        WHERE member.canvas_name = view_command_slots.canvas_name AND member.slot = view_command_slots.slot
      )))`;
    yield* sql`DELETE FROM view_command_extras WHERE canvas_name = ${canvas} AND ${sql.in("node_id", ids)}`;
  });
