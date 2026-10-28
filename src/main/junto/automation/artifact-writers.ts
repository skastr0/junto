/**
 * Which artifacts an automation wrote last (loop safety, 0.10/07): an edit or
 * a label change is a new head or a new label set the poll sees, with no
 * author on the row, so the runner asks the rulings. An artifact whose last
 * applied ruling on this machine was an automation's fires nothing.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** How far back the read looks, newest first: a pass sees only what changed since the last one. */
const RULINGS_READ = 2_000;

export const artifactsWrittenByAutomation = (
  sql: SqlClient.SqlClient,
  canvasName: string,
  artifactIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>> => {
  if (artifactIds.length === 0) return Effect.succeed(new Set());
  const wanted = new Set(artifactIds);
  return sql<{ readonly artifact_id: string | null; readonly actor_kind: string }>`
    SELECT json_extract(r.ruling_json, '$.artifactId') AS artifact_id, r.actor_kind AS actor_kind
    FROM work_events AS e
    JOIN resource_rulings AS r ON r.canvas_name = e.item_canvas_name AND r.op_id = e.item_id
    WHERE e.item_kind = 'ruling' AND e.item_canvas_name = ${canvasName} AND r.kind = 'applied'
      AND json_extract(r.ruling_json, '$.artifactId') IS NOT NULL
    ORDER BY length(e.seq) DESC, e.seq DESC
    LIMIT ${RULINGS_READ}
  `.pipe(
    Effect.map((rows) => {
      const seen = new Set<string>();
      const automated = new Set<string>();
      for (const row of rows) {
        const id = row.artifact_id;
        if (id === null || !wanted.has(id) || seen.has(id)) continue;
        seen.add(id);
        if (row.actor_kind === "automation") automated.add(id);
      }
      return automated as ReadonlySet<string>;
    }),
    // Unreadable: no write is known to be an automation's, as before this read existed.
    Effect.orElseSucceed(() => new Set<string>()),
  );
};
