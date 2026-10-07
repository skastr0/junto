import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { ModelService } from "./model/service";
import { ModelActorRefs } from "./model/actor-refs";
import { WorkRepository, type WorkRepositoryError } from "./work/repository";
import type { ModelError } from "./model/records";
import { ChatServiceContext, type ChatService } from "./chat/service";
import { SnapshotsService } from "./snapshots";

// Region severity rollups for the RTS bottom bar. Derived per request from
// model rows, Work attention rows, snapshots, and the ACP chat plane.
export class RegionRollupService extends Context.Service<RegionRollupService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly rollups: (canvasName: string) => Effect.Effect<ReadonlyArray<RegionRollup>, ModelError | WorkRepositoryError>;
  }>()("@junto/RegionRollupService") {}

export const makeRegionRollupLive = (
  chatService: ChatService,
): Layer.Layer<RegionRollupService, never, ModelService | ModelActorRefs | WorkRepository | SnapshotsService> =>
  Layer.effect(
    RegionRollupService,
    Effect.gen(function* () {
      const model = yield* ModelService;
      const actorRefs = yield* ModelActorRefs;
      const work = yield* WorkRepository;
      const snapshots = yield* SnapshotsService;

      return RegionRollupService.of({
        doctor: Effect.succeed({
          id: "region-rollup",
          label: "Region Rollups",
          status: "ok",
          detail: "region severity rollups over canvas + snapshots + chat",
        }),

        rollups: (canvasName) =>
          Effect.gen(function* () {
            const canvas = yield* model.canvas(canvasName);
            const refs = yield* actorRefs.read(canvasName);
            const rows = yield* work.attentionItems({ canvasName });
            const byNode = new Map<string, Array<(typeof rows)[number]["item"]>>();
            for (const row of rows) {
              const items = byNode.get(row.nodeId) ?? [];
              items.push(row.item);
              byNode.set(row.nodeId, items);
            }
            const itemsOf = (nodeId: string) => byNode.get(nodeId) ?? [];
            const state = yield* snapshots.current;

            const agentActivity = new Map<string, AgentActivity>();
            for (const node of canvas.nodes.values()) {
              if (node.kind !== "agent") continue;
              agentActivity.set(node.agentKey, {
                sessionLive: chatService.isLive(node.agentKey),
                permissionPending: chatService.hasPendingPermission(node.agentKey),
              });
            }

            return deriveRegionRollups({
              canvas,
              ...executionGraphContextFromActorRefs(canvasName, refs, itemsOf),
              snapshots: state,
              agentActivity,
            });
          }),
      });
    }),
  );

export const RegionRollupLive = Layer.unwrap(
  Effect.map(ChatServiceContext, (chat) => makeRegionRollupLive(chat)),
);
