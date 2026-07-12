import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { SnapshotState } from "@shared/entities";
import type { BindingHint } from "@shared/ipc";

// The read-only data plane. Adapters shell out to reference CLIs and
// normalize into SnapshotBundles. refresh never fails: a broken adapter
// yields a bundle with ok:false and an error string, nothing more.
export class SnapshotsService extends Context.Tag("@vellum/SnapshotsService")<
  SnapshotsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<SnapshotState>;
    readonly refresh: (hints?: ReadonlyArray<BindingHint>) => Effect.Effect<SnapshotState>;
    // Begin the background poll loop (cheap lists only). Idempotent.
    readonly start: () => void;
    readonly subscribe: (listener: (state: SnapshotState) => void) => () => void;
  }
>() {}

const emptyState: SnapshotState = { bundles: [] };

// PLACEHOLDER — VL-004 replaces this with the tower/quasar/booth adapters.
export const SnapshotsLive = Layer.succeed(
  SnapshotsService,
  SnapshotsService.of({
    doctor: Effect.succeed({
      id: "snapshots",
      label: "Adapter Snapshots",
      status: "warning",
      detail: "placeholder implementation (VL-004 pending)",
    }),
    current: Effect.succeed(emptyState),
    refresh: () => Effect.succeed(emptyState),
    start: () => {},
    subscribe: () => () => {},
  }),
);
