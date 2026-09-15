import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { Effect, Schema } from "effect";
import {
  IPC_CHANNELS,
  type BindingHint,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { pauseWasResumed, type PauseScope } from "@shared/pause";
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
import {
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  RELAY_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
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
import { registerObservabilityIpc } from "./observability";
import { startLiveFleetUpdateExecutor } from "./update/fleet-executor-live";
import { registerUpdateIpc } from "./update/ipc";
import { SnapshotsService } from "./snapshots";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { ContentService } from "./content/service";
import { messageDelivery } from "./work/message-delivery";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReadId,
} from "./work/mailbox-receipts";
import { onCanvasChangeForEdgeMap } from "./work/edge-map-notify";
import { WorkRepository } from "./work/repository";
import { CrewRepository } from "./work/crew-repository";
import { makeMailAttemptStore } from "./work/mail-attempt-store";
import { kernelRecordFromSnapshot } from "@shared/station-status";
import { registerTerminalIpc } from "./term/ipc";
import { registerGitIpc } from "./git/ipc";
import {
  GROK_MIN_POST_SPAWN_MS,
} from "./term/drive";
import { createManagedTerminalDrive } from "./term/drive/managed-drive-factory";
import { attachManagedTerminalDriveRuntime } from "./term/drive/managed-drive-runtime";
import { clipboardFormatsAreSafeForGrok } from "./term/drive/clipboard-safe";
import {
  isLiveClaudeResumeSummaryChoice,
} from "./term/drive/claude-startup";
import { isManagedTerminalReady } from "./term/drive/readiness";
import {
  admitUngroundedFirstTypedComposer,
  rulePackFor,
  seatStateRuntime,
} from "./term/agent-state";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { mergeSeatStateSnapshot } from "./term/remote-seat-state";
import { homedir } from "node:os";
import {
  SeatSessionCapture,
  discoversSessionAfterSpawn,
} from "./term/seat-session-capture";
import { injectionSupervisor } from "./term/injection-supervisor";
import {
  peekFirstTypedMessage,
  peekFirstTypedEntry,
  takeFirstTypedEntryIfCurrent,
  clearDeliveredForBinding,
} from "./term/first-typed";
import {
  scheduleManagedPulseReady,
  setManagedPulseDeliver,
} from "./term/managed-pulse-bridge";
import {
  factoryBoardTransport,
  factoryDeliveryReadTag,
  factoryMailTransport,
  factoryPulseTransport,
  factorySeatPaused,
  makeFactoryFirstTypedKick,
  wireFactorySupervisor,
} from "./term/factory-delivery-composition";
import { terminalObserverPlane } from "./term/observer";
import { termPlane } from "./term/plane";
import { bindManagedTerminalDriveForOverseer } from "./term/managed-drive-holder";
import { isTrustedMainWebContents } from "./trusted-main-webcontents";
import { trustedRendererIpc } from "./trusted-main-webcontents";
import type { WorkMetadata, Part, TaskState } from "@shared/canvas";
import { makeUserMessage } from "@shared/task";
import { ulid } from "ulid";
import type { PadPatch } from "@shared/pad";
import type { BoardPost } from "@shared/work-model";
import { IntentFactBasis, type ActorRef } from "@shared/work-protocol";
import {
  MainAuthoringRefused,
  mainAuthoringGate,
  type MainAuthoringLabel,
} from "./main-authoring-gate";
import { StationStatusService } from "./station-status-store";
import { StationFleetPropagation } from "./station/fleet-propagation";

/**
 * Wake excerpt for a notify-all on one topic: the latest post's text, else the
 * opening body, else the title itself. Agents never receive raw topic ids.
 */
const latestBoardPostExcerpt = (topic: {
  readonly title: string;
  readonly parts?: ReadonlyArray<Part>;
  readonly posts?: ReadonlyArray<BoardPost>;
}): string => {
  const latest = [...(topic.posts ?? [])].sort(
    (a, b) => b.position - a.position,
  )[0];
  const textOf = (parts: ReadonlyArray<Part> | undefined): string =>
    (parts ?? [])
      .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  return textOf(latest?.parts) || textOf(topic.parts) || topic.title;
};

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

const stampMailboxReceipt = (
  deliveryId: string,
  canvas: string,
  nodeId: string,
  messageId: string,
): Promise<boolean> =>
  runMainAuthoring("delivery.message-stamp", async () => {
    try {
      return await AppRuntime.runPromise(
        Effect.gen(function* () {
          const repo = yield* WorkRepository;
          const canvases = yield* CanvasesService;
          const sink = { canvasName: canvas, nodeId };
          if (yield* repo.hasAcceptedDelivery(sink, deliveryId)) {
            return true;
          }
          const read = yield* canvases.read(canvas, "ipc.deliveryAccept");
          const actor = read.actorRefs.find(
            (ref) => ref.canvasName === canvas && ref.nodeId === nodeId,
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
      try {
        return await AppRuntime.runPromise(
          Effect.gen(function* () {
            const repo = yield* WorkRepository;
            return yield* repo.hasAcceptedDelivery(
              { canvasName: canvas, nodeId },
              deliveryId,
            );
          }),
        );
      } catch {
        return false;
      }
    }
  });

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
    const read = yield* canvases.read(canvasName, "ipc.rendererActor").pipe(Effect.result);
    if (read._tag === "Failure") {
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
      read.success.actorRefs,
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
  const privilegedIpc = trustedRendererIpc(ipcMain);
  registerTerminalIpc(privilegedIpc, termPlane, {
    isTrustedSender: isTrustedMainWebContents,
    ensureHostAvailable: ensureBoxHostAvailable,
    broadcast,
  });
  registerGitIpc(privilegedIpc);
  registerSettingsIpc(privilegedIpc, broadcast);
  registerObservabilityIpc(privilegedIpc, broadcast);
  if (FLEET_UI_ENABLED) {
    registerHostsIpc(privilegedIpc);
  }
  registerUpdateIpc(
    privilegedIpc,
    broadcast,
    app.getVersion(),
  );
  privilegedIpc.handle(IPC_CHANNELS.listCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.list)),
  );

  privilegedIpc.handle(IPC_CHANNELS.readCanvas, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.flatMap(CanvasesService, (canvases) => canvases.read(name, "ipc.readCanvas")),
    ),
  );

  // This trusted-renderer channel is the only delegation writer. Agent
  // commands and ordinary document saves cannot grant overseer authority.
  const decodeOverseerToggle = Schema.decodeUnknownSync(Schema.Struct({
    canvasName: Schema.NonEmptyString,
    nodeId: Schema.NonEmptyString,
    overseer: Schema.Boolean,
    expectedRevision: Schema.NonEmptyString,
  }), { onExcessProperty: "error" });
  privilegedIpc.handle(IPC_CHANNELS.canvasOverseerSet, (_event, input: unknown) =>
    runMainAuthoring(
      "ipc.canvas.overseer-set",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const decoded = yield* Effect.try(() => decodeOverseerToggle(input));
          const canvases = yield* CanvasesService;
          return yield* canvases.canvasOverseerSet(decoded);
        }),
      ),
    ),
  );

  // The quit flush lands through these same handlers: the gate keeps
  // ipc.canvas.write / ipc.canvas.create admitted during its final-flush phase,
  // and the trusted-sender proof above is the only authority they need.
  privilegedIpc.handle(IPC_CHANNELS.writeCanvas, (
    _event,
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ) =>
    runMainAuthoring(
      "ipc.canvas.write",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.write(name, doc, expectedRevision);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.createCanvas, (_event, name: string) =>
    runMainAuthoring(
      "ipc.canvas.create",
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
        const result = yield* canvases.read(name, "ipc.exportDigest");
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

  if (HERMES_INTEGRATION_ENABLED) privilegedIpc.handle(
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
            return yield* canvases.read(name, "ipc.mergePortfolio");
          }),
        ),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.getSnapshots, () =>
    AppRuntime.runPromise(Effect.flatMap(SnapshotsService, (snapshots) => snapshots.current)),
  );

  if (HERMES_INTEGRATION_ENABLED) privilegedIpc.handle(
    IPC_CHANNELS.refreshSnapshots,
    (_event, hints?: ReadonlyArray<BindingHint>) =>
      AppRuntime.runPromise(
        Effect.flatMap(SnapshotsService, (snapshots) => snapshots.refresh(hints)),
      ),
  );

  if (USAGE_ENABLED) {
    privilegedIpc.handle(IPC_CHANNELS.getUsage, () =>
      AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.current)),
    );

    privilegedIpc.handle(IPC_CHANNELS.refreshUsage, () =>
      AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.refresh())),
    );
  }


  if (HERMES_INTEGRATION_ENABLED) {
    privilegedIpc.handle(IPC_CHANNELS.agentMessage, (_event, key: string, text: string) =>
      AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentMessage(key, text)),
    );
  }

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
  // local runtime facts plus last hop-delivered Remote events. Spawn-host
  // wins if the same binding appears in both (they should not).
  privilegedIpc.handle(IPC_CHANNELS.agentSeatStateSnapshot, () =>
    mergeSeatStateSnapshot(seatStateRuntime.currentEvents()),
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
          const written = yield* Effect.result(pause.setScopePaused(canvas, scope, paused));
          if (written._tag === "Failure") {
            return { ok: false as const, error: written.failure.message };
          }
          return { ok: true as const, state: pause.stateFor(canvas) };
        }),
      ),
  );

  if (CRON_ENABLED || RELAY_ENABLED) privilegedIpc.handle(
    IPC_CHANNELS.schedulerFire,
    (
      _event,
      canvas: string,
      sourceNodeId: string,
    ): Promise<
      | {
          ok: true;
          sourceNodeId: string;
          kind: "relay" | "cron" | "gauge";
          applied: number;
          message: string;
        }
      | { ok: false; error: string }
    > =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const kernel = yield* KernelService;
          const result = yield* Effect.tryPromise({
            try: () =>
              kernel.manualFire({
                canvasName: canvas,
                sourceNodeId,
              }),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });
          if (!result.ok) {
            return { ok: false as const, error: result.message };
          }
          return {
            ok: true as const,
            sourceNodeId: result.sourceNodeId,
            kind: result.kind,
            applied: result.applied,
            message: result.message,
          };
        }),
      ),
  );

  // Region rollups for the bottom bar: derived per call from the current
  // document + snapshots + the chat plane's session/permission state.
  privilegedIpc.handle(IPC_CHANNELS.regionRollups, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(name))),
  );

  // Image content put — canvas image nodes + note embeds. Content store only;
  // document carries ContentRef URLs, never Base64.
  const IMAGE_PUT_MAX_BYTES = 16 * 1024 * 1024;
  const IMAGE_PUT_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
  ]);
  privilegedIpc.handle(
    IPC_CHANNELS.contentPutImage,
    (
      _event,
      input: {
        readonly bytesBase64?: unknown;
        readonly mediaType?: unknown;
        readonly displayName?: unknown;
      },
    ) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const settings = yield* SettingsService;
          const current = yield* settings.get;
          if (current.station.role === "remote") {
            return {
              ok: false as const,
              error:
                "Image authoring is available only on the Command Center.",
            };
          }
          if (
            input === null ||
            typeof input !== "object" ||
            typeof input.bytesBase64 !== "string" ||
            typeof input.mediaType !== "string"
          ) {
            return { ok: false as const, error: "invalid image put input" };
          }
          const mediaType = input.mediaType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
          if (!IMAGE_PUT_TYPES.has(mediaType)) {
            return {
              ok: false as const,
              error: `unsupported image media type: ${input.mediaType}`,
            };
          }
          const normalized = input.bytesBase64.replace(/\s+/g, "");
          if (
            normalized.length === 0 ||
            normalized.length % 4 === 1 ||
            !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
          ) {
            return { ok: false as const, error: "invalid Base64 image payload" };
          }
          const bytes = Buffer.from(normalized, "base64");
          const withoutPadding = normalized.replace(/=+$/u, "");
          if (bytes.toString("base64").replace(/=+$/u, "") !== withoutPadding) {
            return { ok: false as const, error: "non-canonical Base64 image payload" };
          }
          if (bytes.length === 0) {
            return { ok: false as const, error: "empty image" };
          }
          if (bytes.length > IMAGE_PUT_MAX_BYTES) {
            return {
              ok: false as const,
              error: `image too large (${bytes.length} bytes; max ${IMAGE_PUT_MAX_BYTES})`,
            };
          }
          const displayName =
            typeof input.displayName === "string" && input.displayName.trim().length > 0
              ? input.displayName.trim().slice(0, 255)
              : undefined;
          const content = yield* ContentService;
          const result = yield* content.put({
            source: bytes,
            mediaType,
            ...(displayName !== undefined ? { displayName } : {}),
          }).pipe(
            Effect.mapError((error) =>
              error instanceof Error ? error : new Error(String(error)),
            ),
          );
          return { ok: true as const, ref: result.ref };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      ),
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
      rules?: ReadonlyArray<import("@shared/work-model").TaskRule>,
      options?: import("@shared/ipc").TaskCreateOptions,
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
              rules,
              options,
            );
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
      path?: import("@shared/work-model").TaskPathArm,
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
              path,
            );
          }),
        ),
      ),
  );
  // Operator approval of a task waiting at an Approval board.
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskPromote,
    (_event, canvas: string, nodeId: string, taskId: string, note?: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-promote",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskPromote(canvas, nodeId, taskId, note);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskComment,
    (_event, canvas: string, nodeId: string, taskId: string, text: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-comment",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const body = text.trim();
            if (!body) {
              return {
                ok: false as const,
                code: "invalid" as const,
                message: "Task comment must be non-empty.",
              };
            }
            const work = yield* WorkService;
            return yield* work.workTaskComment(
              canvas,
              nodeId,
              taskId,
              makeUserMessage({
                messageId: ulid(),
                text: body,
                contextId: canvas,
                taskId,
                metadata: {
                  taskComment: true,
                  fromSeat: "operator",
                  "vellum.taskThread.kind": "comment",
                },
              }),
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
    IPC_CHANNELS.workArtifactArchive,
    (
      _event,
      canvas: string,
      nodeId: string,
      artifactId: string,
      archived: boolean,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.artifact-archive",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workArtifactArchive(
              canvas,
              nodeId,
              artifactId,
              archived,
            );
          }),
        ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workArtifactDelete,
    (
      _event,
      canvas: string,
      nodeId: string,
      artifactId: string,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.artifact-delete",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workArtifactDelete(canvas, nodeId, artifactId);
          }),
        ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workSeatRecentOps,
    (
      _event,
      canvas: string,
      nodeId: string,
      limit?: number,
    ) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const denied = yield* denyRemoteWork;
          if (denied) return denied;
          const work = yield* WorkService;
          return yield* work.workSeatRecentOps(canvas, nodeId, limit);
        }),
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
                }).pipe(Effect.catch(() => Effect.void));
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
    (_event, canvas: string, nodeId: string, topicId: string, upToPosition?: number) =>
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
                upToPosition,
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
              const work = yield* WorkService;
              // Validate the board/topic before waking so a bad request never
              // reaches a transport, and compose the wake from canonical data.
              const listed = yield* work.workBoardList(canvas, nodeId);
              if (!listed.ok) return listed;
              const topic = topicId
                ? listed.data.topics.find((t) => t.topicId === topicId)
                : undefined;
              if (topicId && topic === undefined) {
                return {
                  ok: false as const,
                  code: "task_not_found",
                  message: `topic "${topicId}" not found`,
                };
              }
              const { deliverBoardWake } = yield* Effect.promise(
                () => import("./work/board-delivery"),
              );
              const wakeCount = yield* deliverBoardWake({
                canvas,
                boardNodeId: nodeId,
                kind: "operator.notify.all",
                ...(topic ? { topicId: topic.topicId, topicTitle: topic.title } : {}),
                excerptSource: topic
                  ? latestBoardPostExcerpt(topic)
                  : `${listed.data.topics.length} topics on the board`,
              });
              // Post-delivery projection: the response carries the doc as it
              // stands after the wake, not the preflight read.
              const after = yield* work.workBoardList(canvas, nodeId, topicId);
              const projection = after.ok
                ? { doc: after.doc, revision: after.revision }
                : { doc: listed.doc, revision: listed.revision };
              return {
                ok: true as const,
                data: { wakeCount },
                doc: projection.doc,
                revision: projection.revision,
                disposition: "applied" as const,
              };
            }),
          ),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workPadRead,
    (_event, canvas: string, nodeId: string, pinId?: string) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const denied = yield* denyRemoteWork;
          if (denied) return denied;
          const work = yield* WorkService;
          const result = yield* work.workPadRead(canvas, nodeId, pinId);
          // Mark read only when the requested pin actually resolved — a
          // stale pinId degrades to a plain read without acknowledging
          // anything.
          if (result.ok && pinId !== undefined && result.data.lookHere !== undefined) {
            const marked = yield* work.workPadMarkRead(
              canvas,
              nodeId,
              pinId,
              "operator",
            );
            if (marked.ok) {
              return { ...result, doc: marked.doc, revision: marked.revision };
            }
          }
          return result;
        }),
      ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workPadPatch,
    (
      _event,
      canvas: string,
      nodeId: string,
      patches: ReadonlyArray<PadPatch>,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.pad-patch",
        () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const denied = yield* denyRemoteWork;
              if (denied) return denied;
              const work = yield* WorkService;
              return yield* work.workPadPatch(
                canvas,
                nodeId,
                patches,
                { kind: "operator", label: "operator" },
              );
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
      const pause = yield* PausePlane;
      const settingsForSeed = yield* SettingsService;
      const fleetPropagation = yield* StationFleetPropagation;
      const stationStatus = yield* StationStatusService;
      const stationForSeed = yield* settingsForSeed.get;
      // Fresh Command Center (or unset) may seed. Remote never authors a seed.
      // Domain Effect through warm AppRuntime — never bare Effect.runPromise
      // (empty Context; S0/S1). Authoring gate still serializes the write.
      if (stationForSeed.station.role !== "remote") {
        yield* Effect.tryPromise({
          try: () =>
            runMainAuthoring("startup.canvas.ensure-seed", () =>
              AppRuntime.runPromise(canvases.ensureSeed),
            ),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void));
      }
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      canvases.subscribeChanges(() => {
        Effect.runFork(fleetPropagation.request());
      });
      // ONE edge-notification theory: canvas edge changes produce exactly one
      // compact map-change notice per seat (added contracts inline, removals
      // as a re-orient hint). The former msg.send-enable link notice was a
      // second, equivalent notification from a parallel subsystem — removed.
      canvases.subscribeChanges((name, detail) => {
        void AppRuntime.runPromise(
          onCanvasChangeForEdgeMap(name, detail),
        );
      });
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      if (USAGE_ENABLED) {
        usage.subscribe((state) => broadcast(IPC_CHANNELS.usageChanged, state));
      }
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
      // Single shared destination-drive recipe (managed-drive-factory);
      // this callsite only supplies Command Center evidence sources.
      const managedDrive = createManagedTerminalDrive({
        write: (bindingId, data) =>
          !productAutomationSuspended &&
          termPlane.host.writeManagedSeat(bindingId, data),
        isSeatIdle: (bindingId) => seatStateRuntime.isSeatIdle(bindingId),
        seatState: (bindingId) => seatStateRuntime.getState(bindingId),
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
        snapshot: (bindingId) => terminalObserverPlane.snapshot(bindingId),
        // Screen truth: typing is authorized only while the harness's
        // composer probes prove an EMPTY input box on the live grid.
        composerVerdict: (bindingId) => {
          const raw = seatStateRuntime.composerVerdict(bindingId);
          const harness =
            seatStateRuntime.machine.getSlot(bindingId)?.harness;
          const pack =
            harness !== undefined && isHarnessId(harness)
              ? rulePackFor(harness)
              : undefined;
          return admitUngroundedFirstTypedComposer(
            raw,
            pack,
            peekFirstTypedMessage(bindingId) !== undefined,
          );
        },
        harnessFor: (bindingId) =>
          seatStateRuntime.machine.getSlot(bindingId)?.harness,
      });
      bindManagedTerminalDriveForOverseer(managedDrive);
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
          readonly interruptIfBusy?: boolean;
          /** See ManagedTerminalDrive WritePromptOptions.awaitTurnStart. */
          readonly awaitTurnStart?: boolean;
        },
      ) =>
        managedDrive.writePrompt(bindingId, text, {
          ready: options?.ready ?? driveReady(bindingId),
          ...(options ?? {}),
        });
      // Tier B doctrine kick, initiated by the shared runtime before the
      // drive's own idle drain (preserving the original firstTyped-before-
      // drain invocation order; no stronger lock priority is claimed).
      // Shared recipe — the Node Remote kicks the same doctrine through
      // its own destination drive.
      const { kick: kickFirstTypedDoctrine } = makeFactoryFirstTypedKick({
        firstTyped: {
          peekEntry: peekFirstTypedEntry,
          takeEntryIfCurrent: takeFirstTypedEntryIfCurrent,
          clearDeliveredForBinding,
        },
        driveReady,
        write: writeManagedPrompt,
      });
      // Shared drive lifecycle (ACK/drain/generation cuts); product
      // supervisory feeds below stay local to Command Center.
      attachManagedTerminalDriveRuntime(managedDrive, {
        beforeSeatIdle: kickFirstTypedDoctrine,
        subscribeHostEvents: (listener, options) =>
          termPlane.host.subscribeEvents((payload) => {
            if (payload.type === "output") {
              listener({ kind: "output", bindingId: payload.bindingId });
              return;
            }
            if (payload.type !== "session") return;
            listener({
              kind: "session",
              bindingId: payload.bindingId,
              exited: payload.status === "exited",
              running: payload.status === "running",
            });
          }, options),
        subscribeSeatState: (listener) =>
          seatStateRuntime.subscribe((event) =>
            listener({ bindingId: event.bindingId, state: event.state }),
          ),
        subscribeComposerEmpty: (listener) =>
          seatStateRuntime.subscribeComposerVerdict((bindingId, verdict) => {
            if (verdict !== "empty") return;
            listener(bindingId);
          }),
        harnessFor: (bindingId) =>
          seatStateRuntime.machine.getSlot(bindingId)?.harness,
        snapshotText: (bindingId) =>
          terminalObserverPlane.snapshot(bindingId)?.text,
      });
      // The composer went visibly empty (operator submitted or cleared, or a
      // repaint settled): release the queued prompts that waited on it.
      seatStateRuntime.subscribeComposerVerdict((bindingId, verdict) => {
        if (verdict !== "empty") return;
        // Deliveries refused at the turn boundary (idle published before the
        // composer repaint settled) wait on exactly this boundary.
        messageDelivery.onComposerEmpty(bindingId);
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
      // Post-spawn session capture for harnesses that mint an id and never
      // print it (Muse, fx). Home is read lazily so a test seam can move it.
      const seatSessionCapture = new SeatSessionCapture(() => homedir());
      // Operator multi-prompt (RTS): wake lazy seat + paste+CR without a
      // renderer control lease. Same drive as board megaphone / mailbox.
      privilegedIpc.handle(
        IPC_CHANNELS.terminalManagedPrompt,
        async (
          _event,
          input: {
            readonly bindingId?: string;
            readonly text?: string;
            readonly canvasName?: string;
            readonly nodeId?: string;
          },
        ) => {
          const bindingId =
            typeof input?.bindingId === "string" ? input.bindingId.trim() : "";
          const text = typeof input?.text === "string" ? input.text.trim() : "";
          if (!bindingId) return { ok: false as const, error: "binding required" };
          if (!text) return { ok: false as const, error: "empty prompt" };
          const canvasName =
            typeof input?.canvasName === "string" ? input.canvasName.trim() : "";
          const nodeId =
            typeof input?.nodeId === "string" ? input.nodeId.trim() : "";
          if (canvasName && nodeId) {
            try {
              const woke = await kernel.wakeManagedSeat(canvasName, nodeId);
              if (!woke) {
                return {
                  ok: false as const,
                  error: "could not start managed seat",
                };
              }
            } catch (error) {
              return {
                ok: false as const,
                error:
                  error instanceof Error
                    ? error.message
                    : "could not start managed seat",
              };
            }
          }
          try {
            const outcome = await writeManagedPrompt(bindingId, text, {
              ready: true,
            });
            return outcome.status === "submitted"
              ? { ok: true as const }
              : {
                  ok: false as const,
                  error: outcome.status === "unresolved" || outcome.reason === "written-unresolved"
                    ? "Prompt submission is unconfirmed. Inspect the terminal before retrying."
                    : `Prompt refused before writing: ${outcome.reason}`,
                };
          } catch (error) {
            return {
              ok: false as const,
              error:
                error instanceof Error ? error.message : "prompt write failed",
            };
          }
        },
      );
      // Supervisor transport wiring: re-delivered doctrine goes through the
      // same drive as first-typed doctrine; escalation surfaces on the canvas
      // via the seat state machine (attention with an operator-facing reason).
      // Supervisor transport wiring: re-delivered doctrine goes through the
      // same drive as first-typed doctrine; escalation surfaces on the canvas
      // via the seat state machine. Shared recipe — the Node Remote wires
      // the same supervisor through its own destination drive.
      wireFactorySupervisor({
        supervisor: injectionSupervisor,
        write: writeManagedPrompt,
        escalate: (bindingId, reason) => {
          seatStateRuntime.machine.force(
            bindingId,
            "attention",
            reason,
            "high",
          );
        },
        subscribeSnapshots: (listener) =>
          terminalObserverPlane.subscribeGlobal(listener),
      });
      // Concrete factory closure: the suspension-conditional registration
      // below wraps THIS closure. Wrapping the global dispatcher instead
      // re-registers the wrapper itself and recurses on every pulse.
      const writeManagedPulse = factoryPulseTransport({
        pulse: { setDeliver: setManagedPulseDeliver },
        drive: managedDrive,
        driveReady,
      });
      // Grok ≥1.5s post-spawn before first paste (verified trap).
      termPlane.host.subscribeEvents((payload) => {
        // Drive lifecycle (compact ACK, generation cuts, Grok spawn gate)
        // is owned by the shared runtime attach above; this feed keeps only
        // Command Center product layers (pulses, capture, recovery epoch).
        if (payload.type === "output") return;
        if (payload.type !== "session") return;
        const bindingId = payload.bindingId;
        const epoch = payload.epoch;
        if (payload.status === "exited") {
          cancelManagedPulseReady(bindingId, epoch);
          acceptedClaudeRecoveryEpoch.delete(bindingId);
          return;
        }
        if (payload.status !== "running") return;
        cancelManagedPulseReady(bindingId);
        acceptedClaudeRecoveryEpoch.delete(bindingId);
        const harness = seatStateRuntime.machine.getSlot(bindingId)?.harness;
        if (harness && discoversSessionAfterSpawn(harness)) {
          // Watch from the spawn itself: capture matches on workspace AND a
          // start time, so a seat cannot claim the session of the seat that
          // started just before it in the same directory.
          const live = termPlane.host.get(bindingId);
          seatSessionCapture.watch({
            bindingId,
            harness,
            canvasName: live?.canvasName ?? "",
            nodeId: live?.nodeId ?? "",
            cwd: live?.cwd ?? "",
            spawnedAtMs: Date.now(),
          });
        }
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
        // Injection supervisor: event-driven re-engagement policy.
        injectionSupervisor.noteSeatState(event);
        // Muse and fx mint their session id without printing it, so the seat
        // watches for it on its own boundaries and stores it once. Without
        // that, a cold wake starts a NEW session instead of resuming this one.
        void seatSessionCapture.attempt(event.bindingId).then((sessionId: string | undefined) => {
          if (sessionId) {
            console.info(
              `[term] captured session ${sessionId} for ${event.bindingId}`,
            );
          }
        });
        if (event.state === "gone") {
          seatSessionCapture.forget(event.bindingId);
          // Generation exited: a resumed generation must be able to receive
          // the doctrine again (cold resume must not re-zero the seat).
          clearDeliveredForBinding(event.bindingId);
        }
        if (
          event.state === "attention" &&
          !productAutomationSuspended &&
          seatStateRuntime.machine.getSlot(event.bindingId)?.harness ===
            "claude"
        ) {
          const live = termPlane.host.get(event.bindingId);
          const epoch = live?.epoch;
          const snap = terminalObserverPlane.snapshot(event.bindingId);
          if (
            live?.status === "running" &&
            epoch &&
            snap &&
            acceptedClaudeRecoveryEpoch.get(event.bindingId) !== epoch &&
            isLiveClaudeResumeSummaryChoice(snap.lines)
          ) {
            // The selector's highlighted first option is Claude's own
            // recommended summary recovery. This is startup navigation, not a
            // permission decision, and runs at most once per PTY generation.
            // Selector navigation races live operator keystrokes and any
            // in-flight drive span — skip this heartbeat's recovery write
            // rather than interleave; the next attention repaint retries.
            // Routed through the drive so a bare CR can never submit a stuck
            // chip the drive has not receipted (the seat wedge that refused
            // every later prompt until respawn).
            acceptedClaudeRecoveryEpoch.set(event.bindingId, epoch);
            void managedDrive.submitRecoveryCr(event.bindingId).then((ok) => {
              if (!ok) acceptedClaudeRecoveryEpoch.delete(event.bindingId);
            });
          }
        }
        if (event.state === "idle") {
          // FirstTyped doctrine kick and the drive idle drain run in the
          // shared runtime attach above (hook before drain); this feed keeps
          // only message delivery.
          messageDelivery.onManagedTerminalIdle(event.bindingId);
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
      configureBoardDelivery(
        factoryBoardTransport({ kernel, write: writeManagedPrompt }),
      );

      // Message nudge channel: ether.messages -> live managed terminal seats.
      // Retry only on session-live / seat-idle (no polling store).
      // Shared recipe — the Node Remote configures the same transport
      // through its own destination drive (see factory-delivery-composition).
      const crew = yield* CrewRepository;
      // Reconcile only prior-process intents, before enabling any new writes.
      // A delayed boot sweep must never mistake a live attempt for a crash.
      yield* crew.reconcileUnresolvedAttempts(new Date().toISOString());
      const attempts = makeMailAttemptStore({
        repository: crew,
        run: (effect) => AppRuntime.runPromise(effect),
        resolveSeat: (canvas, nodeId) => AppRuntime.runPromise(Effect.gen(function* () {
          const read = yield* canvases.read(canvas, "ipc.deliveryAccept");
          const actors = read.actorRefs.filter((actor) => actor.canvasName === canvas && actor.nodeId === nodeId);
          if (actors.length !== 1) return yield* Effect.fail(new Error("Mail recipient seat is unavailable"));
          return actors[0]!;
        })),
      });
      messageDelivery.configure({
        attempts,
        transport: factoryMailTransport({
          kernel,
          write: writeManagedPrompt,
          drive: managedDrive,
          // Settled idle + do not paste over a live operator (recent
          // keystrokes or a stuck paste chip). Generation-lifetime typing
          // is not draft — a human-driven seat would never drain mail.
          seatSnapshot: (bindingId) => {
            const live = termPlane.host.get(bindingId);
            if (
              !live ||
              (live.status !== "running" && live.status !== "starting")
            ) {
              return undefined;
            }
            return {
              idle: seatStateRuntime.isSeatIdle(bindingId),
              generationKey: live.epoch,
              // Screen truth: the harness's composer probes must prove an
              // EMPTY box. A visible operator draft, a stuck paste chip, and
              // an unreadable composer all hold mail — the same verdict the
              // drive enforces at the paste boundary, so the gate can never
              // pass a message the transport is about to refuse.
              operatorDraft:
                seatStateRuntime.composerVerdict(bindingId) !== "empty",
            };
          },
        }),
        store: {
          listCanvasNames: () =>
            AppRuntime.runPromise(
              canvases.list.pipe(Effect.map((entries) => entries.map((e) => e.name))),
            ),
          readDoc: (name, site) =>
            AppRuntime.runPromise(
              canvases.read(name, factoryDeliveryReadTag(site)).pipe(
                Effect.map((r) => r.doc),
                Effect.catch(() => Effect.succeed(undefined as CanvasDoc | undefined)),
              ),
            ),
          // Deliberately NOT error-swallowing: `undefined` here must mean the
          // node is gone, so delivery can retire queued work for it. A failed
          // read has to reject and leave that work queued.
          readNodeStructure: (name, nodeId) =>
            AppRuntime.runPromise(
              canvases
                .readNodeStructure(name, nodeId, "delivery.route")
                .pipe(
                  Effect.map((found) =>
                    found === undefined
                      ? undefined
                      : { node: found.node, structure: found.structure },
                  ),
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
              }).pipe(Effect.catch(() => Effect.succeed(false))),
            ),
          hasAcceptedMessageRead: (canvas, nodeId, messageId) =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const repo = yield* WorkRepository;
                return yield* repo.hasAcceptedDelivery(
                  { canvasName: canvas, nodeId },
                  mailboxMessageReadId(canvas, nodeId, messageId),
                );
              }).pipe(Effect.catch(() => Effect.succeed(false))),
            ),
          acceptMessageDelivery: (canvas, nodeId, messageId) =>
            stampMailboxReceipt(
              mailboxMessageDeliveryId(canvas, nodeId, messageId),
              canvas,
              nodeId,
              messageId,
            ),
          acceptMessageRead: (canvas, nodeId, messageId) =>
            stampMailboxReceipt(
              mailboxMessageReadId(canvas, nodeId, messageId),
              canvas,
              nodeId,
              messageId,
            ),
        },
        // Pause law (@shared/pause): canvas paused OR node paused OR any
        // containing region paused keeps the message pending, never sent.
        seatPaused: (canvas, doc, nodeId) =>
          factorySeatPaused(pause, canvas, doc, nodeId),
      });
      // A canvas flipping to playing (or a node/region unpausing inside a
      // playing canvas) re-drives every message held pending while paused.
      pause.subscribe((canvas, previous, current) => {
        if (pauseWasResumed(previous, current)) messageDelivery.onResumedCanvas(canvas);
      });
      // Boot rescan: pending mail from a previous process lifetime has no
      // attach/idle event left — deliver the durable backlog once the canvas
      // and station planes have settled. Every gate re-checks inside.
      setTimeout(() => messageDelivery.onBooted(), 10_000);

      canvases.start();
      snapshots.start();
      // First usage fetch is fire-and-forget off the boot critical path;
      // provider fetches can take tens of seconds so it never blocks window open.
      if (USAGE_ENABLED) usage.start();
      // V4-KERNEL + V4-PROGRAM: host-owned ManagedRuntime entry; factory
      // program is runFork (Effect control plane, not async IIFE).
      kernel.start({
        runPromise: (effect) => AppRuntime.runPromise(effect as never),
        runFork: (effect) => {
          AppRuntime.runFork(effect as never);
        },
      });

      if (FLEET_UI_ENABLED && stationForSeed.station.role === "command-center") {
        yield* fleetPropagation.start();
        // Managed fleet updates walk only from Command Center. The executor
        // re-reads the remoteManagedInstalls kill-switch on every pass, so
        // turning the setting off disables it cleanly.
        startLiveFleetUpdateExecutor();
      }
      settingsForSeed.subscribe((settings) => {
        if (FLEET_UI_ENABLED && settings.station.role === "command-center") {
          Effect.runFork(fleetPropagation.start());
          startLiveFleetUpdateExecutor();
        }
      });
    }),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerVellumBrowserIpc = (sessions: BrowserSessionService): void => {
  if (!BROWSER_ENABLED) return;
  registerBrowserIpc(
    trustedRendererIpc(ipcMain),
    sessions,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
    undefined,
    undefined,
    ensureBoxHostAvailable,
  );
};
