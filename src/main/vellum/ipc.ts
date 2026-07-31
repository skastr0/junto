import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { Effect, Schema } from "effect";
import {
  IPC_CHANNELS,
  type BindingHint,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { seatPaused, type PauseScope } from "@shared/pause";
import { digestCanvas } from "@shared/digest";
import { mergePortfolioInto } from "@shared/portfolio";
import { AppRuntime } from "../runtime";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { CanvasesService } from "./canvases";
import { CanvasEntityRepository } from "./entities/repository";
import { BoxActivityPolicy } from "./box";

import { registerChatIpc } from "./chat/ipc";
import { ChatServiceContext } from "./chat/service";
import { HermesPlane } from "./hermes/plane";
import { registerHerdrIpc } from "./herdr/ipc";
import { KernelService } from "./kernel/service";
import { RegionRollupService } from "./region-rollup";
import { registerHostsIpc } from "./hosts/ipc";
import {
  HOST_OPERATION_ADMISSIONS,
  hostOperationGate,
} from "./hosts/shutdown";
import { PausePlane } from "./pause-plane";
import { registerSettingsIpc } from "./settings/ipc";
import { SettingsService } from "./settings/service";
import { registerUpdateIpc } from "./update/ipc";
import { SnapshotsService } from "./snapshots";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { messageDelivery } from "./work/message-delivery";
import { mailboxMessageDeliveryId } from "./work/mailbox-receipts";
import { onCanvasChangeForMsgSendEnable } from "./work/msg-send-enable-notify";
import { WorkRepository } from "./work/repository";
import { kernelRecordFromSnapshot } from "@shared/station-status";
import { HerdrPlane } from "./herdr/plane";
import { registerTerminalIpc } from "./term/ipc";
import { GROK_MIN_POST_SPAWN_MS, ManagedTerminalDrive } from "./term/drive";
import { clipboardFormatsAreSafeForGrok } from "./term/drive/clipboard-safe";
import { isClaudeResumeSummaryChoice } from "./term/drive/claude-startup";
import { isManagedTerminalReady } from "./term/drive/readiness";
import { seatStateRuntime } from "./term/agent-state";
import {
  peekFirstTypedMessage,
  takeFirstTypedMessage,
} from "./term/first-typed";
import {
  makeManagedPulseDeliver,
  scheduleManagedPulseReady,
  setManagedPulseDeliver,
} from "./term/managed-pulse-bridge";
import { terminalObserverPlane } from "./term/observer";
import { termPlane } from "./term/plane";
import { isTrustedMainWebContents } from "./trusted-main-webcontents";
import { licensedRendererIpc } from "./license/admission";
import type { WorkMetadata, Part, TaskState } from "@shared/canvas";
import { IntentFactBasis, type ActorRef } from "@shared/work-protocol";
import {
  MainAuthoringRefused,
  MainAuthoringTransitionError,
  mainAuthoringGate,
  type MainAuthoringFinalOperation,
  type MainAuthoringLabel,
} from "./main-authoring-gate";
import { StationStatusService } from "./station-status-store";
import { StationFleetPropagation } from "./station/fleet-propagation";

const broadcast = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    // Guard: close/reopen races can leave a BrowserWindow whose webContents
    // is already destroyed (Object has been destroyed in main).
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !isTrustedMainWebContents(window.webContents)
    ) continue;
    window.webContents.send(channel, payload);
  }
};

const ensureBoxHostAvailable = (hostId: string): Promise<void> =>
  hostOperationGate.run(HOST_OPERATION_ADMISSIONS.boxActivate, () =>
    AppRuntime.runPromise(
      Effect.flatMap(BoxActivityPolicy, (policy) =>
        policy.ensureHostAvailable(hostId),
      ),
    ),
  );

const runMainAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<A>,
): Promise<A> => mainAuthoringGate.run(label, operation);

interface RendererFinalWriteMetadata {
  readonly requestId: string;
  readonly operation: MainAuthoringFinalOperation;
}

