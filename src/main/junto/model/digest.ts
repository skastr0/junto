import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { digestCanvas, type DigestLiveViews } from "@shared/digest";
import type { Task } from "@shared/work-model";
import { actorRefResolverFromProjection } from "@shared/graph";
import { withSqlRead } from "../state/sql-read";
import { WorkRepository } from "../work/repository";
import { ModelService } from "./service";
import { ModelActorRefs } from "./actor-refs";

/** A requested digest reads exact sink rows, never mailbox projections. */
export const readModelDigest = Effect.fn("ModelDigest.read")(function* (
  name: string,
) {
  const model = yield* ModelService;
  const actors = yield* ModelActorRefs;
  const work = yield* WorkRepository;
  const sql = yield* SqlClient.SqlClient;
  return yield* withSqlRead(sql, Effect.gen(function* () {
    const canvas = yield* model.canvas(name);
    const refs = yield* actors.read(name);
    const items = new Map<string, readonly Task[]>();
    const artifactCounts = new Map<string, number>();
    for (const node of canvas.nodes.values()) {
      switch (node.kind) {
        case "task":
        case "requests":
          items.set(node.id, yield* work.taskLane(name, node.id, node.kind));
          break;
        case "artifacts":
          artifactCounts.set(node.id, (yield* work.artifactLane(name, node.id)).length);
          break;
      }
    }
    const live: DigestLiveViews = { resolveActorRef: actorRefResolverFromProjection(refs), itemsOf: (id) => items.get(id) ?? [], artifactCounts };
    return digestCanvas(canvas, live);
  }));
});
