import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { GlyphRow } from "@shared/execution-graph";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { CanvasesService, type CanvasError } from "./canvases";
import { ChatServiceContext, type ChatService } from "./chat/service";
import { HerdrPlane } from "./herdr/plane";
import { SnapshotsService } from "./snapshots";
import type { WorkSurfaceActivity } from "@shared/terminal";

/** Herdr vocabulary stops at this adapter boundary. */
export const herdrAgentStatusActivity = (status: string): WorkSurfaceActivity => {
  const normalized = status.toLowerCase();
  const harness = normalized === "working" || normalized === "blocked"
    ? normalized
    : normalized === "done"
      ? "attention"
      : normalized === "idle"
        ? "idle"
        : "unknown";
  return { session: "running", harness, source: "herdr" };
};

// Region severity rollups for the RTS bottom bar. Derived per request from
// the document + snapshots + ACP chat plane + herdr mirrors. No private-source
// glyph browse — empty glyphs; agent/herdr activity still live.
export class RegionRollupService extends Context.Tag("@vellum/RegionRollupService")<
  RegionRollupService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly rollups: (canvasName: string) => Effect.Effect<ReadonlyArray<RegionRollup>, CanvasError>;
  }
>() {}

export const makeRegionRollupLive = (
  chatService: ChatService,
): Layer.Layer<RegionRollupService, never, CanvasesService | SnapshotsService | HerdrPlane> =>
  Layer.effect(
    RegionRollupService,
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const herdrPlane = yield* HerdrPlane;

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

            const glyphs = new Map<string, ReadonlyArray<GlyphRow>>();

            const agentActivity = new Map<string, AgentActivity>();
            for (const node of doc.nodes) {
              const entity = node.ether?.entity;
              if (entity?.kind !== "agent" || entity.name === undefined) continue;
              agentActivity.set(entity.name, {
                sessionLive: chatService.isLive(entity.name),
                permissionPending: chatService.hasPendingPermission(entity.name),
              });
            }

            const terminalStatusByNodeId = new Map<string, WorkSurfaceActivity>();
            for (const node of doc.nodes) {
              const herdr = node.ether?.herdr;
              if (herdr?.paneId === undefined || herdr.paneId.length === 0) continue;
              const mirror = herdrPlane.mirrors.mirrorFor(herdr.host);
              if (mirror === undefined) continue;
              const rec = mirror.lookupPane(herdr.paneId);
              if (rec === undefined) continue;
              const status =
                (typeof rec.agent_status === "string" && rec.agent_status) ||
                (typeof rec.agentStatus === "string" && rec.agentStatus) ||
                undefined;
              if (status) terminalStatusByNodeId.set(node.id, herdrAgentStatusActivity(status));
            }

            return deriveRegionRollups({
              doc,
              snapshots: state,
              glyphs,
              agentActivity,
              terminalStatusByNodeId,
            });
          }),
      });
    }),
  );

export const RegionRollupLive = Layer.unwrapEffect(
  Effect.map(ChatServiceContext, (chat) => makeRegionRollupLive(chat)),
);
