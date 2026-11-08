/**
 * The core's handlers of the work group (src/contract/core/work.ts): one
 * task, the attention snapshot, a page of a node's mail, a seat's recent
 * operations, and the artifacts whose body links one artifact. Main decoded
 * each query at its edge; the answers keep the repository's shapes, which
 * the contract names.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { WorkReadFailed, WorkRpcs } from "../../contract/core/work";
import { linkedFromBodies } from "../work/body-links";
import { WorkRepository } from "../work/repository";
import { WorkService } from "../work/service";

/** A read that failed, in its own words, or its tag when it has none. */
const readFailed = (error: unknown): WorkReadFailed => {
  const message = error instanceof Error ? error.message : String(error);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "the work store could not be read";
  return new WorkReadFailed({ message: message.length > 0 ? message : tag });
};

export const WorkHandlers = WorkRpcs.toLayer({
  WorkItem: (query) => Effect.flatMap(WorkRepository, (work) => work.taskItem(query)).pipe(Effect.mapError(readFailed)),
  WorkAttention: (query) => Effect.flatMap(WorkRepository, (work) => work.attentionSnapshot(query)).pipe(Effect.mapError(readFailed)),
  WorkMailPage: (query) => Effect.flatMap(WorkRepository, (work) => work.mailPage(query)).pipe(Effect.mapError(readFailed)),
  WorkSeatRecentOps: ({ canvas, nodeId, limit }) =>
    Effect.flatMap(WorkService, (work) => work.workSeatRecentOps(canvas, nodeId, limit)),
  WorkArtifactLinks: ({ canvasName, nodeId, artifactId }) =>
    Effect.gen(function* () {
      const read = yield* (yield* WorkService).readTopology(canvasName);
      const sql = yield* SqlClient.SqlClient;
      return yield* linkedFromBodies(sql, read.canvas, canvasName, { nodeId, artifactId });
    }).pipe(Effect.mapError(readFailed)),
});
