import { Layer } from "effect";
import { StationUsageSourcesLive } from "./native-sources";
import {
  makeOperatorProviderCredentialsLive,
  OperatorProviderCredentials,
} from "./operator-credentials";
import { UsageCacheLive } from "./usage-cache";
import { UsageServiceLive } from "./usage-service";

// Composition root of the usage plane: the service provided its registry of
// sources and durable cache as ONE already-composed member (Layer.mergeAll
// does not thread one member's output to satisfy another's requirement — see
// runtime.ts).
//
// Registry = the native strategy pipelines (see native-sources.ts), built
// over the operator provider-credential reader, which itself requires
// SettingsService (the leftover requirement propagates to the composition
// root — see runtime.ts / remote-runtime.ts).
export const UsageLive = Layer.provideMerge(
  Layer.provideMerge(
    Layer.mergeAll(StationUsageSourcesLive, UsageCacheLive),
    makeOperatorProviderCredentialsLive,
  ),
  UsageServiceLive,
);

/** Re-exported for runtimes that must satisfy the SettingsService link. */
export { OperatorProviderCredentials };
