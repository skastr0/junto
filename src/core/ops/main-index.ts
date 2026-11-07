import { Effect, Scope } from "effect";
import type { PreambleEvent } from "@shared/preamble";
import { ContentService } from "../content/service";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { PausePlane } from "../pause-plane";
import { resolveNodeRef, type NodeRefResolutionError } from "../node-ref-resolver";
import { onAgentSignalChanged } from "../signals/changes";
import { checkSeatPageBox, postSeatPageShot } from "../work/page-box-comment";
import { CorePushes, publish } from "../push";
import { AGENT_SIGNAL_CHANGED, CANVAS_CHANGED, WORK_PREAMBLE } from "../../contract/core/channels";
import {
  MainIndexContentUnreadable,
  MainIndexModelUnavailable,
  MainIndexNodeRefUnresolved,
  MainIndexRpcs,
} from "../../contract/core/main-index";

/**
 * The window's broadcasts from a core in its own process: each signal change
 * is published as it happens, and the work control server's preamble hook
 * publishes too. Returns that hook, and the stop for the signal subscription.
 * Core boot calls it before any server exists (`src/core/entry.ts`), so it
 * publishes through the port boot chose.
 */
export const publishWindowBroadcasts = (): { readonly onPreamble: (event: PreambleEvent) => void; readonly stop: () => void } => ({
  onPreamble: (event) => publish(WORK_PREAMBLE, event),
  stop: onAgentSignalChanged((signal) => publish(AGENT_SIGNAL_CHANGED, signal)),
});

/** Why a ref named nothing, in the words the link's opener is told. */
const unresolved = (error: NodeRefResolutionError): MainIndexNodeRefUnresolved => {
  const { canvasName, nodeId } = error.ref;
  switch (error._tag) {
    case "InvalidNodeRef":
    case "CanvasReadError":
      return new MainIndexNodeRefUnresolved({ reason: error._tag, message: error.message });
    case "CanvasNotFound":
      return new MainIndexNodeRefUnresolved({ reason: error._tag, message: `no canvas named ${canvasName}` });
    case "NodeNotFound":
      return new MainIndexNodeRefUnresolved({ reason: error._tag, message: `no node ${nodeId} on ${canvasName}` });
    case "NodeKindMismatch":
      return new MainIndexNodeRefUnresolved({
        reason: error._tag,
        message: `node ${nodeId} on ${canvasName} is ${error.actual ?? "of no kind"}, not ${error.expected}`,
      });
  }
};

const modelUnavailable = (error: { readonly message: string }) => new MainIndexModelUnavailable({ message: error.message });

/**
 * The core's handlers of the main-index group (src/contract/core/main-index.ts):
 * what `src/app/index.ts` asks the core on a request. The canvas watch
 * publishes through `CorePushes`, subscribed once per server on its first
 * ask, and the subscriptions end with the server.
 */
export const MainIndexHandlers = MainIndexRpcs.toLayer(
  Effect.gen(function* () {
    const model = yield* ModelService;
    const records = yield* ModelRecords;
    const pause = yield* PausePlane;
    const pushes = yield* CorePushes;
    const scope = yield* Scope.Scope;

    // Every canvas change and removal is published with the document as it is now.
    const watching = yield* Effect.cached(
      Effect.all([
        Effect.acquireRelease(
          Effect.sync(() =>
            model.subscribeChanges((event, next) => Effect.runSync(pushes.publish(CANVAS_CHANGED, { canvas: event.canvas, next })))),
          (stop) => Effect.sync(stop),
        ),
        Effect.acquireRelease(
          Effect.sync(() =>
            model.subscribeCanvasesChanges((event) => {
              if (event._tag === "Removed") Effect.runSync(pushes.publish(CANVAS_CHANGED, { canvas: event.canvas, next: undefined }));
            })),
          (stop) => Effect.sync(stop),
        ),
      ]).pipe(Effect.asVoid, Scope.provide(scope)),
    );

    return {
      MainIndexResolveNodeRef: ({ ref }) =>
        resolveNodeRef(model, ref).pipe(
          Effect.map(({ key }) => ({ key })),
          Effect.mapError(unresolved),
        ),
      MainIndexCanvases: () =>
        Effect.gen(function* () {
          const names = yield* model.listCanvases();
          return yield* Effect.forEach(names, (name) => Effect.map(model.canvas(name), (doc) => ({ name, doc })));
        }).pipe(Effect.mapError(modelUnavailable)),
      MainIndexEditsCanvas: ({ canvasName }) => records.editsCanvas(canvasName).pipe(Effect.mapError(modelUnavailable)),
      MainIndexWatchCanvases: () => watching,
      MainIndexCanvasPlaying: ({ canvas }) => Effect.sync(() => pause.stateFor(canvas).playing),
      MainIndexOpenForRead: ({ ref }) =>
        Effect.flatMap(ContentService, (content) => content.openForRead(ref)).pipe(
          Effect.mapError((error) => new MainIndexContentUnreadable({ message: error.message })),
        ),
      MainIndexPageBoxCheck: (request) => checkSeatPageBox(request),
      MainIndexPageBoxPost: ({ request, shot }) => postSeatPageShot(request, shot),
    };
  }),
);
