import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ContentRef } from "@shared/content";
import type { AgentSignal } from "@shared/agent-signals";
import type { Canvas } from "@shared/model";
import type { Settings } from "@shared/settings";
import { ContentService, type ContentOpenForRead } from "../../junto/content/service";
import { ModelRecords } from "../../junto/model/records";
import { ModelService } from "../../junto/model/service";
import { resolveNodeRef, type ResolvedNodeRef } from "../../junto/node-ref-resolver";
import { SettingsService } from "../../junto/settings/service";
import { AgentSignalRepository } from "../../junto/signals/repository";
import { carryFileThreads } from "../../junto/work/file-thread-paths";
import {
  checkSeatPageBox,
  postSeatPageShot,
  type SeatPageBoxTarget,
  type SeatPageShot,
} from "../../junto/work/page-box-comment";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

/**
 * What `src/main/index.ts` asks the core on a request: a node ref, the
 * settings, a content read, a file move's threads, the raised hands, the
 * canvases for an edge grant, and a seat's box comment either side of the
 * shot main takes.
 */

/** Where the settings go on every change, once `settings.watch` started it. */
export const SETTINGS_CHANGED = "settings.changed";

type PageBoxPosted = Effect.Success<ReturnType<typeof postSeatPageShot>>;

declare module "../ops" {
  interface CoreOps {
    "model.resolveNodeRef": CoreOp<{ readonly ref: Parameters<typeof resolveNodeRef>[1] }, ResolvedNodeRef>;
    "model.canvases": CoreOp<Record<string, never>, ReadonlyArray<{ readonly name: string; readonly doc: Canvas }>>;
    "model.editsCanvas": CoreOp<{ readonly canvasName: string }, boolean>;
    "settings.read": CoreOp<Record<string, never>, Settings>;
    "settings.watch": CoreOp<Record<string, never>, void>;
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

coreOps({
  "model.resolveNodeRef": ({ ref }) => Effect.flatMap(ModelService, (model) => resolveNodeRef(model, ref)),
  "model.canvases": () =>
    Effect.flatMap(ModelService, (model) =>
      Effect.gen(function* () {
        const names = yield* model.listCanvases();
        return yield* Effect.forEach(names, (name) => Effect.map(model.canvas(name), (doc) => ({ name, doc })));
      })),
  "model.editsCanvas": ({ canvasName }) => Effect.flatMap(ModelRecords, (records) => records.editsCanvas(canvasName)),
  "settings.read": () => Effect.flatMap(SettingsService, (settings) => settings.get),
  // Subscribed once per core; each watch also publishes the settings as they stand, after the
  // subscription, so a watcher reads every value from the one ordered push stream.
  "settings.watch": () =>
    Effect.flatMap(SettingsService, (settings) =>
      Effect.gen(function* () {
        if (!watchingSettings) {
          watchingSettings = true;
          settings.subscribe((next) => publish(SETTINGS_CHANGED, next));
        }
        publish(SETTINGS_CHANGED, yield* settings.get);
      })),
  "content.openForRead": ({ ref }) => Effect.flatMap(ContentService, (content) => content.openForRead(ref)),
  "files.carryThreads": ({ canvasName, nodeId, from, to }) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => carryFileThreads(sql, canvasName, nodeId, from, to)).pipe(Effect.asVoid),
  "signals.raisedHands": () => Effect.flatMap(AgentSignalRepository, (signals) => signals.listRaisedHands),
  "pageBox.check": (request) => checkSeatPageBox(request),
  "pageBox.post": ({ request, shot }) => postSeatPageShot(request, shot),
});
