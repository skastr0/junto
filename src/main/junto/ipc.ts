import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { Effect, Result, Schema } from "effect";
import {
  IPC_CHANNELS,
  type BindingHint,
  type AgentSignalOperatorResult,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { pauseWasResumed } from "@shared/pause";
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
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  PAD_ENABLED,
  RELAY_ENABLED,
  REQUESTS_ENABLED,
  SEAT_AWARENESS_COMPILED,
  TASKS_ENABLED,
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
import { AgentSignalRepository } from "./signals/repository";
import { raisedHands } from "./signals/raised-hands";
import { SquadRepository, type SquadRepositoryError } from "./squads/repository";
import type { SquadDeleteResult, SquadResult, SquadSaveInput } from "@shared/squads";
import { SeatGuidanceRepository } from "./seat-guidance/repository";
import { seatGuidanceIndex } from "./seat-guidance/index-memory";
import { isSeatGuidanceSeatId, type SeatGuidanceSetResult } from "@shared/seat-guidance";
import { ProfileRepository, type ProfileRepositoryError } from "./profiles/repository";
import type { ProfileDeleteResult, ProfileResult, ProfileSaveInput } from "@shared/agent-profiles";
import { PortraitOverrideRepository } from "./portraits/repository";
import {
  isPortraitSeatId,
  normalizePortraitOverride,
  type PortraitOverrideSetResult,
} from "@shared/portrait-overrides";
import {
  answerAgentSignal,
  dismissAgentSignal,
  listCanvasAgentSignals,
} from "./signals/operator";
import { mailboxMessageDeliveryId } from "./work/mailbox-receipts";
import { onCanvasChangeForEdgeMap } from "./work/edge-map-notify";
import { WorkRepository } from "./work/repository";
import { CrewRepository } from "./work/crew-repository";
import { makeCheckoutWatchComposition } from "./work/checkout-watch-composition";
import type { CheckoutWatchSupervisor } from "./work/checkout-watch-live";
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
import { MailReadinessLatch } from "./term/drive/mail-readiness";
import {
  admitUngroundedFirstTypedComposer,
  rulePackFor,
  seatStateRuntime,
} from "./term/agent-state";
import { awarenessSeatHold } from "./term/awareness/seat-hold";
import {
  resolveSeatAwarenessGate,
  seatAwarenessApiKey,
  seatAwarenessEnrolled,
  seatAwarenessPlane,
  SEAT_AWARENESS_ENV,
} from "./term/seat-awareness";
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
  factoryPulseTransport,
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
import {
  collaborationRequestMetadata,
  composeCollaborationRequestText,
  normalizeSeatCollaborationAsk,
  type SeatCollaborationAskResult,
} from "@shared/seat-collaboration";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { mailExtensionMetadata } from "@shared/crew";
import { operatorActorRef } from "@shared/work-reference";
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

export const registerJuntoIpc = (): void => {
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

  // Advisory seat-awareness projection. Display only: a renderer restart
  // rehydrates the latest window revision and judgment per binding, and the
  // renderer's decoder refuses anything it does not recognize.
  privilegedIpc.handle(IPC_CHANNELS.seatAwarenessSnapshot, () =>
    seatAwarenessPlane.currentEvents(),
  );

  // Seat collaboration — one seat asks a peer for help. The request is an
  // ordinary mailbox message, so delivery, wakes and the reply path are the
  // ones crew mail already owns; this handler only composes and validates it.
  // Operator-originated: the awareness sidecar can suggest a peer, but nothing
  // reaches a seat's mailbox unless the operator asks for it.
  privilegedIpc.handle(
    IPC_CHANNELS.seatCollaborationAsk,
    (_event, input: unknown): Promise<SeatCollaborationAskResult> => {
      // The live plane is the resolved gate: compiled, and turned on in
      // Settings, Experimental (or shipped on).
      if (!seatAwarenessPlane.isEnabled()) {
        return Promise.resolve({
          ok: false as const,
          error: "seat collaboration is off: turn on Seat awareness in Settings, Experimental",
        });
      }
      const normalized = normalizeSeatCollaborationAsk(input);
      if (!normalized.ok) return Promise.resolve(normalized);
      const draft = normalized.draft;
      return runMainAuthoring(
        "ipc.work.collaboration-ask",
        async (): Promise<SeatCollaborationAskResult> =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              yield* denyUnlessCommandCenterAuthorial;
              const canvases = yield* CanvasesService;
              const read = yield* Effect.result(
                canvases.read(draft.canvas, "ipc.work.collaboration-ask"),
              );
              if (read._tag === "Failure") {
                return {
                  ok: false as const,
                  error: `canvas ${JSON.stringify(draft.canvas)} could not be read`,
                };
              }
              const nodes = read.success.doc.nodes;
              const source = nodes.find((node) => node.id === draft.sourceNodeId);
              const target = nodes.find((node) => node.id === draft.targetNodeId);
              if (source === undefined) {
                return {
                  ok: false as const,
                  error: `seat ${JSON.stringify(draft.sourceNodeId)} is not on this canvas`,
                };
              }
              if (target === undefined) {
                return {
                  ok: false as const,
                  error: `seat ${JSON.stringify(draft.targetNodeId)} is not on this canvas`,
                };
              }
              if (target.ether?.entity?.kind !== "agent") {
                return {
                  ok: false as const,
                  error: "a collaboration request can only be sent to an agent seat",
                };
              }
              const work = yield* WorkService;
              const requestId = ulid();
              const result = yield* work.workSystemMailboxNotify(
                draft.canvas,
                draft.targetNodeId,
                makeUserMessage({
                  messageId: requestId,
                  text: composeCollaborationRequestText(draft, requestId),
                  contextId: draft.canvas,
                  metadata: collaborationRequestMetadata(draft, requestId),
                }),
              );
              if (!result.ok) {
                return { ok: false as const, error: result.message };
              }
              return {
                ok: true as const,
                requestId,
                doc: result.doc,
                revision: result.revision,
              };
            }),
          ),
      ).catch((error: unknown) => ({
        ok: false as const,
        error:
          error instanceof Error
            ? error.message
            : "collaboration request could not be sent",
      }));
    },
  );

  // Portrait overrides: the operator's per-seat character customization. An
  // install-local preference like settings (no canvas authoring), so it runs
  // outside the main-authoring gate; every change is broadcast as it stands.
  privilegedIpc.handle(IPC_CHANNELS.portraitOverridesList, () =>
    AppRuntime.runPromise(Effect.flatMap(PortraitOverrideRepository, (repository) => repository.list())),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.portraitOverrideSet,
    async (_event, seatId: unknown, override: unknown): Promise<PortraitOverrideSetResult> => {
      if (!isPortraitSeatId(seatId)) return { ok: false, message: "portrait seat id is invalid" };
      try {
        const stored = await AppRuntime.runPromise(
          Effect.flatMap(PortraitOverrideRepository, (repository) =>
            repository.set(seatId, override === null ? null : normalizePortraitOverride(override)),
          ),
        );
        broadcast(IPC_CHANNELS.portraitOverride, { seatId, override: stored });
        return { ok: true, seatId, override: stored };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "portrait save failed" };
      }
    },
  );

  // Agent signals: the operator reads every seat's claim on a canvas, answers
  // one (typed into the seat as operator mail, then marked answered), or
  // dismisses it. Every change is broadcast as the signal now stands.
  privilegedIpc.handle(IPC_CHANNELS.agentSignalsList, (_event, canvas: string) =>
    AppRuntime.runPromise(listCanvasAgentSignals(canvas)),
  );
  const runSignalOperator = (
    label: MainAuthoringLabel,
    program: Effect.Effect<AgentSignalOperatorResult, never, AgentSignalRepository | WorkService>,
  ): Promise<AgentSignalOperatorResult> =>
    runMainAuthoring(label, () => AppRuntime.runPromise(program))
      .then((result) => {
        if (result.ok) {
          raisedHands.note(result.signal);
          broadcast(IPC_CHANNELS.agentSignal, result.signal);
        }
        return result;
      })
      .catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "signal update failed",
      }));
  privilegedIpc.handle(
    IPC_CHANNELS.agentSignalRespond,
    async (_event, signalId: string, text: string) => {
      const result = await runSignalOperator(
        "ipc.work.signal-answer",
        answerAgentSignal(String(signalId), String(text)),
      );
      // The answer is durable mail now; typing it into the seat follows the
      // ordinary delivery path (at once when live, else when it comes up).
      if (result.ok && result.messageId !== undefined) {
        void messageDelivery
          .deliver(result.signal.canvasName, result.signal.nodeId, result.messageId)
          .catch(() => undefined);
      }
      return result;
    },
  );
  privilegedIpc.handle(IPC_CHANNELS.agentSignalDismiss, (_event, signalId: string) =>
    runSignalOperator("ipc.work.signal-dismiss", dismissAgentSignal(String(signalId))),
  );

  // Squads: the operator's reusable seat templates. Every change pushes the
  // whole list so each window's add picker stays current. Refusals (taken
  // name, bad template, gone squad) come back as a message, never a throw.
  const squadsNow = () =>
    AppRuntime.runPromise(Effect.flatMap(SquadRepository, (repository) => repository.list()));
  const runSquad = async <A>(
    program: Effect.Effect<A, SquadRepositoryError, SquadRepository>,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }> => {
    const result = await AppRuntime.runPromise(Effect.result(program)).catch((error: unknown) =>
      Result.fail({ message: error instanceof Error ? error.message : "squad update failed" }),
    );
    if (Result.isFailure(result)) return { ok: false, message: result.failure.message };
    void squadsNow()
      .then((squads) => broadcast(IPC_CHANNELS.squadsChanged, { squads }))
      .catch(() => undefined);
    return { ok: true, value: result.success };
  };
  const squadIdOf = (value: unknown): string | undefined =>
    typeof value === "string" && value.length >= 1 && value.length <= 64 ? value : undefined;
  privilegedIpc.handle(IPC_CHANNELS.squadsList, () => squadsNow());
  privilegedIpc.handle(IPC_CHANNELS.squadSave, async (_event, input: unknown): Promise<SquadResult> => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const squadId = raw.squadId === undefined ? undefined : squadIdOf(raw.squadId);
    if (raw.squadId !== undefined && squadId === undefined) return { ok: false, message: "squad id is invalid" };
    const saved = await runSquad(
      Effect.flatMap(SquadRepository, (repository) =>
        repository.save({
          ...(squadId === undefined ? {} : { squadId }),
          name: String(raw.name ?? ""),
          body: raw.body as SquadSaveInput["body"],
        }),
      ),
    );
    return saved.ok ? { ok: true, squad: saved.value } : saved;
  });
  privilegedIpc.handle(
    IPC_CHANNELS.squadRename,
    async (_event, squadId: unknown, name: unknown): Promise<SquadResult> => {
      const id = squadIdOf(squadId);
      if (id === undefined) return { ok: false, message: "squad id is invalid" };
      const renamed = await runSquad(
        Effect.flatMap(SquadRepository, (repository) => repository.rename(id, String(name ?? ""))),
      );
      return renamed.ok ? { ok: true, squad: renamed.value } : renamed;
    },
  );
  privilegedIpc.handle(
    IPC_CHANNELS.squadDelete,
    async (_event, squadId: unknown): Promise<SquadDeleteResult> => {
      const id = squadIdOf(squadId);
      if (id === undefined) return { ok: false, message: "squad id is invalid" };
      const removed = await runSquad(
        Effect.flatMap(SquadRepository, (repository) => repository.remove(id)),
      );
      return removed.ok ? { ok: true, squadId: removed.value } : removed;
    },
  );

  // Seat guidance: the operator's per-seat soul and instructions. An
  // install-local preference like portrait overrides (no canvas authoring), so
  // it runs outside the main-authoring gate. The spawn plan reads the stored
  // result from memory, so every write is noted there before it is broadcast.
  privilegedIpc.handle(IPC_CHANNELS.seatGuidanceList, () =>
    AppRuntime.runPromise(Effect.flatMap(SeatGuidanceRepository, (repository) => repository.list())),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.seatGuidanceSet,
    async (_event, seatId: unknown, guidance: unknown): Promise<SeatGuidanceSetResult> => {
      if (!isSeatGuidanceSeatId(seatId)) return { ok: false, message: "seat id is invalid" };
      const result = await AppRuntime.runPromise(
        Effect.result(Effect.flatMap(SeatGuidanceRepository, (repository) => repository.set(seatId, guidance))),
      ).catch((error: unknown) =>
        Result.fail({ message: error instanceof Error ? error.message : "seat guidance save failed" }),
      );
      if (Result.isFailure(result)) return { ok: false, message: result.failure.message };
      seatGuidanceIndex.note(seatId, result.success);
      broadcast(IPC_CHANNELS.seatGuidance, { seatId, guidance: result.success });
      return { ok: true, seatId, guidance: result.success };
    },
  );

  // Agent profiles: saved agents placed from the add picker. Every change
  // pushes the whole list; refusals come back as a message, never a throw.
  const profilesNow = () =>
    AppRuntime.runPromise(Effect.flatMap(ProfileRepository, (repository) => repository.list()));
  const runProfile = async <A>(
    program: Effect.Effect<A, ProfileRepositoryError, ProfileRepository>,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }> => {
    const result = await AppRuntime.runPromise(Effect.result(program)).catch((error: unknown) =>
      Result.fail({ message: error instanceof Error ? error.message : "profile update failed" }),
    );
    if (Result.isFailure(result)) return { ok: false, message: result.failure.message };
    void profilesNow()
      .then((profiles) => broadcast(IPC_CHANNELS.profilesChanged, profiles))
      .catch(() => undefined);
    return { ok: true, value: result.success };
  };
  const profileIdOf = (value: unknown): string | undefined =>
    typeof value === "string" && value.length >= 1 && value.length <= 64 ? value : undefined;
  privilegedIpc.handle(IPC_CHANNELS.profilesList, () => profilesNow());
  privilegedIpc.handle(IPC_CHANNELS.profileSave, async (_event, input: unknown): Promise<ProfileResult> => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const profileId = raw.profileId === undefined ? undefined : profileIdOf(raw.profileId);
    if (raw.profileId !== undefined && profileId === undefined) return { ok: false, message: "profile id is invalid" };
    const saved = await runProfile(
      Effect.flatMap(ProfileRepository, (repository) =>
        repository.save({
          ...(profileId === undefined ? {} : { profileId }),
          body: raw.body as ProfileSaveInput["body"],
        }),
      ),
    );
    return saved.ok ? { ok: true, profile: saved.value } : saved;
  });
  privilegedIpc.handle(
    IPC_CHANNELS.profileRename,
    async (_event, profileId: unknown, name: unknown): Promise<ProfileResult> => {
      const id = profileIdOf(profileId);
      if (id === undefined) return { ok: false, message: "profile id is invalid" };
      const renamed = await runProfile(
        Effect.flatMap(ProfileRepository, (repository) => repository.rename(id, String(name ?? ""))),
      );
      return renamed.ok ? { ok: true, profile: renamed.value } : renamed;
    },
  );
  privilegedIpc.handle(
    IPC_CHANNELS.profileDelete,
    async (_event, profileId: unknown): Promise<ProfileDeleteResult> => {
      const id = profileIdOf(profileId);
      if (id === undefined) return { ok: false, message: "profile id is invalid" };
      const removed = await runProfile(
        Effect.flatMap(ProfileRepository, (repository) => repository.remove(id)),
      );
      return removed.ok ? { ok: true, profileId: removed.value } : removed;
    },
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
      paused: boolean,
    ): Promise<FactoryPauseSetResult> =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const pause = yield* PausePlane;
          yield* pause.start;
          const written = yield* Effect.result(pause.setPlaying(canvas, !paused));
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

  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (TASKS_ENABLED) privilegedIpc.handle(
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
                  "junto.taskThread.kind": "comment",
                },
              }),
            );
          }),
        ),
      ),
  );
  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (TASKS_ENABLED) privilegedIpc.handle(
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
  if (REQUESTS_ENABLED) privilegedIpc.handle(
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

  if (ARTIFACTS_ENABLED) privilegedIpc.handle(
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

  if (ARTIFACTS_ENABLED) privilegedIpc.handle(
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

  if (BOARD_ENABLED) privilegedIpc.handle(
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

  if (BOARD_ENABLED) privilegedIpc.handle(
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

  if (BOARD_ENABLED) privilegedIpc.handle(
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

  if (BOARD_ENABLED) privilegedIpc.handle(
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

  if (BOARD_ENABLED) privilegedIpc.handle(
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

  if (PAD_ENABLED) privilegedIpc.handle(
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

  if (PAD_ENABLED) privilegedIpc.handle(
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
      let checkoutWatch: CheckoutWatchSupervisor | undefined;
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
      // Advisory seat-awareness sidecar, an experimental feature. Enrollment is
      // the Settings toggle: a discovered key is not consent. Off, the plane is
      // not running at all; on with no key it publishes missing_key. The toggle
      // applies live: a change stops the plane and, when on, starts it again.
      // Display only, and never on the terminal path.
      seatAwarenessPlane.subscribe((event) =>
        broadcast(IPC_CHANNELS.seatAwarenessChanged, event),
      );
      const applySeatAwareness = (settings: typeof stationForSeed): void => {
        if (!SEAT_AWARENESS_COMPILED) return;
        const on = resolveSeatAwarenessGate({
          env: process.env[SEAT_AWARENESS_ENV],
          enrolled: seatAwarenessEnrolled(settings),
        }).enabled;
        if (on === seatAwarenessPlane.isEnabled()) return;
        seatAwarenessPlane.stop();
        if (on) seatAwarenessPlane.start({ enabled: true, apiKey: seatAwarenessApiKey() });
      };
      applySeatAwareness(stationForSeed);
      settingsForSeed.subscribe(applySeatAwareness);
      // Mail waits for each generation's TUI to come up (bracketed paste on,
      // settled idle) before its first paste; see mail-readiness.
      const mailReadiness = new MailReadinessLatch();
      const mailReadyNow = (bindingId: string): boolean => {
        const slot = seatStateRuntime.machine.getSlot(bindingId);
        const snap = terminalObserverPlane.snapshot(bindingId);
        const live = termPlane.host.get(bindingId);
        return mailReadiness.observe(bindingId, {
          running: live?.status === "running",
          generation: live?.epoch,
          harness: slot?.harness,
          seatState: seatStateRuntime.getState(bindingId),
          bracketedPaste: snap?.signals.modes.bracketedPaste === true,
          idleConfirmed: seatStateRuntime.isSeatIdle(bindingId),
          lines: snap?.lines,
        });
      };
      // Single shared destination-drive recipe (managed-drive-factory);
      // this callsite only supplies Command Center evidence sources.
      const managedDrive = createManagedTerminalDrive({
        write: (bindingId, data) =>
          !productAutomationSuspended &&
          termPlane.host.writeManagedSeat(bindingId, data),
        // Deterministic idle AND not held by the AI verdict. The AI can only
        // make this stricter: a seat Jev judges blocked on an approval is not
        // typed into, and a seat it says nothing about behaves as before.
        isSeatIdle: (bindingId) =>
          seatStateRuntime.isSeatIdle(bindingId) &&
          !awarenessSeatHold.holds(bindingId),
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
        bracketedPaste: (bindingId) =>
          terminalObserverPlane.snapshot(bindingId)?.signals.modes.bracketedPaste === true,
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
      const productAutomationSuspension = Object.freeze({
        suspend: (): void => {
          if (productAutomationSuspended) return;
          productAutomationSuspended = true;
          checkoutWatch?.stop();
          // Cut every Junto-owned source before releasing its exact control
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
      // Operator multi-prompt (RTS): the operator's text is prompt mail from
      // the operator, delivered like any other mail — at once when the seat
      // is live, else when it comes up.
      privilegedIpc.handle(
        IPC_CHANNELS.terminalManagedPrompt,
        async (
          _event,
          input: {
            readonly bindingId?: string;
            readonly text?: string;
            readonly canvasName?: string;
            readonly nodeId?: string;
            readonly wake?: boolean;
          },
        ) => {
          const bindingId =
            typeof input?.bindingId === "string" ? input.bindingId.trim() : "";
          const text = typeof input?.text === "string" ? input.text.trim() : "";
          if (!bindingId) {
            return {
              ok: false as const,
              disposition: "failed" as const,
              error: "binding required",
            };
          }
          if (!text) {
            return {
              ok: false as const,
              disposition: "failed" as const,
              error: "empty prompt",
            };
          }
          const canvasName =
            typeof input?.canvasName === "string" ? input.canvasName.trim() : "";
          const nodeId =
            typeof input?.nodeId === "string" ? input.nodeId.trim() : "";
          if (!canvasName || !nodeId) {
            return {
              ok: false as const,
              disposition: "failed" as const,
              error: "canvas and node required",
            };
          }
          const sender = operatorActorRef(canvasName);
          const messageId = ulid();
          // A caller that only addresses live seats keeps a down seat down.
          if (input?.wake === false) messageDelivery.holdWake(messageId);
          const message = makeUserMessage({
            messageId,
            text,
            contextId: canvasName,
            metadata: {
              factoryMail: true,
              ...mailExtensionMetadata({
                mailKind: "prompt",
                fromSeat: sender.seatId,
                senderNodeId: sender.nodeId,
                senderName: "operator",
                senderGeneration: "operator",
                senderHarness: "unknown",
              }),
            },
          });
          try {
            const appended = await runRendererWorkAuthoring(
              "ipc.work.message-append",
              () =>
                AppRuntime.runPromise(
                  Effect.gen(function* () {
                    const denied = yield* denyRemoteWork;
                    if (denied) return denied;
                    const canvases = yield* CanvasesService;
                    const read = yield* canvases.read(
                      canvasName,
                      "ipc.terminalManagedPrompt",
                    );
                    const node = read.doc.nodes.find((n) => n.id === nodeId);
                    const surface =
                      node === undefined
                        ? undefined
                        : actorDeliverySurfaceOf(node);
                    if (
                      surface === undefined ||
                      surface.hostId !== "local"
                    ) {
                      return {
                        ok: false as const,
                        code: "invalid" as const,
                        message:
                          "Immediate prompts require a local managed seat",
                      };
                    }
                    if (surface.bindingId !== bindingId) {
                      return {
                        ok: false as const,
                        code: "invalid" as const,
                        message: "binding does not match the managed seat",
                      };
                    }
                    const work = yield* WorkService;
                    return yield* work.workSystemMailboxNotify(
                      canvasName,
                      nodeId,
                      message,
                    );
                  }),
                ),
            );
            if (!appended.ok) {
              return {
                ok: false as const,
                disposition: "failed" as const,
                error: appended.message,
              };
            }
            const liveId = appended.data.messageId;
            const state = await messageDelivery.deliver(canvasName, nodeId, liveId);
            return {
              ok: true as const,
              disposition: state === "delivered" ? "submitted" as const : "queued" as const,
              messageId: liveId,
            };
          } catch (error) {
            return {
              ok: false as const,
              disposition: "failed" as const,
              messageId,
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
        // Any live state means the seat's terminal is up: write the mail
        // that waited for it. FirstTyped doctrine and the drive idle drain
        // run in the shared runtime attach above.
        if (event.state !== "gone") messageDelivery.onSeatLive(event.bindingId);
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

      // Mail: every pending message is typed into its seat at once, whatever
      // the seat is doing; mail for a seat that is not up starts it (on a
      // playing canvas) and waits for its TUI.
      const crew = yield* CrewRepository;
      messageDelivery.configure({
        transport: {
          // Physical only: a running process whose TUI is up (mail-readiness).
          seatLive: (bindingId) =>
            !productAutomationSuspended && mailReadyNow(bindingId),
          // The kernel wake owns locality, the pause law, and the restart
          // budget. A generation already starting needs no second wake.
          wakeSeat: (bindingId, canvas, nodeId) => {
            if (productAutomationSuspended) return Promise.resolve(false);
            const status = termPlane.host.get(bindingId)?.status;
            if (status === "starting" || status === "running") {
              return Promise.resolve(true);
            }
            return kernel.wakeManagedSeat(canvas, nodeId);
          },
          writeMail: (bindingId, text) => managedDrive.writeMail(bindingId, text),
        },
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
          acceptMessageDelivery: (canvas, nodeId, messageId) =>
            stampMailboxReceipt(
              mailboxMessageDeliveryId(canvas, nodeId, messageId),
              canvas,
              nodeId,
              messageId,
            ),
        },
      });
      // Every message typed into a seat pulses its wire on the canvas.
      messageDelivery.subscribeDelivered((event) =>
        broadcast(IPC_CHANNELS.wireTraffic, event),
      );
      // A TUI that turns bracketed paste on may do it with no seat-state
      // change; that edge is when its waiting mail becomes writable.
      const bracketedPasteOn = new Set<string>();
      terminalObserverPlane.subscribeGlobal((snap) => {
        const on = snap.signals.modes.bracketedPaste;
        if (!on) {
          bracketedPasteOn.delete(snap.bindingId);
          return;
        }
        if (bracketedPasteOn.has(snap.bindingId)) return;
        bracketedPasteOn.add(snap.bindingId);
        messageDelivery.onSeatLive(snap.bindingId);
      });
      // Play released a hold: its waiting mail starts the seats it names.
      pause.subscribe((canvas, previous, current) => {
        if (pauseWasResumed(previous, current)) messageDelivery.onResumed(canvas);
      });
      // Boot scan: mail pending from a previous process lifetime has no
      // append event left — deliver the backlog once the canvas and station
      // planes have settled.
      setTimeout(() => void messageDelivery.onBooted(), 10_000);

      const workRepository = yield* WorkRepository;
      checkoutWatch = makeCheckoutWatchComposition({
        canvases,
        settings: settingsForSeed,
        host: termPlane.host,
        crew,
        workRepository,
        messageDelivery,
        basisFor: (witness) => Schema.decodeUnknownSync(IntentFactBasis)({
          kind: "authorial-intent",
          generation: witness.generation,
          contentSha256: witness.contentSha256,
        }),
        run: (effect) => AppRuntime.runPromise(effect),
        write: (effect) => runMainAuthoring("review.checkout", () => AppRuntime.runPromise(effect)),
        onError: (error) => console.error("[checkout-watch]", error),
      });
      const syncCheckoutWatch = (role: string): void => {
        if (!productAutomationSuspended && role === "command-center") checkoutWatch?.start();
        else checkoutWatch?.stop();
      };
      syncCheckoutWatch((yield* settingsForSeed.get).station.role);

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
        syncCheckoutWatch(settings.station.role);
        if (FLEET_UI_ENABLED && settings.station.role === "command-center") {
          Effect.runFork(fleetPropagation.start());
          startLiveFleetUpdateExecutor();
        }
      });
    }),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerJuntoBrowserIpc = (sessions: BrowserSessionService): void => {
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
