import { Context, Effect } from "effect";
import type { UsageSnapshot } from "@shared/usage";

// The IoC seam of the provider usage plane. A UsageSource is a pluggable
// origin of quota data — an ordered strategy pipeline over one provider's
// local credentials and caches. fetch is TOTAL: every failure mode folds
// into the UsageSnapshot envelope (ok:false + reason) so the service and
// the renderer can fail open (hide the bar when nothing is available).
export interface UsageSource {
  readonly id: string;
  // Cheap presence probe (CLI on PATH, credentials resolvable).
  readonly detect: Effect.Effect<boolean>;
  // Primary fetch — must return ASAP so the HUD can paint. Expensive
  // enrichment (e.g. multi-account codex) belongs in `enrich`, not here.
  readonly fetch: Effect.Effect<UsageSnapshot>;
  // Optional second stage after primary is committed. Return undefined to
  // leave the primary snapshot alone.
  readonly enrich?: Effect.Effect<UsageSnapshot | undefined>;
}

// Registry Tag: the composition root contributes the set of sources the
// service fans out over. Tests inject fakes via Layer.succeed(UsageSources,
// [...]) — same pattern as the SDK adapter tests.
/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/UsageSources` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class UsageSources extends Context.Service<UsageSources, ReadonlyArray<UsageSource>>()("@vellum/UsageSources") {}`
 * - Layer today: StationUsageSourcesLive — V4 rename candidates UsageSources.layer*
 *   Do not dual-export Live + `.layer` names.
 */
export class UsageSources extends Context.Service<UsageSources,
  ReadonlyArray<UsageSource>>()("@vellum/UsageSources") {}
