import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { digestCanvas, type DigestLiveViews } from "@shared/digest";
import { actorRefResolverFromProjection } from "@shared/graph";
import { withSqlRead } from "../state/sql-read";
import { WorkRepository } from "../work/repository";
import { TaskRepository } from "../work/task-repository";
import { readSeatTaskIndex, readTasksByNode } from "../work/seat-task-read";
import { ModelService } from "./service";
import { ModelActorRefs } from "./actor-refs";

/** A requested digest reads the task store and the artifact rows, never mailbox projections. */
export const readModelDigest = Effect.fn("ModelDigest.read")(function* (
  name: string,
) {
  const model = yield* ModelService;
  const actors = yield* ModelActorRefs;
  const work = yield* WorkRepository;
  const tasks = yield* TaskRepository;
  const sql = yield* SqlClient.SqlClient;
  return yield* withSqlRead(sql, Effect.gen(function* () {
    const canvas = yield* model.canvas(name);
    const refs = yield* actors.read(name);
    const items = yield* readTasksByNode(tasks, canvas);
    const artifactCounts = new Map<string, number>();
    for (const node of canvas.nodes.values()) {
      if (node.kind === "artifacts") artifactCounts.set(node.id, (yield* work.artifactLane(name, node.id)).length);
    }
    const heldBy = yield* readSeatTaskIndex(tasks, canvas);
    const live: DigestLiveViews = { resolveActorRef: actorRefResolverFromProjection(refs), itemsOf: (id) => items.get(id) ?? [], heldBy, artifactCounts };
    return digestCanvas(canvas, live);
  }));
});
