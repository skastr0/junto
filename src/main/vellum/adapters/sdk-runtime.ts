import { Layer, ManagedRuntime } from "effect";
import { TowerSdkLive } from "@skastr0/tower-sdk";
import { QuasarSdkLive } from "@skastr0/quasar-sdk";

// A small, dedicated runtime for the tower/quasar SDK clients — deliberately
// NOT the app's shared AppRuntime (../../runtime). Reaching into AppRuntime
// from these adapters would import runtime.ts, which in turn imports
// snapshots.ts, which imports these same adapters — a circular dependency
// cluster (flagged by pulsar: TS-AD-02-circular-dependencies) that also
// entangles three read-only HTTP-client adapters with the entire app's
// unrelated service graph (Store/Folder/Prism/Codex/Canvases/Kernel) just to
// reach two stateless HTTP clients. TowerSdkLive/QuasarSdkLive are each
// fully-resolved convenience layers (client + config + FetchHttpClient, zero
// remaining requirements) — this is the "one shared X" instance for the
// adapter plane specifically, same idiom as chatService in runtime.ts, just
// scoped to what actually needs it.
export const SdkRuntime = ManagedRuntime.make(Layer.mergeAll(TowerSdkLive, QuasarSdkLive));
