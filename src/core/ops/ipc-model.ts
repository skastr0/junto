/**
 * The core's handlers of the model group (src/contract/core/model.ts): the
 * canvas list, a canvas opened, a command, the compiled actor refs. Main
 * decoded the renderer's arguments at its edge; a failure here crosses as
 * its words, which the window shows.
 */
import { Effect } from "effect";
import { ModelFailed, ModelRpcs } from "../../contract/core/model";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { commandReleasingSeats } from "../work/seat-release";

/** A model failure as the window reads it: its message, or its tag when it has none. */
const failed = (error: unknown): ModelFailed => {
  const message = error instanceof Error ? error.message : String(error);
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "the model failed";
  return new ModelFailed({ message: message.length > 0 ? message : tag });
};

export const ModelHandlers = ModelRpcs.toLayer({
  ModelCanvases: () => Effect.flatMap(ModelService, (model) => model.listCanvasSummaries()).pipe(Effect.mapError(failed)),
  ModelOpen: ({ canvas }) => Effect.flatMap(ModelService, (model) => model.open(canvas)).pipe(Effect.mapError(failed)),
  // A seat the command removes lets go of its task, and one it restores takes it back (seat-release.ts).
  ModelCommand: ({ command }) => commandReleasingSeats(command, "operator").pipe(Effect.mapError(failed)),
  ModelActorRefs: ({ canvas }) => Effect.flatMap(ModelActorRefs, (refs) => refs.read(canvas)).pipe(Effect.mapError(failed)),
});
