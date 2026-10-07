import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { digestCanvas, type DigestLiveViews } from "@shared/digest";
import type { SnapshotState } from "@shared/entities";
import type { BoardGlanceTopic, PadGlance, Task } from "@shared/work-model";
import { actorRefResolverFromProjection } from "@shared/graph";
import { withSqlRead } from "../state/sql-read";
import { WorkRepository } from "../work/repository";
import { ModelService } from "./service";
import { ModelActorRefs } from "./actor-refs";

/** A requested digest reads exact sink rows, never mailbox projections. */
export const readModelDigest = Effect.fn("ModelDigest.read")(function* (
  name: string,
  snapshots: SnapshotState,
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
    const padGlances = new Map<string, PadGlance>();
    const boardGlances = new Map<string, { topics: BoardGlanceTopic[]; unread: number }>();
    const sheetSizes = new Map<string, { rows: number; columns: number }>();
    for (const node of canvas.nodes.values()) {
      switch (node.kind) {
        case "task":
        case "requests":
          items.set(node.id, yield* work.taskLane(name, node.id, node.kind));
          break;
        case "artifacts":
          artifactCounts.set(node.id, (yield* work.artifactLane(name, node.id)).length);
          break;
        case "pad": {
          const page = yield* work.sinkPage({ canvasName: name, nodeId: node.id, kind: "pad" });
          if (page.kind === "pad" && page.glance) padGlances.set(node.id, page.glance);
          break;
        }
        case "board": {
          const topics: BoardGlanceTopic[] = [];
          let beforeId: string | undefined;
          do {
            const page = yield* work.sinkPage({ canvasName: name, nodeId: node.id, kind: "board", limit: 200, ...(beforeId ? { beforeId } : {}) });
            if (page.kind !== "board") break;
            topics.push(...page.items);
            beforeId = page.nextBeforeId;
          } while (beforeId !== undefined);
          boardGlances.set(node.id, { topics, unread: topics.reduce((sum, topic) => sum + (topic.unreadPostCount ?? 0), 0) });
          break;
        }
        case "sheet": {
          const grid = yield* model.readSheet(name, node.id);
          if (grid) sheetSizes.set(node.id, { rows: grid.rows.length, columns: grid.columns.length });
          break;
        }
      }
    }
    const live: DigestLiveViews = { resolveActorRef: actorRefResolverFromProjection(refs), itemsOf: (id) => items.get(id) ?? [], artifactCounts, padGlances, boardGlances, sheetSizes };
    return digestCanvas(canvas, snapshots, live);
  }));
});
