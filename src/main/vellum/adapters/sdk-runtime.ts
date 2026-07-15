import { Layer, ManagedRuntime } from "effect";
import { TowerSdkLive } from "@skastr0/tower-sdk";
import { QuasarSdkLive } from "@skastr0/quasar-sdk";
import { BoothConfigLive, BoothSdkLive } from "@skastr0/booth-sdk";
import { describeSdkError } from "./sdk-errors";

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
// BoothConfigLive is merged alongside BoothSdkLive (which consumes its own
// internal copy) so adapters can ALSO read the resolved booth base url —
// booth-controls derives absolute media URLs from it, keeping "how booth's
// endpoints resolve" out of the renderer entirely.
export const SdkRuntime = ManagedRuntime.make(
  Layer.mergeAll(TowerSdkLive, QuasarSdkLive, BoothSdkLive, BoothConfigLive),
);

// Every SDK-backed IPC handler must degrade to its own channel's ok:false
// envelope instead of rejecting across IPC — every other channel in ipc.ts
// already behaves this way, and SnapshotsService's `guarded()` (snapshots.ts)
// already isolates the tower/quasar SnapshotBundle path the same way. This is
// the equivalent choke point for tower-browse.ts/quasar.ts's browse/detail/
// comment fetchers, which call SdkRuntime directly and were NOT covered by
// that existing guard.
//
// Each fetchTowerX/fetchQuasarX Effect already folds its OWN typed SDK
// failure (ApiResponseError, QuasarServerError, ...) into ok:false via
// Effect.either — but that only covers the effect the caller wrote.
// SdkRuntime's *own* layer-build step (env/config resolution: a missing
// TOWER_CONTROL_TOKEN fails with MissingApiKeyError, a bad quasar config
// fails with QuasarConfigError) happens inside ManagedRuntime's internal
// `provide()`, OUTSIDE any Effect.either the caller applied — wrapping the
// call site in Effect.either does not protect against it (tower.ts/
// quasar.ts's fetchTowerBundle/fetchQuasarBundle prove this: they wrap with
// Effect.either too, and are only actually safe because snapshots.ts's
// guarded() catches the Promise on top). The layer build is also memoized:
// once it fails, EVERY subsequent SdkRuntime.runPromise call rejects the
// same way until the app restarts.
//
// `runSdkGuarded` is the single catch point: it runs the caller's Promise
// and folds ANY rejection — a layer-build failure or a genuine defect,
// neither of which is a typed SDK error Effect.either could already have
// caught — into that channel's own result shape via `fallback`.
export const runSdkGuarded = async <A>(
  run: () => Promise<A>,
  fallback: (error: string) => A,
): Promise<A> => {
  try {
    return await run();
  } catch (error) {
    return fallback(describeSdkError(error));
  }
};
