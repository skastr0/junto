import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ContentRef } from "@shared/content";
import type { AgentSignal } from "@shared/agent-signals";
import type { Canvas } from "@shared/model";
import { redactProvidersForIpc, type Settings } from "@shared/settings";
import type { PreambleEvent } from "@shared/preamble";
import { IPC_CHANNELS } from "@shared/ipc";
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
import { RESOURCE_CHANGED, RESOURCE_THREAD_CHANGED } from "./ipc-resources";
import { TERM_EVENT, TERM_LEASE_ENDED, TERM_SEAT_STATE } from "./term-ipc";
import { WIRE_TRAFFIC } from "./ipc-wire-traffic";
import { MACHINE_PROGRESS } from "./hosts-ipc";

/**
 * What `src/main/index.ts` asks the core on a request: a node ref, the
 * settings, a content read, a file move's threads, the raised hands, the
 * canvases for an edge grant, and a seat's box comment either side of the
 * shot main takes.
 */

/** Where the settings go on every change, provider secrets masked, once `settings.watch` started it. */
export const SETTINGS_CHANGED = "settings.changed";
/** A seat's preamble, as the core's work control server takes it, for the window to show. */
export const WORK_PREAMBLE = "work.preamble";
/** Every agent signal the core writes, for the window and the raised hands. */
export const AGENT_SIGNAL_CHANGED = "signals.changed";
/** The paired phones, after any change, for Settings. */
export const COMPANION_DEVICES = "companion.devices";
/** The live overseer's snapshot on every change, once `live.watch` started it. */
export const LIVE_CHANGED = "live.changed";
/** A mail thread's read point moved, from any surface, once `ipc.threads.watch` started it. */
export const SEAT_THREAD_READ_CHANGED = "threads.readChanged";
/** Mail held on a seat past its wait, once `ipc.threads.watch` started it. */
export const MAIL_WAITING = "mail.waiting";
/** A canvas changed, with the document as it is now, or was removed; once `model.watchCanvases` started it. */
export const CANVAS_CHANGED = "model.canvasChanged";

export type CanvasChangedPush = { readonly canvas: string; readonly next: Canvas | undefined };


/** Every channel main forwards to the window. */
export const WINDOW_CHANNELS = [
  SETTINGS_CHANGED,
  WORK_PREAMBLE,
  AGENT_SIGNAL_CHANGED,
  COMPANION_DEVICES,
  CANVAS_CHANGED,
  LIVE_CHANGED,
  SEAT_THREAD_READ_CHANGED,
  MAIL_WAITING,
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  WIRE_TRAFFIC,
  // The model watches publish on the window's own channel names (ipc-watch.ts).
  IPC_CHANNELS.modelChanged,
  IPC_CHANNELS.modelCanvasesChanged,
  IPC_CHANNELS.modelActorRefsChanged,
  IPC_CHANNELS.viewStateChanged,
  IPC_CHANNELS.referencesChanged,
  IPC_CHANNELS.workMailChanged,
  IPC_CHANNELS.workSinkChanged,
  IPC_CHANNELS.seatAwarenessChanged,
  IPC_CHANNELS.usageChanged,
  IPC_CHANNELS.kernelChanged,
  IPC_CHANNELS.automationsChanged,
  // A running machine command's progress, for the window whose call asked.
  MACHINE_PROGRESS,
  // The terminal plane's events, a linked view's end and a remote seat's state (term/ipc.ts).
  TERM_EVENT,
  TERM_LEASE_ENDED,
  TERM_SEAT_STATE,
] as const;

/**
 * Main's side, once the core runs in its own process: each window push from
 * the port reaches main's subscribers on the push bus, as a publish in this
 * process would. Returns the stop.
 */
export const relayWindowPushes = (client: { readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void }): (() => void) => {
  const stops = WINDOW_CHANNELS.map((channel) => client.onPush(channel, (payload) => publish(channel, payload)));
  return () => {
    for (const stop of stops) stop();
  };
};

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
