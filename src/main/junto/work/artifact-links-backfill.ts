/**
 * The artifact body links of bodies written before the projection existed
 * (0.11, 02): a marker-gated walk over every canvas, rebuilding each
 * artifact's rows from the body its head version holds. Completeness lives in
 * install-ops.db, never in a product row; a failure leaves the marker pending
 * and the walk resumes on the next boot. Idempotent: the rebuild replaces an
 * artifact's rows, so a second boot writes the same table.
 */
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { BACKFILL_ARTIFACT_LINKS_V1 } from "../install-ops/engine";
import type { InstallOpsServiceError, InstallOpsServiceShape } from "../install-ops/service";
import { rebuildBodyLinks } from "./body-links";

export type ArtifactLinksBackfillReport = {
  readonly status: "complete" | "already-complete";
  /** Link rows written, or the count the completed marker holds. */
  readonly rows: number;
};

export const runArtifactLinksBackfill = Effect.fn("work.runArtifactLinksBackfill")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly installOps: InstallOpsServiceShape;
}): Effect.fn.Return<ArtifactLinksBackfillReport, SqlError.SqlError | InstallOpsServiceError> {
  const { sql, installOps } = input;
  const marker = yield* installOps.getBackfill(BACKFILL_ARTIFACT_LINKS_V1);
  if (marker?.status === "complete") return { status: "already-complete" as const, rows: marker.objectsIngested };

  yield* installOps.ensurePending(BACKFILL_ARTIFACT_LINKS_V1);
  // The canvases the store actually holds artifacts for: the walk's subject is
  // the rows, not the canvas list, and a canvas row it cannot see is no reason
  // to leave a body unprojected.
  const canvases = yield* sql.unsafe<{ readonly canvas_name: string }>(
    "SELECT DISTINCT canvas_name FROM artifact_heads ORDER BY canvas_name",
  );
  let rows = 0;
  for (const canvas of canvases) rows += yield* rebuildBodyLinks(sql, canvas.canvas_name);
  yield* installOps.markComplete(BACKFILL_ARTIFACT_LINKS_V1, rows);
  return { status: "complete" as const, rows };
});
