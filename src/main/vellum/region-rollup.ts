import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { buildGlyphView, projectsNeedingGlyphs } from "@shared/glyph-view";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { fetchTowerBrowse } from "./adapters/tower-browse";
import { CanvasesService, type CanvasError } from "./canvases";
import type { ChatService } from "./chat/service";
import { SnapshotsService } from "./snapshots";

// Region severity rollups for the RTS bottom bar (shared/region-rollup.ts is
// the contract; this is the live app-side binding). Derived per request from
// the current document + snapshot plane + the ACP chat plane: chatService
// fills the AgentActivity seam (sessionLive / permissionPending) that the
// headless digest deliberately leaves empty.
export class RegionRollupService extends Context.Tag("@vellum/RegionRollupService")<
  RegionRollupService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly rollups: (canvasName: string) => Effect.Effect<ReadonlyArray<RegionRollup>, CanvasError>;
  }
>() {}

// A layer factory (not a bare Layer) for the same reason as KernelLive: the
// shared ChatService instance is constructed once in runtime.ts and passed
// in, so rollup activity reads the same live ACP sessions as chat + pulses.
export const RegionRollupLive = (
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
            const { doc } = yield* canvases.read(canvasName);
            const state = yield* snapshots.current;

            // Same glyph policy as exportDigest / scripts/digest.ts: only
            // complete, non-partial tower browse results feed the derivation.
            const fetched = new Map<string, Awaited<ReturnType<typeof fetchTowerBrowse>>>();
            for (const project of projectsNeedingGlyphs(doc)) {
              fetched.set(project, yield* Effect.promise(() => fetchTowerBrowse(project)));
            }
            const glyphs = buildGlyphView(doc, fetched);

            // AgentActivity seam, filled from the ACP chat plane. Every agent
            // node reports its real state; absent activity derives nothing.
            const agentActivity = new Map<string, AgentActivity>();
            for (const node of doc.nodes) {
              const entity = node.ether?.entity;
              if (entity?.kind !== "agent" || entity.name === undefined) continue;
              agentActivity.set(entity.name, {
                sessionLive: chatService.isLive(entity.name),
                permissionPending: chatService.hasPendingPermission(entity.name),
              });
            }

            return deriveRegionRollups({ doc, snapshots: state, glyphs, agentActivity });
          }),
      });
    }),
  );
