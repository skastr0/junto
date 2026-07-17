import { Layer } from "effect";
import { CodexBarSourcesLive } from "./codexbar-source";
import { UsageServiceLive } from "./usage-service";

// Composition root of the usage plane: the service provided its registry of
// sources as ONE already-composed member (Layer.mergeAll does not thread one
// member's output to satisfy another's requirement — see runtime.ts). A
// future vellum-native source appends to the registry in codexbar-source.ts
// or lands as a sibling registry layer merged here.
export const UsageLive = Layer.provideMerge(UsageServiceLive, CodexBarSourcesLive);
