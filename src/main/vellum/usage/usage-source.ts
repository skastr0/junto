import { Context, Effect } from "effect";
import type { UsageSnapshot } from "@shared/usage";

// The IoC seam of the provider usage plane. A UsageSource is a pluggable
// origin of quota data (codexbar CLI first; a vellum-native reader later).
// fetch is TOTAL: every failure mode folds into the UsageSnapshot envelope
// (ok:false + reason) so the service and the renderer can fail open.
export interface UsageSource {
  readonly id: string;
  // Cheap presence probe (CLI on PATH, credentials resolvable).
  readonly detect: Effect.Effect<boolean>;
  readonly fetch: Effect.Effect<UsageSnapshot>;
}

// Registry Tag: the composition root contributes the set of sources the
// service fans out over. Tests inject fakes via Layer.succeed(UsageSources,
// [...]) — same pattern as the SDK adapter tests.
export class UsageSources extends Context.Tag("@vellum/UsageSources")<
  UsageSources,
  ReadonlyArray<UsageSource>
>() {}
