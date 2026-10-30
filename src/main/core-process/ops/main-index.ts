import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ContentRef } from "@shared/content";
import type { AgentSignal } from "@shared/agent-signals";
import type { Canvas } from "@shared/model";
import { redactProvidersForIpc, type Settings } from "@shared/settings";
import type { PreambleEvent } from "@shared/preamble";
import { ContentService, type ContentOpenForRead } from "../../junto/content/service";
import { ModelRecords } from "../../junto/model/records";
import { ModelService } from "../../junto/model/service";
import { PausePlane } from "../../junto/pause-plane";
import { resolveNodeRef, type ResolvedNodeRef } from "../../junto/node-ref-resolver";
import { SettingsService } from "../../junto/settings/service";
import { AgentSignalRepository } from "../../junto/signals/repository";
import { onAgentSignalChanged } from "../../junto/signals/changes";
import { carryFileThreads } from "../../junto/work/file-thread-paths";
import {
  checkSeatPageBox,
  postSeatPageShot,
  type SeatPageBoxTarget,
  type SeatPageShot,
} from "../../junto/work/page-box-comment";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";
import {
  AGENT_SIGNAL_CHANGED,
  CANVAS_CHANGED,
  type CanvasChangedPush,
  SETTINGS_CHANGED,
  WORK_PREAMBLE,
} from "../channels";

/**
 * What `src/main/index.ts` asks the core on a request: a node ref, the
 * settings, a content read, a file move's threads, the raised hands, the
 * canvases for an edge grant, and a seat's box comment either side of the
 * shot main takes.
 */

/**
 * The window's broadcasts from a core in its own process: each signal change
 * is published as it happens, and the work control server's preamble hook
 * publishes too. Returns that hook, and the stop for the signal subscription.
 */
export const publishWindowBroadcasts = (): { readonly onPreamble: (event: PreambleEvent) => void; readonly stop: () => void } => ({
  onPreamble: (event) => publish(WORK_PREAMBLE, event),
  stop: onAgentSignalChanged((signal) => publish(AGENT_SIGNAL_CHANGED, signal)),
});

type PageBoxPosted = Effect.Success<ReturnType<typeof postSeatPageShot>>;

declare module "../ops" {
  interface CoreOps {
    "model.resolveNodeRef": CoreOp<{ readonly ref: Parameters<typeof resolveNodeRef>[1] }, ResolvedNodeRef>;
    "model.canvases": CoreOp<Record<string, never>, ReadonlyArray<{ readonly name: string; readonly doc: Canvas }>>;
    "model.editsCanvas": CoreOp<{ readonly canvasName: string }, boolean>;
    "settings.read": CoreOp<Record<string, never>, Settings>;
    "settings.watch": CoreOp<Record<string, never>, void>;
    "model.watchCanvases": CoreOp<Record<string, never>, void>;
    /** A canvas's play state as the pause plane holds it now. */
    "pause.playing": CoreOp<{ readonly canvas: string }, boolean>;
    "content.openForRead": CoreOp<{ readonly ref: ContentRef }, ContentOpenForRead>;
    "files.carryThreads": CoreOp<
      { readonly canvasName: string; readonly nodeId: string; readonly from: string; readonly to: string },
      void
    >;
    "signals.raisedHands": CoreOp<Record<string, never>, ReadonlyArray<AgentSignal>>;
    "pageBox.check": CoreOp<SeatPageBoxTarget, Effect.Success<ReturnType<typeof checkSeatPageBox>>>;
    "pageBox.post": CoreOp<{ readonly request: SeatPageBoxTarget; readonly shot: SeatPageShot }, PageBoxPosted>;
  }
}

let watchingSettings = false;
let watchingCanvases = false;

coreOps({
  "model.resolveNodeRef": ({ ref }) => Effect.flatMap(ModelService, (model) => resolveNodeRef(model, ref)),
  "model.canvases": () =>
    Effect.flatMap(ModelService, (model) =>
      Effect.gen(function* () {
        const names = yield* model.listCanvases();
        return yield* Effect.forEach(names, (name) => Effect.map(model.canvas(name), (doc) => ({ name, doc })));
      })),
  "model.editsCanvas": ({ canvasName }) => Effect.flatMap(ModelRecords, (records) => records.editsCanvas(canvasName)),
  // Provider secrets never leave the core: every answer and push is masked, as the window gets it.
  "settings.read": () => Effect.flatMap(SettingsService, (settings) => Effect.map(settings.get, redactProvidersForIpc)),
  // Subscribed once per core; each watch also publishes the settings as they stand, after the
  // subscription, so a watcher reads every value from the one ordered push stream.
  "settings.watch": () =>
    Effect.flatMap(SettingsService, (settings) =>
      Effect.gen(function* () {
        if (!watchingSettings) {
          watchingSettings = true;
          settings.subscribe((next) => publish(SETTINGS_CHANGED, redactProvidersForIpc(next)));
        }
        publish(SETTINGS_CHANGED, redactProvidersForIpc(yield* settings.get));
      })),
  // Subscribed once per core; every canvas change and removal is published with the document as it is now.
  "model.watchCanvases": () =>
    Effect.flatMap(ModelService, (model) =>
      Effect.sync(() => {
        if (watchingCanvases) return;
        watchingCanvases = true;
        model.subscribeChanges((event, next) => publish(CANVAS_CHANGED, { canvas: event.canvas, next } satisfies CanvasChangedPush));
        model.subscribeCanvasesChanges((event) => {
          if (event._tag === "Removed") publish(CANVAS_CHANGED, { canvas: event.canvas, next: undefined } satisfies CanvasChangedPush);
        });
      })),
  "pause.playing": ({ canvas }) => Effect.map(PausePlane, (pause) => pause.stateFor(canvas).playing),
  "content.openForRead": ({ ref }) => Effect.flatMap(ContentService, (content) => content.openForRead(ref)),
  "files.carryThreads": ({ canvasName, nodeId, from, to }) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => carryFileThreads(sql, canvasName, nodeId, from, to)).pipe(Effect.asVoid),
  "signals.raisedHands": () => Effect.flatMap(AgentSignalRepository, (signals) => signals.listRaisedHands),
  "pageBox.check": (request) => checkSeatPageBox(request),
  "pageBox.post": ({ request, shot }) => postSeatPageShot(request, shot),
});
