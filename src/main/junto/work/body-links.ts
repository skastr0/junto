/**
 * What links an artifact, read from the bodies (plan 0.11, 02, L1).
 *
 * `work_artifact_links` is a projection of every artifact's head body,
 * rewritten in the same transaction as the edit that made it
 * (`artifact-repository.ts`). One row per (source artifact, target mention
 * key): the key is a node and an item, never a title, so a rename changes no
 * row. This read joins the heads for the title and the time, leaves an
 * archived source out, and keeps only targets that are artifacts on the
 * canvas — a document may hold a link to a task, and a task is no backlink.
 *
 * The mail side of "Linked from" is `readMentions` (work/mention-backlinks.ts),
 * a projection of mail rows; the two are shown side by side, never merged here.
 */
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { decodeArtifactBody, type ArtifactType } from "@shared/artifact";
import { bodyLinksOf, type ArtifactLinkRef, type LinkedFromBody } from "@shared/artifact-links";
import { asNodeId } from "@shared/model";
import type { Canvas } from "@shared/model";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
import type { ItemId } from "@shared/work-ids";

/** A row as the table holds it, with the head's facts joined in. */
type LinkedFromRow = {
  readonly node_id: string;
  readonly artifact_id: string;
  readonly title: string;
  readonly type: ArtifactType;
  readonly line: string;
  readonly updated_at: number;
};

const LINKED_FROM_SQL = `
  SELECT heads.node_id AS node_id, heads.artifact_id AS artifact_id, heads.title AS title, heads.type AS type,
         links.line AS line, heads.updated_at AS updated_at
  FROM work_artifact_links links
  JOIN artifact_heads heads
    ON heads.canvas_name = links.canvas_name AND heads.artifact_id = links.source_artifact_id
  WHERE links.canvas_name = ? AND links.target_node_id = ? AND links.target_artifact_id = ?
    AND heads.archived = 0
  ORDER BY heads.updated_at DESC, heads.artifact_id DESC
`;

/**
 * The artifacts whose head body links `target`, newest change first: what
 * "Linked from" lists beside mail. The target must be an artifact on this
 * canvas (its node an Artifacts node holding it); anything else has no body
 * backlinks, and a link that names a task is no backlink however it is typed.
 */
export const linkedFromBodies = (
  sql: SqlClient.SqlClient,
  canvas: Canvas,
  canvasName: string,
  target: ArtifactLinkRef,
): Effect.Effect<ReadonlyArray<LinkedFromBody>, SqlError.SqlError> =>
  Effect.gen(function* () {
    const targetNode = canvas.nodes.get(target.nodeId);
    // A link to a task board, a seat or a page is not a body backlink.
    if (targetNode === undefined || targetNode.kind !== "artifacts") return [];
    const rows = yield* sql.unsafe<LinkedFromRow>(LINKED_FROM_SQL, [canvasName, target.nodeId, target.artifactId]);
    // A source is a body link only while its head still points at that line's
    // artifact; a head that moved to another node is no source of this list.
    return rows.flatMap((row): ReadonlyArray<LinkedFromBody> => {
      const sourceNode = canvas.nodes.get(asNodeId(row.node_id));
      return sourceNode === undefined || sourceNode.kind !== "artifacts"
        ? []
        : [
            {
              source: { nodeId: asNodeId(row.node_id), artifactId: row.artifact_id as ItemId },
              title: row.title,
              type: row.type,
              line: row.line,
              at: row.updated_at,
            },
          ];
    });
  });

/**
 * Rebuild a canvas's link rows from the bodies it holds: every artifact's head
 * version body, read back into `work_artifact_links`. This is the walk a
 * backfill calls once for rows written before the projection existed, and the
 * repair a replica runs when the bodies it was waiting on arrive. A head whose
 * body is not held keeps no rows: a body that cannot be read links nothing.
 * Idempotent: the rows of every artifact it reads are replaced, never added to.
 */
export const rebuildBodyLinks = (sql: SqlClient.SqlClient, canvasName: string): Effect.Effect<number, SqlError.SqlError> =>
  // A walk over rows written before the projection existed (a backfill) or
  // held by a replica: it replaces rows in place and mints no work fact, so it
  // is declared to the seam rather than explained by a journal record.
  sql.withTransaction(
    unjournaledWorkMutationEffect(
      "artifact.links.backfill",
      Effect.gen(function* () {
        const heads = yield* sql.unsafe<{ readonly artifact_id: string; readonly version: number; readonly inline_body_json: string | null }>(
          `SELECT heads.artifact_id AS artifact_id, heads.version AS version, versions.inline_body_json AS inline_body_json
           FROM artifact_heads heads
           LEFT JOIN artifact_versions versions
             ON versions.canvas_name = heads.canvas_name
            AND versions.artifact_id = heads.artifact_id
            AND versions.version = heads.version
           WHERE heads.canvas_name = ?`,
          [canvasName],
        );
        let written = 0;
        for (const head of heads) {
          yield* sql`DELETE FROM work_artifact_links WHERE canvas_name = ${canvasName} AND source_artifact_id = ${head.artifact_id}`;
          if (head.inline_body_json === null) continue;
          const decoded = decodeArtifactBody(JSON.parse(head.inline_body_json) as unknown);
          if (decoded._tag === "Failure") continue;
          for (const link of bodyLinksOf(decoded.success)) {
            yield* sql`
              INSERT INTO work_artifact_links (canvas_name, source_artifact_id, target_node_id, target_artifact_id, line, source_version)
              VALUES (${canvasName}, ${head.artifact_id}, ${link.target.nodeId}, ${link.target.artifactId}, ${link.line}, ${head.version})`;
            written += 1;
          }
        }
        return written;
      }),
    ),
  );
