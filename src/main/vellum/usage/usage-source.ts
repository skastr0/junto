import { Context, Effect } from "effect";
import type { UsageSnapshot } from "@shared/usage";

// The IoC seam of the provider usage plane. A UsageSource is a pluggable
// origin of quota data. Beta: codexbar only; native harness readers exist
// but are unwired (WIP post-beta). fetch is TOTAL: every failure mode folds
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
export class UsageSources extends Context.Tag("@vellum/UsageSources")<
  UsageSources,
  ReadonlyArray<UsageSource>
>() {}