const decodeRendererFinalWriteMetadata = (
  value: unknown,
): RendererFinalWriteMetadata | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).join(",") !== "__vellumFinalWrite") return undefined;
  if (!("__vellumFinalWrite" in value)) return undefined;
  const metadata = value.__vellumFinalWrite;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  if (Object.keys(metadata).sort().join(",") !== "operation,requestId") return undefined;
  if (!("requestId" in metadata) || typeof metadata.requestId !== "string") return undefined;
  if (!("operation" in metadata)) return undefined;
  if (metadata.operation !== "canvas.write" && metadata.operation !== "canvas.create") {
    return undefined;
  }
  return {
    requestId: metadata.requestId,
    operation: metadata.operation,
  };
};

const runRendererCanvasAuthoring = <A>(
  label: Extract<MainAuthoringLabel, "ipc.canvas.write" | "ipc.canvas.create">,
  senderId: number,
  rawMetadata: unknown,
  operation: MainAuthoringFinalOperation,
  task: () => Promise<A>,
): Promise<A> => {
  // Metadata is absent on every ordinary renderer call. Once admission has
  // closed, those calls must continue through run() so they are refused.
  if (rawMetadata === undefined) return runMainAuthoring(label, task);

  const metadata = decodeRendererFinalWriteMetadata(rawMetadata);
  if (metadata === undefined) {
    return Promise.reject(
      new MainAuthoringTransitionError(
        "invalid_final_permit",
        "renderer final-write metadata must be an exact preload-issued envelope",
      ),
    );
  }
  if (metadata.operation !== operation) {
    return Promise.reject(
      new MainAuthoringTransitionError(
        "unsupported_final_operation",
        `renderer final-write metadata for ${metadata.operation} cannot authorize ${operation}`,
      ),
    );
  }
  return mainAuthoringGate.runFinalWrite(
    { senderId, requestId: metadata.requestId },
    operation,
    label,
    task,
  );
};

const runRendererWorkAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<WorkOpResult<A>>,
): Promise<WorkOpResult<A>> =>
  runMainAuthoring(label, operation).catch((error: unknown) => {
    if (error instanceof MainAuthoringRefused) {
      return {
        ok: false as const,
        code: "invalid" as const,
        message: error.message,
      };
    }
    return Promise.reject(error);
  });

export const resolveProjectedIpcActorRef = (
  actorRefs: ReadonlyArray<ActorRef>,
  canvasName: string,
  nodeId: string,
): ActorRef | undefined => {
  const matches = actorRefs.filter(
    (actor) =>
      actor.canvasName === canvasName &&
      actor.nodeId === nodeId,
  );
  return matches.length === 1 ? matches[0] : undefined;
};

type RendererActorResolution =
  | { readonly ok: true; readonly actor: ActorRef }
  | { readonly ok: false; readonly result: WorkOpResult<never> };

const resolveRendererActor = (
  canvasName: string,
  nodeId: string,
): Effect.Effect<RendererActorResolution, never, CanvasesService> =>
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const read = yield* canvases.read(canvasName).pipe(Effect.either);
    if (read._tag === "Left") {
      return {
        ok: false,
        result: {
          ok: false,
          code: "invalid",
          message:
            `cannot resolve actor ${JSON.stringify(nodeId)} on ` +
            `${JSON.stringify(canvasName)} from the current projection`,
        },
      };
    }
    const actor = resolveProjectedIpcActorRef(
      read.right.actorRefs,
      canvasName,
      nodeId,
    );
    return actor === undefined
      ? {
        ok: false,
        result: {
          ok: false,
          code: "invalid",
          message:
            `actor ${JSON.stringify(nodeId)} does not identify exactly one ` +
            "compiled actor seat in the current projection",
        },
      }
      : { ok: true, actor };
  });

/**
 * Doctrine: only Command Center authors the canvas. Remote and unconfigured
 * installations must fail closed — never mint authorial power by defaulting to CC.
 */
const denyUnlessCommandCenterAuthorial = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const current = yield* settings.get;
  if (current.station.role !== "command-center") {
    return yield* Effect.fail(
      new Error(
        current.station.role === "remote"
          ? "A Remote can't edit the canvas — author on the Command Center."
          : "Station role is unset; authorial canvas mutation is refused until protected topology establishes this installation as Command Center.",
      ),
    );
  }
});

