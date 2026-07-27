import { Layer } from "effect";
import { StationUsageSourcesLive } from "./native-sources";
import { UsageCacheLive } from "./usage-cache";
import { UsageServiceLive } from "./usage-service";

// Composition root of the usage plane: the service provided its registry of
// sources and durable cache as ONE already-composed member (Layer.mergeAll
// does not thread one member's output to satisfy another's requirement — see
// runtime.ts).
// Registry = native harness homes (claude/codex/grok/hermes) + optional codexbar.
export const UsageLive = Layer.provideMerge(
  UsageServiceLive,
  Layer.mergeAll(StationUsageSourcesLive, UsageCacheLive),
);
