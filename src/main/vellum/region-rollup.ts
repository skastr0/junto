import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { GlyphRow } from "@shared/execution-graph";
import { canvasProjectKeys } from "@shared/glyph-view";
import type { TowerBrowseResult, TowerGlyphRow } from "@shared/ipc";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { fetchTowerBrowse } from "./adapters/tower-browse";
import { CanvasesService, type CanvasError } from "./canvases";
import { ChatServiceContext, type ChatService } from "./chat/service";
import { HerdrPlane } from "./herdr/plane";
import { resolveGlyphCacheUpdate } from "./kernel/service";
import { SnapshotsService } from "./snapshots";

// Region severity rollups for the RTS bottom bar (shared/region-rollup.ts is
// the contract; this is the live app-side binding). Derived per request from
// the document + snapshots + ACP chat plane + herdr mirrors (when fresh).
export class RegionRollupService extends Context.Tag("@vellum/RegionRollupService")<
  RegionRollupService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly rollups: (canvasName: string) => Effect.Effect<ReadonlyArray<RegionRollup>, CanvasError>;
  }
>() {}

// Glyph browses are TTL-cached per service instance — the same policy as the
// kernel's cachedGlyphFetcher (kernel/service.ts): 15s TTL, and
// resolveGlyphCacheUpdate (reused as-is) keeps partial reads from ever being
// treated as authoritative while a failed refresh falls back to the last
// complete rows. Without this cache, every bottom-bar re-poll would shell
// out one tower browse per project per call.
const GLYPH_CACHE_TTL_MS = 15_000;

export type GlyphBrowseFetcher = (project: string) => Promise<TowerBrowseResult>;

// A layer factory (not a bare Layer) for the same reason as KernelLive: the
// shared ChatService instance is constructed once in runtime.ts and passed
// in, so rollup activity reads the same live ACP sessions as chat + pulses.
// fetchBrowse is injectable for tests; production uses the real adapter.
export const makeRegionRollupLive = (
  chatService: ChatService,
  fetchBrowse: GlyphBrowseFetcher = fetchTowerBrowse,
): Layer.Layer<RegionRollupService, never, CanvasesService | SnapshotsService | HerdrPlane> =>
  Layer.effect(
    RegionRollupService,
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const herdrPlane = yield* HerdrPlane;

      const glyphCache = new Map<
        string,
        { readonly at: number; readonly rows: ReadonlyArray<TowerGlyphRow> }
      >();

      const glyphRowsFor = async (
        project: string,
      ): Promise<ReadonlyArray<TowerGlyphRow> | undefined> => {
        const cached = glyphCache.get(project);
        if (cached && Date.now() - cached.at < GLYPH_CACHE_TTL_MS) return cached.rows;
        try {
          const result = await fetchBrowse(project);
          const { rows, cacheWrite } = resolveGlyphCacheUpdate(result, cached);
          if (cacheWrite !== undefined) glyphCache.set(project, { at: Date.now(), rows: cacheWrite });
          return rows;
        } catch {
          return cached?.rows;
        }
      };

      const toGlyphRow = (row: TowerGlyphRow): GlyphRow => ({
        glyphId: row.glyphId,
        orbit: row.orbit,
        title: row.title,
        state: row.state,
      });

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

            // Glyphs for every project entity on the canvas (not only edge
            // criteria — a board with no edges still has project WIP).
            const glyphs = new Map<string, ReadonlyArray<GlyphRow>>();
            for (const project of canvasProjectKeys(doc)) {
              const rows = yield* Effect.promise(() => glyphRowsFor(project));
              if (rows !== undefined) glyphs.set(project, rows.map(toGlyphRow));
            }

            // ACP chat plane — hermes agent nodes only.
            const agentActivity = new Map<string, AgentActivity>();
            for (const node of doc.nodes) {
              const entity = node.ether?.entity;
              if (entity?.kind !== "agent" || entity.name === undefined) continue;
              agentActivity.set(entity.name, {
                sessionLive: chatService.isLive(entity.name),
                permissionPending: chatService.hasPendingPermission(entity.name),
              });
            }

            // Herdr mirrors — last-known agent_status from pane OR agents map.
            // Uses lookupPane (bootstrapped, not only eventsLive) so rollups
            // match card meta while the event stream reconnects. Never CLI
            // fan-out. Absent/unbootstrapped invents nothing.
            const herdrStatusByNodeId = new Map<string, string>();
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
              if (status) herdrStatusByNodeId.set(node.id, status);
            }

            return deriveRegionRollups({
              doc,
              snapshots: state,
              glyphs,
              agentActivity,
              herdrStatusByNodeId,
            });
          }),
      });
    }),
  );

export const RegionRollupLive = Layer.unwrapEffect(
  Effect.map(ChatServiceContext, (chat) => makeRegionRollupLive(chat)),
);
