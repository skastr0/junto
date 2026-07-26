import { Layer } from "effect";
import { StationUsageSourcesLive } from "./native-sources";
import { UsageServiceLive } from "./usage-service";

// Composition root of the usage plane: the service provided its registry of
// sources as ONE already-composed member (Layer.mergeAll does not thread one
// member's output to satisfy another's requirement — see runtime.ts).
// Registry = native harness homes (claude/codex/grok/hermes) + optional codexbar.
export const UsageLive = Layer.provideMerge(UsageServiceLive, StationUsageSourcesLive);
