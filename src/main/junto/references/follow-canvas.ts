import { Effect, Layer, Queue } from "effect";
import type { CanvasesChanged, Changed } from "@shared/model";
import { ModelService } from "../model/service";
import { ReferencesRepository, type ReferencesRepositoryError } from "./repository";

/**
 * A region's references follow the canvas. When a region is removed its rows
 * go; when a canvas is removed every region row of it goes. App-wide
 * references and the briefing are never touched.
 *
 * Only an event the model published after a commit deletes anything. There
 * is no sweep: a canvas that cannot be read costs the operator no text, and
 * a row whose region is missing just stays unlisted. Each step is a no-op
 * when its rows are already gone, so a repeated event is harmless.
 */
export type CanvasEventSource = {
  readonly subscribeChanges: (listener: (event: Changed) => void) => () => void;
  readonly subscribeCanvasesChanges: (listener: (event: CanvasesChanged) => void) => () => void;
};

type Step = Changed | CanvasesChanged;

const isCanvasesChanged = (event: Step): event is CanvasesChanged => "_tag" in event;

/** What one event means for the store. */
const apply = (
  store: ReferencesRepository["Service"],
  event: Step,
): Effect.Effect<unknown, ReferencesRepositoryError> => {
  if (!isCanvasesChanged(event)) {
    return event.removedNodes.length === 0 ? Effect.void : store.removeRegions(event.canvas, event.removedNodes);
  }
  return event._tag === "Removed" ? store.removeCanvas(event.canvas) : Effect.void;
};

/**
 * Follow a source of canvas events for as long as the scope lives. Events
 * are applied one at a time in the order they were published; one that
 * fails is logged and left, since the rows it would have removed are never
 * listed anyway.
 */
export const followCanvas = (source: CanvasEventSource) =>
  Effect.gen(function* () {
    const store = yield* ReferencesRepository;
    const steps = yield* Queue.unbounded<Step>();
    const stopChanges = source.subscribeChanges((event) => {
      if (event.removedNodes.length > 0) Queue.offerUnsafe(steps, event);
    });
    const stopCanvases = source.subscribeCanvasesChanges((event) => {
      if (event._tag === "Removed") Queue.offerUnsafe(steps, event);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopChanges();
        stopCanvases();
      }),
    );
    yield* Queue.take(steps).pipe(
      Effect.flatMap((event) =>
        apply(store, event).pipe(
          Effect.catch((error) =>
            Effect.sync(() => console.error("[references] could not follow a canvas change", error.message)),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  });

/** The references store, following the model's canvases. */
export const ReferencesFollowCanvasLive = Layer.effectDiscard(
  Effect.flatMap(ModelService, (model) => followCanvas(model)),
);
