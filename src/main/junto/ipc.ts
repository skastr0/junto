import { canvasReceiptBasis } from "./work/delivery-receipts";
import { WorkItemQuery, WorkActorQuery, WorkAttentionQuery, WorkSinkQuery } from "@shared/work-sinks";
import { WorkMailQuery } from "@shared/work-mail";
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from "electron";
import { Effect, Result, Schema, Stream } from "effect";
import {
  OperatorThreadSend,
  SeatThreadPageQuery,
  SeatThreadsPageQuery,
  SeatThreadsQuery,
  type OperatorThreadSent,
} from "@shared/mail-threads";
import {
  deliverOperatorThreadMail,
  mentionableSeats,
  seatThreadMessagesPage,
  seatThreadsPage,
  sendOperatorThreadMail,
} from "./work/operator-threads";
import { OperatorAttachments, OperatorContentPut, type OperatorContentPutResult } from "@shared/operator-attachments";
import { putOperatorContent } from "./content/operator-attachments";
import {
  IPC_CHANNELS,
  type AgentSignalAnswerOptions,
  type AgentSignalOperatorResult,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { Canvas } from "@shared/model";
import { readModelDigest } from "./model/digest";
import { AppRuntime } from "../runtime";
import { MachineCoreMail } from "../core-runtime";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { ModelService } from "./model/service";
import { ModelActorRefs } from "./model/actor-refs";
import { Command, CanvasName, asNodeId } from "@shared/model";

import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  REQUESTS_ENABLED,
  SEAT_AWARENESS_COMPILED,
  TASKS_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import { KernelService } from "./kernel/service";
import { registerHostsIpc } from "./hosts/ipc";
import { PausePlane } from "./pause-plane";
import { registerSettingsIpc } from "./settings/ipc";
import { shellEnvironment } from "./shell-environment";
import { registerShellEnvironmentIpc } from "./shell-environment/ipc";
import { registerReferencesIpc } from "./references/ipc";
import { liveResourceIpcPorts, registerResourceIpc } from "./work/resource-ipc";
import { registerAutomationIpc } from "./automation/ipc";
import { SettingsService } from "./settings/service";
import { registerObservabilityIpc } from "./observability";
import { registerUpdateIpc } from "./update/ipc";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { ContentService } from "./content/service";
import { contentObjectUrl } from "@shared/content-url";
import type { ContentRef } from "@shared/content";
import type { AgentSignal } from "@shared/agent-signals";
import { messageDelivery } from "./work/message-delivery";
import { appendSeatPrompt, type SeatPromptInput } from "./work/seat-prompt";
import { AgentSignalRepository } from "./signals/repository";
import { onAgentSignalChanged } from "./signals/changes";
import { wireSeatReports } from "./term/agent-state/seat-reports";
import {
  locatePreviewForReveal,
  readAttachmentPreview,
  readComparePreview,
  readPreview,
  type PreviewThumbnailer,
} from "./preview/read";
import { remoteVideos } from "./preview/remote-video";
import {
  PREVIEW_THUMB_EDGE,
  previewLinkName,
  type PreviewPlayResult,
  type PreviewRequest,
  type PreviewResult,
  type PreviewRevealResult,
  type PreviewSource,
} from "@shared/preview";
import { raisedHands } from "./signals/raised-hands";
import { SquadRepository, type SquadRepositoryError } from "./squads/repository";
import type { SquadDeleteResult, SquadResult, SquadSaveInput } from "@shared/squads";
import { SeatGuidanceRepository } from "./seat-guidance/repository";
import type { SeatOffboardCloser } from "./seat-sessions/offboard-close";
import { startSeatSessions, type SeatSessions } from "./seat-sessions/start-seat-sessions";
import { closingFence } from "./term/closing-fence";
import { makeOnboardNudgeInterject, watchSeatReadiness } from "./term/onboard-nudge-interject";
import { buildOnboardNudge } from "@shared/managed-terminal-injection";
import {
  onboardNudgeRefusal,
  type SeatOnboardNudgeResult,
} from "@shared/seat-onboarding-status";
import {
  composeOffboardAsk,
  OFFBOARD_MODES,
  type OffboardMode,
  type SeatOffboardAskResult,
} from "@shared/seat-sessions";
import { wireTrafficPreview, type WireTrafficEvent } from "@shared/wire-traffic";
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
import { onCanvasChangeForEdgeMap } from "./work/edge-map-notify";
import { WorkRepository } from "./work/repository";
import { CrewRepository } from "./work/crew-repository";
import { makeCheckoutWatchComposition } from "./work/checkout-watch-composition";
import type { CheckoutWatchSupervisor } from "./work/checkout-watch-live";
import { registerTerminalIpc } from "./term/ipc";
import { registerGitIpc } from "./git/ipc";
import { harnessRecordFor } from "../../shared/harness-records";
import { clipboardFormatsAreSafeForGrok } from "./term/drive/clipboard-safe";
import {
  isLiveClaudeResumeSummaryChoice,
} from "./term/drive/claude-startup";
import {
  rulePackFor,
  seatStateRuntime,
} from "./term/agent-state";
import {
  resolveSeatAwarenessGate,
  seatAwarenessApiKey,
  seatAwarenessEnrolled,
  seatAwarenessPlane,
  SEAT_AWARENESS_ENV,
} from "./term/seat-awareness";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { mergeSeatStateSnapshot, remoteSeatStateEvents } from "./term/remote-seat-state";
import { registerOperatorHoldsIpc } from "./term/operator-holds";
import { injectionSupervisor } from "./term/injection-supervisor";
import { removeRegionSecret, saveRegionSecret } from "./region-env/secret-ipc";
import {
  handleSeatCacheDueAnswer,
  handleSeatOffboardRun,
  handleSeatOffboardStatus,
  seatCacheDueForWindow,
} from "./seat-sessions/operator-offboard-ipc";
import { onSeatViewQuestions } from "./term/seat-views";
import { regionEnvReport, regionEnvStaleSeats } from "./region-env/report-ipc";
import {
  factoryBoardTransport,
  wireFactorySupervisor,
} from "./term/factory-delivery-composition";
import { terminalObserverPlane } from "./term/observer";
import { termPlane } from "./term/plane";
import { isTrustedMainWebContents } from "./trusted-main-webcontents";
import { trustedRendererIpc } from "./trusted-main-webcontents";
import type { WorkMetadata, Part, TaskState } from "@shared/work-model";
import { makeUserMessage } from "@shared/task";
import {
  collaborationRequestMetadata,
  composeCollaborationRequestText,
  normalizeSeatCollaborationAsk,
  type SeatCollaborationAskResult,
} from "@shared/seat-collaboration";
import { ulid } from "ulid";
import type { BoardPost } from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import {
  MainAuthoringRefused,
  mainAuthoringGate,
  type MainAuthoringLabel,
} from "./main-authoring-gate";

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

/** Closes a seat's session once its agent offboarded and went idle. */
let offboardCloser: SeatOffboardCloser | undefined;
/** This machine's seat sessions: recorder, capture, drain, closer, operator offboard. */
let seatSessions: SeatSessions | undefined;

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

let seatCacheDuePush: Promise<void> = Promise.resolve();
/** The whole list of seats due the cache question, in order: a later push never lands before an earlier one. */
const pushSeatCacheDue = (): void => {
  seatCacheDuePush = seatCacheDuePush
    .then(async () => broadcast(IPC_CHANNELS.seatCacheDue, await seatCacheDueForWindow()))
    .catch((error: unknown) => console.error("[offboard] the seats due a choice could not be told:", error));
};

const runMainAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<A>,
): Promise<A> => mainAuthoringGate.run(label, operation);

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
): Effect.Effect<RendererActorResolution, never, ModelActorRefs> =>
  Effect.gen(function* () {
    const refs = yield* ModelActorRefs;
    const read = yield* refs.read(canvasName).pipe(Effect.result);
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
      read.success,
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

export const registerJuntoIpc = (): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);
  const ModelOpenInput = Schema.Struct({ canvas: CanvasName });
  privilegedIpc.handle(IPC_CHANNELS.modelCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(ModelService, (model) => model.listCanvasSummaries())),
  );
  privilegedIpc.handle(IPC_CHANNELS.modelOpen, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(ModelOpenInput)(input, { onExcessProperty: "error" });
      return yield* (yield* ModelService).open(query.canvas);
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.modelCommand, (_event, input: unknown) =>
    runMainAuthoring("ipc.model.command", () => AppRuntime.runPromise(Effect.gen(function* () {
      const command = yield* Schema.decodeUnknownEffect(Command)(input, { onExcessProperty: "error" });
      return yield* (yield* ModelService).command(command, "operator");
    }))),
  );
  privilegedIpc.handle(IPC_CHANNELS.modelActorRefs, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(ModelOpenInput)(input, { onExcessProperty: "error" });
      return yield* (yield* ModelActorRefs).read(query.canvas);
    })),
  );

  registerTerminalIpc(privilegedIpc, termPlane, {
    isTrustedSender: isTrustedMainWebContents,
    broadcast,
  });
  registerGitIpc(privilegedIpc);
  registerSettingsIpc(privilegedIpc, broadcast);
  registerShellEnvironmentIpc(privilegedIpc, shellEnvironment, broadcast);
  registerReferencesIpc(privilegedIpc, broadcast, (effect) => AppRuntime.runPromise(effect));
  // The renderer's tasks and artifacts: main's stores, main's ruler (resource-ipc.ts).
  registerResourceIpc(
    privilegedIpc,
    (effect) => AppRuntime.runPromise(effect),
    liveResourceIpcPorts(),
    broadcast,
    { task: TASKS_ENABLED, artifact: ARTIFACTS_ENABLED },
    {
      task: (operation) => runMainAuthoring("ipc.resource.task-apply", operation),
      artifact: (operation) => runMainAuthoring("ipc.resource.artifact-apply", operation),
    },
  );
  registerAutomationIpc(privilegedIpc, broadcast, (effect) => AppRuntime.runPromise(effect));
  registerObservabilityIpc(privilegedIpc, broadcast);
  if (FLEET_UI_ENABLED) {
    registerHostsIpc(privilegedIpc);
  }
  registerUpdateIpc(
    privilegedIpc,
    broadcast,
    app.getVersion(),
  );
  privilegedIpc.handle(IPC_CHANNELS.canvasDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const digest = yield* readModelDigest(name);
        return { digest };
      }),
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

  // The kernel plane: watcher/timer evaluation over every hydrated canvas,
  // running continuously in main regardless of window state.
  privilegedIpc.handle(IPC_CHANNELS.getKernelState, () =>
    AppRuntime.runPromise(Effect.map(KernelService, (kernel) => kernel.getSnapshot())),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentSeatStateSnapshot, () =>
    mergeSeatStateSnapshot(seatStateRuntime.currentEvents()),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentSeatViewed, async (_event, bindingId: unknown) => {
    if (typeof bindingId !== "string" || bindingId.length === 0) return;
    if (seatStateRuntime.snapshot(bindingId) !== undefined) {
      seatStateRuntime.viewed(bindingId);
      return;
    }
    // A seat on another machine: its machine holds the turn, so the view goes there.
    const remote = remoteSeatStateEvents().find((event) => event.bindingId === bindingId);
    if (remote === undefined || remote.state === "gone") return;
    const { makeSeatsProcessClient, remoteSeatMachine } = await import("./term/seats-client");
    const machine = await AppRuntime.runPromise(remoteSeatMachine(bindingId).pipe(
      Effect.tapCause((cause) => Effect.logWarning("seat view not sent: its machine could not be read", cause)),
      Effect.annotateLogs({ area: "seats", seat: bindingId }),
      Effect.orElseSucceed(() => undefined),
    ));
    if (machine !== undefined) await makeSeatsProcessClient(machine).viewed(bindingId, remote.epoch).catch(() => false);
  });

  registerOperatorHoldsIpc(privilegedIpc);

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
              const model = yield* ModelService;
              const read = yield* Effect.result(
                model.canvas(draft.canvas),
              );
              if (read._tag === "Failure") {
                return {
                  ok: false as const,
                  error: `canvas ${JSON.stringify(draft.canvas)} could not be read`,
                };
              }
              const nodes = read.success.nodes;
              const source = nodes.get(asNodeId(draft.sourceNodeId));
              const target = nodes.get(asNodeId(draft.targetNodeId));
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
              if (target.kind !== "agent") {
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

  // Mail threads, for a seat's Threads popup: reads through the shared
  // derivation, and the operator's send into a thread.
  privilegedIpc.handle(IPC_CHANNELS.seatThreadsList, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(SeatThreadsPageQuery, { onExcessProperty: "error" })(input);
      return yield* seatThreadsPage(query.canvasName, query.nodeId, { limit: query.limit, after: query.after });
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadMessages, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(SeatThreadPageQuery, { onExcessProperty: "error" })(input);
      return yield* seatThreadMessagesPage(query.canvasName, query.nodeId, query.threadId, {
        limit: query.limit,
        before: query.before,
      });
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadMentionables, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(SeatThreadsQuery, { onExcessProperty: "error" })(input);
      return yield* mentionableSeats(query.canvasName, query.nodeId);
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadSend, async (_event, input: unknown): Promise<OperatorThreadSent> => {
    const decoded = Schema.decodeUnknownResult(OperatorThreadSend, { onExcessProperty: "error" })(input);
    if (Result.isFailure(decoded)) return { ok: false, reason: "invalid", message: "That mail could not be read." };
    try {
      const written = await runMainAuthoring("ipc.work.thread-send", () =>
        AppRuntime.runPromise(sendOperatorThreadMail(decoded.success)),
      );
      return await deliverOperatorThreadMail(decoded.success.canvasName, decoded.success.nodeId, written);
    } catch {
      // Fixed words: a thrown error may carry the mail's text.
      return { ok: false, reason: "failed", message: "The mail could not be sent." };
    }
  });
  // A file the operator attaches to mail, one piece at a time, staged as the
  // operator; the mail that names it claims it.
  privilegedIpc.handle(IPC_CHANNELS.operatorContentPut, async (_event, input: unknown): Promise<OperatorContentPutResult> => {
    const decoded = Schema.decodeUnknownResult(OperatorContentPut, { onExcessProperty: "error" })(input);
    if (Result.isFailure(decoded)) return { ok: false, message: "That piece of the file could not be read." };
    return AppRuntime.runPromise(putOperatorContent(decoded.success.canvasName, decoded.success.stage));
  });

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
  privilegedIpc.handle(IPC_CHANNELS.mailWaitingRead, () => messageDelivery.mailWaiting());
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
    async (_event, signalId: string, text: string, options?: AgentSignalAnswerOptions) => {
      const files = Schema.decodeUnknownResult(OperatorAttachments)(options?.attachments ?? []);
      if (Result.isFailure(files)) return { ok: false as const, message: "The attached files could not be read." };
      const result = await runSignalOperator(
        "ipc.work.signal-answer",
        answerAgentSignal(String(signalId), String(text), {
          silent: options?.silent === true,
          attachments: files.success,
        }),
      );
      // The answer is durable mail now; typing it into the seat follows the
      // ordinary delivery path (at once when live, else when it comes up).
      // A silent answer carries no mail: nothing is typed, nothing starts.
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

  // Previews of the files an agent names in a signal's detail. The detail is
  // read here from the store, never taken from the renderer, and the read
  // serves only the paths that text names (preview/read.ts holds the rules).
  const previewSourceSignal = (source: unknown): Promise<AgentSignal | undefined> => {
    const candidate = source as Partial<PreviewSource> | null;
    if (candidate?.kind !== "signal" || typeof candidate.signalId !== "string") {
      return Promise.resolve(undefined);
    }
    return AppRuntime.runPromise(
      Effect.flatMap(AgentSignalRepository, (signals) => signals.get(candidate.signalId as string)).pipe(
        Effect.map((signal): AgentSignal | undefined => signal),
        Effect.orElseSucceed(() => undefined),
      ),
    ).catch(() => undefined);
  };
  const previewThumbnail: PreviewThumbnailer = (bytes, edge) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    if (Math.max(width, height) <= edge) return undefined;
    const scaled = width >= height ? image.resize({ width: edge, quality: "good" }) : image.resize({ height: edge, quality: "good" });
    return scaled.isEmpty() ? undefined : { bytes: scaled.toPNG(), mediaType: "image/png" };
  };
  privilegedIpc.handle(IPC_CHANNELS.previewRead, async (_event, request: PreviewRequest): Promise<PreviewResult> => {
    const target = request?.target;
    const render = {
      variant: request?.variant === "thumb" ? ("thumb" as const) : ("full" as const),
      thumbnail: previewThumbnail,
      thumbEdge: PREVIEW_THUMB_EDGE,
    };
    const signal = await previewSourceSignal(request?.source);
    // An attachment is served by the signal's own list: its place there, then
    // the content store's file for that reference. No path from anyone.
    if (target?.kind === "attachment") {
      const attachment = Number.isInteger(target.index) ? signal?.attachments?.[target.index] : undefined;
      if (!attachment) return { ok: false, reason: "not-named" };
      const open = (ref: ContentRef) =>
        AppRuntime.runPromise(Effect.flatMap(ContentService, (content) => content.openForRead(ref))).catch(() => undefined);
      if ("kind" in attachment) {
        if (attachment.kind === "commit") {
          return { ok: true, kind: "commit", name: attachment.sha.slice(0, 7), sha: attachment.sha };
        }
        if (attachment.kind === "link") {
          return { ok: true, kind: "link", name: previewLinkName(attachment.url), url: attachment.url };
        }
        // A task or an artifact is a chip that opens it on the canvas, never a preview.
        if (attachment.kind === "task" || attachment.kind === "artifact") return { ok: false, reason: "not-named" };
        const [before, after] = await Promise.all([open(attachment.before), open(attachment.after)]);
        if (before?.state !== "verified" || after?.state !== "verified") return { ok: false, reason: "missing" };
        return readComparePreview({
          beforePath: before.path,
          afterPath: after.path,
          name: attachment.name ?? attachment.after.displayName ?? "changes",
        });
      }
      const opened = await open(attachment.ref);
      if (opened?.state !== "verified") return { ok: false, reason: "missing" };
      return readAttachmentPreview({
        objectPath: opened.path,
        byteLength: opened.byteLength,
        name: attachment.ref.displayName ?? "file",
        streamUrl: contentObjectUrl(attachment.ref),
        ...render,
      });
    }
    if (target?.kind !== "path" || typeof target.path !== "string") return { ok: false, reason: "not-named" };
    return readPreview({ text: signal?.detail, path: target.path, ...render });
  });
  privilegedIpc.handle(
    IPC_CHANNELS.previewReveal,
    async (_event, source: PreviewSource, path: string): Promise<PreviewRevealResult> => {
      if (typeof path !== "string") return { ok: false };
      const real = await locatePreviewForReveal((await previewSourceSignal(source))?.detail, path);
      if (real === undefined) return { ok: false };
      shell.showItemInFolder(real);
      return { ok: true };
    },
  );
  // Play on a video at a web address: only an address the signal itself
  // carries, and only now is anything allowed to fetch it.
  privilegedIpc.handle(
    IPC_CHANNELS.previewPlay,
    async (_event, source: PreviewSource, index: number): Promise<PreviewPlayResult> => {
      const attachment = Number.isInteger(index) ? (await previewSourceSignal(source))?.attachments?.[index] : undefined;
      if (!attachment || !("kind" in attachment) || attachment.kind !== "link") return { ok: false };
      return { ok: true, url: remoteVideos.open(attachment.url) };
    },
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
    const saved = await runSquad(
      Effect.flatMap(SquadRepository, (repository) =>
        repository.save({
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

  // Region environment: Junto's own secret store on this machine. The value
  // arrives once and no handler returns it. An install-local store like seat
  // guidance (no canvas authoring), so it runs outside the main-authoring gate.
  privilegedIpc.handle(IPC_CHANNELS.regionEnvSaveSecret, (_event, input: unknown) =>
    saveRegionSecret(input),
  );
  privilegedIpc.handle(IPC_CHANNELS.regionEnvRemoveSecret, (_event, secretId: unknown) =>
    removeRegionSecret(secretId),
  );
  // Read-only: names, kinds, origins and status of what a region resolves to.
  privilegedIpc.handle(
    IPC_CHANNELS.regionEnvReport,
    (_event, canvasName: unknown, regionId: unknown) =>
      regionEnvReport(canvasName, regionId),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.regionEnvStaleSeats,
    (_event, canvasName: unknown, regionId: unknown) =>
      regionEnvStaleSeats(canvasName, regionId),
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
            const work = yield* WorkService;
            return yield* work.workArtifactDelete(canvas, nodeId, artifactId);
          }),
        ),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.workItem, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkItemQuery, { onExcessProperty: "error" })(input);
      return yield* (yield* WorkRepository).taskItem(query);
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.workActorPage, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkActorQuery, { onExcessProperty: "error" })(input);
      return yield* (yield* WorkRepository).actorPage(query);
    })),
  );
  privilegedIpc.handle(IPC_CHANNELS.workAttention, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery, { onExcessProperty: "error" })(input);
      return yield* (yield* WorkRepository).attentionSnapshot(query);
    })),
  );

  privilegedIpc.handle(IPC_CHANNELS.workTaskPolicy, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery, { onExcessProperty: "error" })(input);
      return yield* (yield* WorkRepository).taskPolicy(query);
    })),
  );

  privilegedIpc.handle(IPC_CHANNELS.workSinkPage, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkSinkQuery, { onExcessProperty: "error" })(input);
      return yield* (yield* WorkRepository).sinkPage(query);
    })),
  );

  privilegedIpc.handle(IPC_CHANNELS.workMailPage, (_event, input: unknown) =>
    AppRuntime.runPromise(Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(WorkMailQuery, { onExcessProperty: "error" })(input);
      const repository = yield* WorkRepository;
      return yield* repository.mailPage(query);
    })),
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
              return {
                ok: true as const,
                data: { wakeCount },
                disposition: "applied" as const,
              };
            }),
          ),
      ),
  );

  AppRuntime.runFork(Effect.flatMap(ModelService, (model) => model.changes.pipe(
    Stream.runForEach((event) => Effect.sync(() => broadcast(IPC_CHANNELS.modelChanged, event))),
  )));
  AppRuntime.runFork(Effect.flatMap(ModelService, (model) => model.canvasesChanges.pipe(
    Stream.runForEach((event) => Effect.sync(() => broadcast(IPC_CHANNELS.modelCanvasesChanged, event))),
  )));
  AppRuntime.runFork(Effect.flatMap(ModelActorRefs, (refs) => refs.changes.pipe(
    Stream.runForEach((event) => Effect.sync(() => broadcast(IPC_CHANNELS.modelActorRefsChanged, event))),
  )));

  // Wire pushes and background loops once at startup.
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const modelForBoot = yield* ModelService;
      const usage = yield* UsageService;
      const kernel = yield* KernelService;
      const coreMail = yield* MachineCoreMail;
      const settingsForSeed = yield* SettingsService;
      const settingsAtBoot = yield* settingsForSeed.get;
      yield* Effect.tryPromise({
        try: () => runMainAuthoring("startup.canvas.ensure-seed", () => AppRuntime.runPromise(modelForBoot.ensureSeed)),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
      const mailRepository = yield* WorkRepository;
      mailRepository.subscribeChanges((canvasName, nodeId, kind) => {
        if (kind === "mail") broadcast(IPC_CHANNELS.workMailChanged, { canvasName, nodeId });
        else broadcast(IPC_CHANNELS.workSinkChanged, { canvasName, nodeId });
      });
      // Keep the last model topology for compact connection-change notices.
      const modelForNotices = yield* ModelService;
      const noticeCanvases = new Map<string, Canvas>();
      for (const name of yield* modelForNotices.listCanvases()) {
        noticeCanvases.set(name, yield* modelForNotices.canvas(name));
      }
      modelForNotices.subscribeChanges((event, next) => {
        const previous = noticeCanvases.get(event.canvas);
        noticeCanvases.set(event.canvas, next);
        void AppRuntime.runPromise(onCanvasChangeForEdgeMap(event.canvas, { previous, next }));
      });
      modelForNotices.subscribeCanvasesChanges((event, current) => {
        if (event._tag === "Removed") noticeCanvases.delete(event.canvas);
        else if (current) noticeCanvases.set(event.canvas, current);
      });
      if (USAGE_ENABLED) {
        usage.subscribe((state) => broadcast(IPC_CHANNELS.usageChanged, state));
      }
      kernel.subscribe((snapshot) => {
        broadcast(IPC_CHANNELS.kernelChanged, snapshot);
      });

      let productAutomationSuspended = false;
      let checkoutWatch: CheckoutWatchSupervisor | undefined;
      const acceptedClaudeRecoveryEpoch = new Map<string, string>();
      // Advisory seat-awareness sidecar, an experimental feature. Enrollment is
      // the Settings toggle: a discovered key is not consent. Off, the plane is
      // not running at all; on with no key it publishes missing_key. The toggle
      // applies live: a change stops the plane and, when on, starts it again.
      // Display only, and never on the terminal path.
      seatAwarenessPlane.subscribe((event) =>
        broadcast(IPC_CHANNELS.seatAwarenessChanged, event),
      );
      const applySeatAwareness = (settings: typeof settingsAtBoot): void => {
        if (!SEAT_AWARENESS_COMPILED) return;
        const on = resolveSeatAwarenessGate({
          env: process.env[SEAT_AWARENESS_ENV],
          enrolled: seatAwarenessEnrolled(settings),
        }).enabled;
        if (on === seatAwarenessPlane.isEnabled()) return;
        seatAwarenessPlane.stop();
        if (on) seatAwarenessPlane.start({ enabled: true, apiKey: seatAwarenessApiKey() });
      };
      applySeatAwareness(settingsAtBoot);
      settingsForSeed.subscribe(applySeatAwareness);
      const { drive: managedDrive, mailReadyNow, driveReady } = coreMail.seats;
      // Electron alone can inspect the pasteboard before the harness receives text.
      coreMail.seats.setClipboardSafe((bindingId) =>
        harnessRecordFor(seatStateRuntime.machine.getSlot(bindingId)?.harness)?.pty.clipboardImageGuard !== true ||
        clipboardFormatsAreSafeForGrok(clipboard.availableFormats()),
      );
      const writeManagedPrompt = (
        bindingId: string,
        text: string,
        options?: {
          readonly queueTimeoutMs?: number;
          readonly ready?: boolean;
          /** See ManagedTerminalDrive WritePromptOptions.awaitTurnStart. */
          readonly awaitTurnStart?: boolean;
          /** See ManagedTerminalDrive WritePromptOptions.queueIfBusy. */
          readonly queueIfBusy?: boolean;
        },
      ) =>
        managedDrive.writePrompt(bindingId, text, {
          ready: options?.ready ?? driveReady(bindingId),
          ...(options ?? {}),
        });
      coreMail.seats.onSuspend(() => {
        productAutomationSuspended = true;
        checkoutWatch?.stop();
      });
      // Operator multi-prompt (RTS): the operator's text is prompt mail from
      // the operator, delivered like any other mail — at once when the seat
      // is live, else when it comes up.
      const appendManagedPrompt = (input: SeatPromptInput, senderName?: string) =>
        appendSeatPrompt((effect) => AppRuntime.runPromise(effect), input, senderName);
      privilegedIpc.handle(
        IPC_CHANNELS.terminalManagedPrompt,
        (_event, input: Parameters<typeof appendManagedPrompt>[0]) => appendManagedPrompt(input),
      );
      // Offboard: the operator asks from the seat, the agent writes its notes
      // with `junto offboard`, and the closer ends the session once the agent
      // is idle, in the mode the agent chose. Both prompts ride the mail path
      // above, so they reach the agent between turns.
      // The recorder, capture, drain, closer and operator offboard: the
      // same seat sessions a windowless core starts (start-seat-sessions.ts).
      seatSessions?.stop();
      const sessions = yield* Effect.promise(() =>
        startSeatSessions({
          run: (effect) => AppRuntime.runPromise(effect),
          onSuspend: (listener) => {
            coreMail.seats.onSuspend(listener);
          },
          sendPrompt: ({ bindingId, text, canvasName, nodeId }) =>
            appendManagedPrompt({ bindingId, text, canvasName, nodeId }),
          publish: (progress) => broadcast(IPC_CHANNELS.seatOffboardProgress, progress),
          publishDue: () => pushSeatCacheDue(),
        }),
      );
      seatSessions = sessions;
      offboardCloser = sessions.closer;
      const managedSeatOn = sessions.seatOn;
      privilegedIpc.handle(IPC_CHANNELS.seatOffboardProgressList, () => offboardCloser?.current() ?? []);
      // The auto cache mode's question: the seats due it, here and on linked machines, and the operator's answer.
      onSeatViewQuestions(() => pushSeatCacheDue());
      privilegedIpc.handle(IPC_CHANNELS.seatCacheDueList, () => seatCacheDueForWindow());
      privilegedIpc.handle(IPC_CHANNELS.seatCacheDueAnswer, (_event, input: unknown) => handleSeatCacheDueAnswer(input));
      // Operator offboard: ask or offboard now, one seat or many, and what the
      // buttons should say first. The same operation the overseer and the
      // automatic rules go through (seat-sessions/operator-offboard.ts).
      privilegedIpc.handle(IPC_CHANNELS.seatOffboardRun, (_event, input: unknown) =>
        handleSeatOffboardRun(input, "operator"),
      );
      privilegedIpc.handle(
        IPC_CHANNELS.seatOffboardStatus,
        (_event, canvasName: unknown, seatIds: unknown) => handleSeatOffboardStatus(canvasName, seatIds),
      );
      privilegedIpc.handle(
        IPC_CHANNELS.seatOffboardAsk,
        async (_event, canvasName: unknown, seatId: unknown, mode: unknown): Promise<SeatOffboardAskResult> => {
          if (typeof canvasName !== "string" || !canvasName || !isSeatGuidanceSeatId(seatId)) {
            return { ok: false, message: "Junto could not find that seat." };
          }
          if (!(OFFBOARD_MODES as ReadonlyArray<unknown>).includes(mode)) {
            return { ok: false, message: "Offboard to rest or to continue." };
          }
          const offboardMode = mode as OffboardMode;
          const seat = await managedSeatOn({ canvasName, seatId });
          if (seat === undefined) return { ok: false, message: "Junto could not find that seat." };
          if (!seat.local) return { ok: false, message: "This seat runs on another installation." };
          const sent = await appendManagedPrompt({
            bindingId: seat.bindingId,
            text: composeOffboardAsk(offboardMode),
            canvasName,
            nodeId: seatId,
          });
          if (!sent.ok) return { ok: false, message: sent.error ?? "Junto could not send the offboard prompt." };
          offboardCloser?.asked({ seatId, canvasName }, offboardMode);
          return { ok: true };
        },
      );
      injectionSupervisor.subscribeOnboarding((event) =>
        broadcast(IPC_CHANNELS.seatOnboardingChanged, event),
      );
      privilegedIpc.handle(IPC_CHANNELS.seatOnboardingSnapshot, () =>
        injectionSupervisor.currentOnboarding(),
      );
      // The onboarding nudge is interjected: typed whatever the seat is
      // doing, mid-turn included, because a nudge that waits for a turn to
      // end can be hours late. It stays out of the operator's way: a dialog
      // waiting for an answer is never typed into, and the drive holds back
      // for a draft in the composer. Nothing is queued; a nudge that could
      // not be typed is tried again (or the operator presses again).
      const interjectOnboardNudge = makeOnboardNudgeInterject({
        suspended: () => productAutomationSuspended,
        sealed: (bindingId) => closingFence.sealed(bindingId),
        mailReady: mailReadyNow,
        writeMail: (bindingId, text) => managedDrive.writeMail(bindingId, text),
      });
      // A seat nobody has mailed is otherwise first looked at when its first
      // turn starts, mid-turn, where a first look never says ready: the nudge
      // would be refused before the drive was asked, with nothing to retry it.
      watchSeatReadiness({
        subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
        mailReady: mailReadyNow,
      });
      // The operator's nudge: the same sentence, typed now.
      privilegedIpc.handle(
        IPC_CHANNELS.seatOnboardNudge,
        async (_event, canvasName: unknown, seatId: unknown): Promise<SeatOnboardNudgeResult> => {
          if (typeof canvasName !== "string" || !canvasName || typeof seatId !== "string" || !seatId) {
            return { ok: false, message: "Junto could not find that seat." };
          }
          const seat = await managedSeatOn({ canvasName, seatId });
          if (seat === undefined) return { ok: false, message: "Junto could not find that seat." };
          if (!seat.local) return { ok: false, message: "This seat runs on another installation." };
          if (termPlane.host.get(seat.bindingId)?.status !== "running") {
            return { ok: false, message: "This seat is not running." };
          }
          const outcome = await interjectOnboardNudge(seat.bindingId, buildOnboardNudge());
          if (outcome !== "written") return { ok: false, message: onboardNudgeRefusal(outcome) };
          // The cadence does not repeat what the operator just sent.
          injectionSupervisor.noteNudgeDelivered(seat.bindingId);
          return { ok: true };
        },
      );
      wireFactorySupervisor({
        supervisor: injectionSupervisor,
        interject: (bindingId, text) =>
          interjectOnboardNudge(bindingId, text).then((outcome) => outcome === "written"),
        write: writeManagedPrompt,
        composerVerdict: (bindingId) => seatStateRuntime.composerVerdict(bindingId),
        subscribeSnapshots: (listener) =>
          terminalObserverPlane.subscribeGlobal(listener),
      });
      // Grok ≥1.5s post-spawn before first paste (verified trap).
      termPlane.host.subscribeEvents((payload) => {
        if (payload.type === "output") return;
        if (payload.type !== "session") return;
        const bindingId = payload.bindingId;
        if (payload.status === "exited") {
          acceptedClaudeRecoveryEpoch.delete(bindingId);
          return;
        }
        if (payload.status !== "running") return;
        acceptedClaudeRecoveryEpoch.delete(bindingId);
        const harness = seatStateRuntime.machine.getSlot(bindingId)?.harness;
        const settleMs = harnessRecordFor(harness)?.pty.postSpawnSettleMs;
        if (settleMs !== undefined) managedDrive.markSpawned(bindingId, settleMs);
      }, { replayCurrentSessions: true });
      // A seat's declared signals ride its own snapshot, so its needs carry them.
      wireSeatReports({
        sessions: () => termPlane.host.list(),
        seatReported: (bindingId, report) => seatStateRuntime.seatReported(bindingId, report),
        subscribeSeatState: (listener) => seatStateRuntime.subscribe(listener),
        onSignalChanged: onAgentSignalChanged,
        signalsOf: (canvasName, nodeId) =>
          AppRuntime.runPromise(
            Effect.flatMap(AgentSignalRepository, (signals) => signals.listSeat({ canvasName, nodeId })),
          ),
      });
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
      });
      // Bulletin board operator megaphone reuses managed-prompt transport.
      const { configureBoardDelivery } = yield* Effect.promise(
        () => import("./work/board-delivery"),
      );
      configureBoardDelivery(
        factoryBoardTransport({ kernel, write: writeManagedPrompt }),
      );

      const crew = yield* CrewRepository;
      // A continuation line held by the seat's input box is said on the seat
      // the way held mail is.
      injectionSupervisor.subscribeContinuationHeld((bindingId, hold, line) => {
        const live = termPlane.host.get(bindingId);
        if (!live?.canvasName || !live.nodeId) return;
        broadcast(IPC_CHANNELS.wireTraffic, {
          canvasName: live.canvasName,
          toNodeId: live.nodeId,
          kind: "notice",
          messageId: `continuation:${bindingId}:${live.epoch}`,
          preview: wireTrafficPreview(line),
          at: Date.now(),
          held: hold,
        } satisfies WireTrafficEvent);
      });
      // Every message typed into a seat pulses its wire on the canvas.
      messageDelivery.subscribeDelivered((event) =>
        broadcast(IPC_CHANNELS.wireTraffic, event),
      );
      // Mail held on a seat past 30 minutes: the operator feed shows it. Display
      // only; nothing answers it back.
      messageDelivery.subscribeMailWaiting((fact) => broadcast(IPC_CHANNELS.mailWaiting, fact));
      const workRepository = yield* WorkRepository;
      checkoutWatch = makeCheckoutWatchComposition({
        model: yield* ModelService,
        actorRefs: yield* ModelActorRefs,
        settings: settingsForSeed,
        host: termPlane.host,
        crew,
        workRepository,
        messageDelivery,
        basisFor: canvasReceiptBasis,
        run: (effect) => AppRuntime.runPromise(effect),
        write: (effect) => runMainAuthoring("review.checkout", () => AppRuntime.runPromise(effect)),
        onError: (error) => console.error("[checkout-watch]", error),
      });
      const syncCheckoutWatch = (): void => {
        if (!productAutomationSuspended) checkoutWatch?.start();
        else checkoutWatch?.stop();
      };
      syncCheckoutWatch();

      // First usage fetch is fire-and-forget off the boot critical path;
      // provider fetches can take tens of seconds so it never blocks window open.
      if (USAGE_ENABLED) usage.start();

      settingsForSeed.subscribe((settings) => {
        syncCheckoutWatch();
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
  );
};