export const registerVellumIpc = (): void => {
  const privilegedIpc = licensedRendererIpc(ipcMain);
  registerHerdrIpc(privilegedIpc, () =>
    BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
  );
  registerTerminalIpc(privilegedIpc, termPlane, {
    isTrustedSender: isTrustedMainWebContents,
    ensureHostAvailable: ensureBoxHostAvailable,
  });
  registerSettingsIpc(privilegedIpc, broadcast);
  registerHostsIpc(privilegedIpc);
  registerUpdateIpc(
    privilegedIpc,
    broadcast,
    app.getVersion(),
  );
  privilegedIpc.handle(IPC_CHANNELS.listCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.list)),
  );

  privilegedIpc.handle(IPC_CHANNELS.readCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.read(name))),
  );

  privilegedIpc.handle(IPC_CHANNELS.writeCanvas, (
    event,
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
    finalWriteMetadata?: unknown,
  ) =>
    runRendererCanvasAuthoring(
      "ipc.canvas.write",
      event.sender.id,
      finalWriteMetadata,
      "canvas.write",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.write(name, doc, expectedRevision);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.createCanvas, (event, name: string, finalWriteMetadata?: unknown) =>
    runRendererCanvasAuthoring(
      "ipc.canvas.create",
      event.sender.id,
      finalWriteMetadata,
      "canvas.create",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.create(name);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.deleteCanvas, (_event, name: string) =>
    runMainAuthoring(
      "ipc.canvas.delete",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.remove(name);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.exportDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const snapshots = yield* SnapshotsService;
        const result = yield* canvases.read(name);
        const state = yield* snapshots.current;
        const digest = digestCanvas(name, result.doc, state, {
          resolveActorRef: ({ canvasName, nodeId }) =>
            resolveProjectedIpcActorRef(
              result.actorRefs,
              canvasName,
              nodeId,
            ),
        });
        const path = yield* canvases.writeSidecar(name, "digest.txt", digest);
        return { digest, path };
      }),
    ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.generatePortfolio,
    (_event, name: string, options?: { all?: boolean }) =>
      runMainAuthoring(
        "ipc.canvas.portfolio",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const canvases = yield* CanvasesService;
            const entities = yield* CanvasEntityRepository;
            const snapshots = yield* SnapshotsService;
            // Fresh full-corpus pull (no hints = base project lists from each source).
            const state = yield* snapshots.refresh([]);
            const suppressEntityIds = yield* entities.listSuppressedEntityIds(
              name,
            );
            // mergePortfolioInto is idempotent. Run it through the retrying
            // document mutation boundary so a direct-file edit during refresh
            // is merged into, never overwritten by a stale pre-refresh read.
            // Suppress archived/soft_deleted entity ids so hermes cannot
            // re-mint a deleted agent card via deterministic agent-${slug}.
            yield* canvases.mutate(name, (doc) =>
              mergePortfolioInto(doc, state, {
                all: options?.all ?? false,
                suppressEntityIds,
              }),
            );
            return yield* canvases.read(name);
          }),
        ),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.getSnapshots, () =>
    AppRuntime.runPromise(Effect.flatMap(SnapshotsService, (snapshots) => snapshots.current)),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.refreshSnapshots,
    (_event, hints?: ReadonlyArray<BindingHint>) =>
      AppRuntime.runPromise(
        Effect.flatMap(SnapshotsService, (snapshots) => snapshots.refresh(hints)),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.getUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.current)),
  );

  privilegedIpc.handle(IPC_CHANNELS.refreshUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.refresh())),
  );


  privilegedIpc.handle(IPC_CHANNELS.agentIdentity, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentIdentity(key)),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentAvatar, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentAvatar(key)),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentMessage, (_event, key: string, text: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentMessage(key, text)),
  );

  // The attached-chat plane (hermes ACP sessions per agent node). Shares its
  // ChatService instance with KernelService below — a pulse-driven turn and
  // a human reuse the same live ACP session per agent.
  void registerChatIpc(
    privilegedIpc,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
    AppRuntime.runPromise(ChatServiceContext),
  );

  // The kernel plane: watcher/timer evaluation over every hydrated canvas,
  // running continuously in main regardless of window state.
  privilegedIpc.handle(IPC_CHANNELS.getKernelState, () =>
    AppRuntime.runPromise(Effect.map(KernelService, (kernel) => kernel.getSnapshot())),
  );

  // Managed-seat activity lives in main. A renderer-only restart must hydrate
  // the current projection instead of waiting for a future state transition.
  privilegedIpc.handle(IPC_CHANNELS.agentSeatStateSnapshot, () =>
    seatStateRuntime.currentEvents(),
  );

  // Factory pause plane — canvas-level switch. start is idempotent hydration,
  // so an early renderer read/write never races boot into the born-paused
  // default composing a store write from an unhydrated map.
  privilegedIpc.handle(IPC_CHANNELS.factoryPauseState, (_event, canvas: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const pause = yield* PausePlane;
        yield* pause.start;
        return pause.stateFor(canvas);
      }),
    ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.factoryPauseSet,
    (
      _event,
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ): Promise<FactoryPauseSetResult> =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const pause = yield* PausePlane;
          yield* pause.start;
          const written = yield* Effect.either(pause.setScopePaused(canvas, scope, paused));
          if (written._tag === "Left") {
            return { ok: false as const, error: written.left.message };
          }
          return { ok: true as const, state: pause.stateFor(canvas) };
        }),
      ),
  );

  // Region rollups for the bottom bar: derived per call from the current
  // document + snapshots + the chat plane's session/permission state.
  privilegedIpc.handle(IPC_CHANNELS.regionRollups, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(name))),
  );

  // work plane — renderer commands call repository-native WorkService verbs.
  // Remote stations get a typed WorkOpResult (never a rejected IPC promise).
  const denyRemoteWork = Effect.gen(function* () {
    const settings = yield* SettingsService;
    const current = yield* settings.get;
    if (current.station.role === "remote") {
      return {
        ok: false as const,
        code: "invalid" as const,
        message:
          "Operator work authoring is available only on the Command Center.",
      };
    }
    return null;
  });

  privilegedIpc.handle(
    IPC_CHANNELS.workTaskCreate,
    (
      _event,
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      reason?: string,
      media?: ReadonlyArray<Part>,
      dependsOn?: ReadonlyArray<string>,
      finishCriteria?: import("@shared/work-model").FinishCriteria,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-create",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskCreate(
              canvas,
              nodeId,
              brief,
              metadata,
              reason,
              media,
              dependsOn,
              finishCriteria,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskPropose,
    (
      _event,
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      reason?: string,
      media?: ReadonlyArray<Part>,
      dependsOn?: ReadonlyArray<string>,
      finishCriteria?: import("@shared/work-model").FinishCriteria,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-propose",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskProposeOperator(
              canvas,
              nodeId,
              brief,
              metadata,
              reason,
              media,
              dependsOn,
              finishCriteria,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskApproveProposal,
    (_event, canvas: string, nodeId: string, taskId: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-approve-proposal",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskApproveProposal(canvas, nodeId, taskId);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskDescribe,
    (_event, canvas: string, nodeId: string, taskId: string, brief: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-describe",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskDescribe(canvas, nodeId, taskId, brief);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskTransition,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
      completionEvidence?: import("@shared/work-model").CompletionEvidence,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-transition",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskTransition(
              canvas,
              nodeId,
              taskId,
              state,
              note,
              completionEvidence,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskRespond,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "working" | "rejected",
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-respond",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskRespond(
              canvas,
              nodeId,
              taskId,
              responseText,
              disposition,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskClaim,
    (_event, canvas: string, nodeId: string, taskId: string, actor: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-claim",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const resolved = yield* resolveRendererActor(canvas, actor);
            if (!resolved.ok) return resolved.result;
            const work = yield* WorkService;
            return yield* work.workTaskClaim(
              canvas,
              nodeId,
              taskId,
              resolved.actor,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workRequestResolve,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "completed" | "rejected",
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.request-resolve",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workRequestResolve(
              canvas,
              nodeId,
              taskId,
              responseText,
              disposition,
            );
          }),
        ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workBoardList,
    (
      _event,
      canvas: string,
      nodeId: string,
      topicId?: string,
    ) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const denied = yield* denyRemoteWork;
          if (denied) return denied;
          const work = yield* WorkService;
          return yield* work.workBoardList(canvas, nodeId, topicId);
        }),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workBoardCreateTopic,
    (
      _event,
      canvas: string,
      nodeId: string,
      title: string,
      body: string | undefined,
      notify: boolean,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.board-topic-create",
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const denied = yield* denyRemoteWork;
              if (denied) return denied;
              const work = yield* WorkService;
              const result = yield* work.workBoardCreateTopic(
                canvas,
                nodeId,
                title,
                body,
                { kind: "operator", label: "operator" },
                notify === true,
              );
              if (
                result.ok &&
                result.data.notify &&
                result.disposition === "applied"
              ) {
                const { deliverBoardWake } = yield* Effect.promise(
                  () => import("./work/board-delivery"),
                );
                yield* deliverBoardWake({
                  canvas,
                  boardNodeId: nodeId,
                  kind: "operator.topic.notify",
                  topicId: result.data.topic.topicId,
                  topicTitle: result.data.topic.title,
                  excerptSource: title,
                }).pipe(Effect.catchAll(() => Effect.void));
              }
              return result;
            }),
          ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workBoardPost,
    (
      _event,
      canvas: string,
      nodeId: string,
      topicId: string,
      text: string,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.board-post",
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const denied = yield* denyRemoteWork;
              if (denied) return denied;
              const work = yield* WorkService;
              return yield* work.workBoardPost(
                canvas,
                nodeId,
                topicId,
                text,
                { kind: "operator", label: "operator" },
              );
            }),
          ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workBoardMarkRead,
    (_event, canvas: string, nodeId: string, topicId: string) =>
      runRendererWorkAuthoring(
        "ipc.work.board-mark-read",
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const denied = yield* denyRemoteWork;
              if (denied) return denied;
              const work = yield* WorkService;
              return yield* work.workBoardMarkRead(
                canvas,
                nodeId,
                topicId,
                "operator",
              );
            }),
          ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workBoardNotify,
    (_event, canvas: string, nodeId: string, topicId?: string) =>
      runRendererWorkAuthoring(
        "ipc.work.board-notify",
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const denied = yield* denyRemoteWork;
              if (denied) return denied;
              const { deliverBoardWake } = yield* Effect.promise(
                () => import("./work/board-delivery"),
              );
              const wakeCount = yield* deliverBoardWake({
                canvas,
                boardNodeId: nodeId,
                kind: "operator.notify.all",
                topicId,
                excerptSource: topicId
                  ? `notify topic ${topicId}`
                  : "notify all",
              });
              const work = yield* WorkService;
              const listed = yield* work.workBoardList(canvas, nodeId, topicId);
              if (!listed.ok) return listed;
              return {
                ok: true as const,
                data: { wakeCount },
                doc: listed.doc,
                revision: listed.revision,
                disposition: "applied" as const,
              };
            }),
          ),
      ),
  );

  // Wire pushes and background loops once at startup.
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const usage = yield* UsageService;
      const kernel = yield* KernelService;
      const herdr = yield* HerdrPlane;
      const pause = yield* PausePlane;
      const settingsForSeed = yield* SettingsService;
      const fleetPropagation = yield* StationFleetPropagation;
      const stationStatus = yield* StationStatusService;
      const stationForSeed = yield* settingsForSeed.get;
      // Fresh Command Center (or unset) may seed. Remote never authors a seed.
      if (stationForSeed.station.role !== "remote") {
        yield* Effect.tryPromise({
          try: () =>
            runMainAuthoring("startup.canvas.ensure-seed", () =>
              Effect.runPromise(canvases.ensureSeed),
            ),
          catch: () => undefined,
        }).pipe(Effect.catchAll(() => Effect.void));
      }
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      canvases.subscribeChanges(() => {
        Effect.runFork(fleetPropagation.request());
      });
      // Rising-edge mailbox notify when actor↔actor msg.send is newly enabled.
      canvases.subscribeChanges((name, detail) => {
        void AppRuntime.runPromise(
          onCanvasChangeForMsgSendEnable(name, detail),
        );
      });
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      usage.subscribe((state) => broadcast(IPC_CHANNELS.usageChanged, state));
      kernel.subscribe((snapshot) => {
        broadcast(IPC_CHANNELS.kernelChanged, snapshot);
        // Fleet Doctor reads this bounded heartbeat over SSH. Never persist
        // canvas names, node ids, agent identities, instructions, or tokens.
        Effect.runFork(
          stationStatus
            .recordKernel(kernelRecordFromSnapshot(snapshot))
            .pipe(Effect.ignore),
        );
      });

      // Managed-terminal drive: in-process agent-seat writes for factory typing.
      // External control leases belong to interactive terminal clients; product
      // automation must never steal them during claim delivery.
      let productAutomationSuspended = false;
      const managedPulseReadyCancels = new Map<
        string,
        { readonly epoch: string; readonly cancel: () => void }
      >();
      const acceptedClaudeRecoveryEpoch = new Map<string, string>();
      const cancelManagedPulseReady = (
        bindingId: string,
        epoch?: string,
      ): void => {
        const pending = managedPulseReadyCancels.get(bindingId);
        if (
          pending === undefined ||
          (epoch !== undefined && pending.epoch !== epoch)
        ) {
          return;
        }
        pending.cancel();
        managedPulseReadyCancels.delete(bindingId);
      };
      // Observer → seat state machine → idle gate for drive typing.
      // Fail closed: unknown/unbound seats are not idle (never type into dialogs).
      seatStateRuntime.start();
      const managedDrive = new ManagedTerminalDrive({
        write: (bindingId, data) =>
          !productAutomationSuspended &&
          termPlane.host.writeManagedSeat(bindingId, data),
        isSeatIdle: (bindingId) => seatStateRuntime.isSeatIdle(bindingId),
        // Only Grok has the clipboard-image TUI trap. Electron exposes the
        // pasteboard format list without decoding its payload; all other
        // harnesses bypass this preflight entirely.
        assertClipboardSafe: (bindingId) => {
          if (
            seatStateRuntime.machine.getSlot(bindingId)?.harness !== "grok"
          ) {
            return true;
          }
          return clipboardFormatsAreSafeForGrok(clipboard.availableFormats());
        },
        onAttention: (bindingId, reason) => {
          // One seat event producer: preserve the generation epoch and let
          // runtime lifecycle invalidation suppress nudges for dead seats.
          if (!seatStateRuntime.machine.getSlot(bindingId)) return;
          seatStateRuntime.machine.force(
            bindingId,
            "attention",
            reason,
          );
        },
      });
      const productAutomationSuspension = Object.freeze({
        suspend: (): void => {
          if (productAutomationSuspended) return;
          productAutomationSuspended = true;
          // Cut every Vellum Command-owned source before releasing its exact control
          // leases. LocalSessionHost.release never signals the PTY process.
          managedDrive.suspend();
          messageDelivery.suspend();
          setManagedPulseDeliver(undefined);
          for (const pending of managedPulseReadyCancels.values()) {
            pending.cancel();
          }
          managedPulseReadyCancels.clear();
        },
      });
      termPlane.bindProductAutomationSuspension(
        productAutomationSuspension,
      );
      const driveReady = (bindingId: string): boolean => {
        if (productAutomationSuspended) return false;
        const slot = seatStateRuntime.machine.getSlot(bindingId);
        return isManagedTerminalReady({
          harness: slot?.harness,
          seatState: seatStateRuntime.getState(bindingId),
          snapshot: terminalObserverPlane.snapshot(bindingId),
        });
      };
      const writeManagedPrompt = (
        bindingId: string,
        text: string,
        options?: {
          readonly queueTimeoutMs?: number;
          readonly ready?: boolean;
        },
      ) =>
        managedDrive.writePrompt(bindingId, text, {
          ready: options?.ready ?? driveReady(bindingId),
          ...(options ?? {}),
        });
      const writeManagedPulse = makeManagedPulseDeliver(
        (bindingId, text, options) =>
          managedDrive.writePrompt(bindingId, text, options),
        driveReady,
      );
      // Grok ≥1.5s post-spawn before first paste (verified trap).
      termPlane.host.subscribeEvents((payload) => {
        if (payload.type !== "session") return;
        const bindingId = payload.bindingId;
        const epoch = payload.epoch;
        if (payload.status === "exited") {
          managedDrive.invalidateBinding(bindingId);
          cancelManagedPulseReady(bindingId, epoch);
          acceptedClaudeRecoveryEpoch.delete(bindingId);
          return;
        }
        if (payload.status !== "running") return;
        managedDrive.invalidateBinding(bindingId);
        cancelManagedPulseReady(bindingId);
        acceptedClaudeRecoveryEpoch.delete(bindingId);
        const harness = seatStateRuntime.machine.getSlot(bindingId)?.harness;
        if (harness === "grok") {
          managedDrive.markSpawned(bindingId, GROK_MIN_POST_SPAWN_MS);
          const cancel = scheduleManagedPulseReady(
            { bindingId, epoch },
            GROK_MIN_POST_SPAWN_MS,
            () => {
              const pending = managedPulseReadyCancels.get(bindingId);
              if (pending?.epoch !== epoch) return false;
              managedPulseReadyCancels.delete(bindingId);
              const live = termPlane.host.get(bindingId);
              return (
                !productAutomationSuspended &&
                live?.epoch === epoch &&
                live.status === "running"
              );
            },
          );
          managedPulseReadyCancels.set(bindingId, { epoch, cancel });
        }
      }, { replayCurrentSessions: true });
      seatStateRuntime.subscribe((event) => {
        broadcast(IPC_CHANNELS.agentSeatStateChanged, event);
        if (
          event.state === "attention" &&
          !productAutomationSuspended &&
          seatStateRuntime.machine.getSlot(event.bindingId)?.harness ===
            "claude"
        ) {
          const live = termPlane.host.get(event.bindingId);
          const epoch = live?.epoch;
          const screen = terminalObserverPlane.snapshot(event.bindingId)?.text;
          if (
            live?.status === "running" &&
            epoch &&
            screen &&
            acceptedClaudeRecoveryEpoch.get(event.bindingId) !== epoch &&
            isClaudeResumeSummaryChoice(screen)
          ) {
            // The selector's highlighted first option is Claude's own
            // recommended summary recovery. This is startup navigation, not a
            // permission decision, and runs at most once per PTY generation.
            acceptedClaudeRecoveryEpoch.set(event.bindingId, epoch);
            if (!termPlane.host.writeManagedSeat(event.bindingId, "\r")) {
              acceptedClaudeRecoveryEpoch.delete(event.bindingId);
            }
          }
        }
        if (event.state === "idle") {
          // Tier B doctrine: first typed message once seat is ready+idle.
          // Peek first — only consume after a successful write so not-ready
          // / queue-timeout can retry on the next idle event.
          const first = peekFirstTypedMessage(event.bindingId);
          if (first && driveReady(event.bindingId)) {
            void writeManagedPrompt(event.bindingId, first).then((ok) => {
              if (ok) takeFirstTypedMessage(event.bindingId);
            });
          }
          managedDrive.onSeatIdle(event.bindingId);
          messageDelivery.onManagedTerminalIdle(event.bindingId);
        }
        if (event.state === "working") {
          managedDrive.onTurnStart(event.bindingId);
        }
      });
      // Kernel pulses for managed seats (not ACP).
      setManagedPulseDeliver(
        productAutomationSuspended
          ? undefined
          : (bindingId, text) => writeManagedPulse(bindingId, text),
      );

      // Bulletin board operator megaphone reuses managed-prompt transport.
      const { configureBoardDelivery } = yield* Effect.promise(
        () => import("./work/board-delivery"),
      );
      configureBoardDelivery({
        sendManagedTerminalPrompt: (bindingId, text) =>
          writeManagedPrompt(bindingId, text),
      });

      // Message nudge channel: ether.messages -> live managed terminal seats.
      // Retry only on session-live / seat-idle (no polling store).
      messageDelivery.configure({
        transport: {
          // Kind-discriminated surfaces only — no ACP transport fields.
          // Raw geography shells: no auto-submit.
          sendTerminalPaste: (_bindingId, _text, _messageId) => false,
          // managedAgent + rawTerminal → paste+CR via idle-gated drive.
          sendManagedTerminalPrompt: (bindingId, text) =>
            writeManagedPrompt(bindingId, text),
        },
        store: {
          listCanvasNames: () =>
            AppRuntime.runPromise(
              canvases.list.pipe(Effect.map((entries) => entries.map((e) => e.name))),
            ),
          readDoc: (name) =>
            AppRuntime.runPromise(
              canvases.read(name).pipe(
                Effect.map((r) => r.doc),
                Effect.catchAll(() => Effect.succeed(undefined as CanvasDoc | undefined)),
              ),
            ),
          hasAcceptedMessageDelivery: (canvas, nodeId, messageId) =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const repo = yield* WorkRepository;
                return yield* repo.hasAcceptedDelivery(
                  { canvasName: canvas, nodeId },
                  mailboxMessageDeliveryId(canvas, nodeId, messageId),
                );
              }).pipe(Effect.catchAll(() => Effect.succeed(false))),
            ),
          acceptMessageDelivery: (canvas, nodeId, messageId) =>
            runMainAuthoring("delivery.message-stamp", async () => {
              try {
                return await AppRuntime.runPromise(
                  Effect.gen(function* () {
                    const repo = yield* WorkRepository;
                    const sink = { canvasName: canvas, nodeId };
                    const deliveryId = mailboxMessageDeliveryId(
                      canvas,
                      nodeId,
                      messageId,
                    );
                    if (yield* repo.hasAcceptedDelivery(sink, deliveryId)) {
                      return true;
                    }
                    const read = yield* canvases.read(canvas);
                    const actor = read.actorRefs.find(
                      (ref) =>
                        ref.canvasName === canvas && ref.nodeId === nodeId,
                    );
                    if (actor === undefined) return false;
                    const settings = yield* SettingsService;
                    const current = yield* settings.get;
                    const intentWitness = yield* canvases.activeIntentWitness();
                    const basis = Schema.decodeUnknownSync(IntentFactBasis)({
                      kind:
                        current.station.role === "command-center"
                          ? "authorial-intent"
                          : "projected-intent",
                      generation: intentWitness.generation,
                      contentSha256: intentWitness.contentSha256,
                    });
                    yield* repo.acceptDelivery({
                      sink,
                      basis,
                      receipt: {
                        deliveryId,
                        deliveredItem: {
                          kind: "message",
                          itemId: messageId,
                          sink,
                        },
                        actor,
                        acceptedAt: new Date().toISOString(),
                      },
                    });
                    return true;
                  }),
                );
              } catch {
                return false;
              }
            }),
        },
        // Pause law (@shared/pause): canvas paused OR node paused OR any
        // containing region paused keeps the message pending, never sent.
        seatPaused: (canvas, doc, nodeId) =>
          seatPaused(pause.stateFor(canvas), doc, nodeId),
      });
      // A canvas flipping to playing (or a node/region unpausing inside a
      // playing canvas) re-drives every message held pending while paused.
      pause.subscribe((canvas) => {
        if (pause.stateFor(canvas).playing) messageDelivery.onResumed();
      });

      canvases.start();
      snapshots.start();
      // First usage fetch is fire-and-forget off the boot critical path;
      // codexbar can take ~15-20s so it never blocks window open.
      usage.start();
      kernel.start();

      if (stationForSeed.station.role === "command-center") {
        yield* fleetPropagation.start();
      }
      settingsForSeed.subscribe((settings) => {
        if (settings.station.role === "command-center") {
          Effect.runFork(fleetPropagation.start());
        }
      });
    }),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerVellumBrowserIpc = (sessions: BrowserSessionService): void => {
  registerBrowserIpc(
    licensedRendererIpc(ipcMain),
    sessions,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
    undefined,
    undefined,
    ensureBoxHostAvailable,
  );
};
