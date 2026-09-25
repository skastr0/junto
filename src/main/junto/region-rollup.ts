import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { CanvasesService, type CanvasError } from "./canvases";
import { ChatServiceContext, type ChatService } from "./chat/service";
import { SnapshotsService } from "./snapshots";

// Region severity rollups for the RTS bottom bar. Derived per request from
// the document + snapshots + ACP chat plane.
export class RegionRollupService extends Context.Service<RegionRollupService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly rollups: (canvasName: string) => Effect.Effect<ReadonlyArray<RegionRollup>, CanvasError>;
  }>()("@junto/RegionRollupService") {}

export const makeRegionRollupLive = (
  chatService: ChatService,
): Layer.Layer<RegionRollupService, never, CanvasesService | SnapshotsService> =>
  Layer.effect(
    RegionRollupService,
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
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
            const { doc, actorRefs } = yield* canvases.read(canvasName, "region.rollup");
            const state = yield* snapshots.current;

            const agentActivity = new Map<string, AgentActivity>();
            for (const node of doc.nodes) {
              const entity = node.ether?.entity;
              if (entity?.kind !== "agent" || entity.name === undefined) continue;
              agentActivity.set(entity.name, {
                sessionLive: chatService.isLive(entity.name),
                permissionPending: chatService.hasPendingPermission(entity.name),
              });
            }

            return deriveRegionRollups({
              doc,
              ...executionGraphContextFromActorRefs(canvasName, actorRefs),
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
