import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { GlyphRow } from "@shared/execution-graph";
import { projectsNeedingGlyphs } from "@shared/glyph-view";
import type { TowerBrowseResult, TowerGlyphRow } from "@shared/ipc";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import { fetchTowerBrowse } from "./adapters/tower-browse";
import { CanvasesService, type CanvasError } from "./canvases";
import type { ChatService } from "./chat/service";
import { resolveGlyphCacheUpdate } from "./kernel/service";
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
export const RegionRollupLive = (
  chatService: ChatService,
  fetchBrowse: GlyphBrowseFetcher = fetchTowerBrowse,
): Layer.Layer<RegionRollupService, never, CanvasesService | SnapshotsService> =>
  Layer.effect(
    RegionRollupService,
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;

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

            // Glyph rows come from the TTL cache; projects the cache cannot
            // answer stay absent from the view (unavailable = derives nothing).
            const glyphs = new Map<string, ReadonlyArray<GlyphRow>>();
            for (const project of projectsNeedingGlyphs(doc)) {
              const rows = yield* Effect.promise(() => glyphRowsFor(project));
              if (rows !== undefined) glyphs.set(project, rows.map(toGlyphRow));
            }

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
