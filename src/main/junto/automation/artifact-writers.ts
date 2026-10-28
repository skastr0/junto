/**
 * Which artifacts an automation wrote last (loop safety, 0.10/07): an edit or
 * a label change is a new head or a new label set the poll sees, with no
 * author on the row, so the runner asks the rulings. An artifact whose last
 * applied ruling on this machine was an automation's fires nothing.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/**
 * Asked per artifact a pass saw change, a handful at a time: the newest
 * applied ruling on each, however many rulings the canvas took since. A read
 * that fails says every one of them was an automation's: a person's write it
 * hides is missed, which is the safer loss, and an automation never fires on
 * its own write.
 */
export const artifactsWrittenByAutomation = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  artifactIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>> => {
  if (artifactIds.length === 0) return Effect.succeed(new Set());
  return Effect.forEach(
    [...new Set(artifactIds)],
    (artifactId) =>
      sql<{ readonly actor_kind: string }>`
        SELECT r.actor_kind AS actor_kind
        FROM work_events AS e
        JOIN resource_rulings AS r ON r.canvas_name = e.item_canvas_name AND r.op_id = e.item_id
        WHERE e.item_kind = 'ruling' AND e.item_canvas_name = ${canvasName} AND r.kind = 'applied'
          AND json_extract(r.ruling_json, '$.artifactId') = ${artifactId}
        ORDER BY length(e.seq) DESC, e.seq DESC
        LIMIT 1
      `.pipe(Effect.map((rows) => (rows[0]?.actor_kind === "automation" ? [artifactId] : []))),
  ).pipe(
    Effect.map((written) => new Set(written.flat()) as ReadonlySet<string>),
    Effect.catchCause((cause) =>
      Effect.logWarning("automation: the rulings could not say who wrote changed artifacts; none of them fires", cause).pipe(
        Effect.as(new Set(artifactIds) as ReadonlySet<string>),
      ),
    ),
  );
};
