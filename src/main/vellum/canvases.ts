import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary } from "@shared/ipc";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

export const canvasesDir = () => join(homedir(), ".vellum", "canvases");

// The document plane. All writes go through validate -> mirror law ->
// canonical serialize -> atomic write (tmp + rename). The watcher reports
// external edits only: writes made through this service must not echo.
export class CanvasesService extends Context.Tag("@vellum/CanvasesService")<
  CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    readonly read: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    readonly write: (name: string, doc: CanvasDoc) => Effect.Effect<void, CanvasError>;
    readonly create: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    // Creates the seed canvas when the canvases dir is empty. Called at startup.
    readonly ensureSeed: Effect.Effect<void, CanvasError>;
    // Writes a sidecar file next to the canvas (e.g. digest). Returns its path.
    readonly writeSidecar: (
      name: string,
      suffix: string,
      contents: string,
    ) => Effect.Effect<string, CanvasError>;
    // Begin watching the canvases dir. Idempotent.
    readonly start: () => void;
    readonly subscribeChanges: (listener: (name: string) => void) => () => void;
  }
>() {}

// PLACEHOLDER — VL-002 replaces this with the real filesystem implementation.
export const CanvasesLive = Layer.succeed(
  CanvasesService,
  CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvas Documents",
      status: "warning",
      detail: "placeholder implementation (VL-002 pending)",
    }),
    list: Effect.succeed([]),
    read: (name) => Effect.fail(new CanvasError({ message: `not implemented: read ${name}` })),
    write: () => Effect.void,
    create: (name) => Effect.fail(new CanvasError({ message: `not implemented: create ${name}` })),
    ensureSeed: Effect.void,
    writeSidecar: () => Effect.fail(new CanvasError({ message: "not implemented" })),
    start: () => {},
    subscribeChanges: () => () => {},
  }),
);
