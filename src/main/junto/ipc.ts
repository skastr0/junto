import { canvasReceiptBasis } from "./work/delivery-receipts";
import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from "electron";
import { Effect, Option, Result, Schema, Stream } from "effect";
import type { MailReadPoint, OperatorThreadSent } from "@shared/mail-threads";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../core-process/ops/main-index";
import { subscribe as subscribeCore } from "../core-process/push";
import { OperatorAttachments, type OperatorContentPutResult } from "@shared/operator-attachments";
import { SignalReply } from "@shared/signal-reply";
import { SignalSecretPutRequest } from "@shared/vault";
import { putSignalSecret } from "./vault/secret-put";
import { resolveJuntoHome } from "@shared/junto-home";
import { homedir } from "node:os";
import { resolvedSpawnEnv } from "./adapters/exec";
import { runTool } from "./region-env/tool";
import {
  IPC_CHANNELS,
  type AgentSignalAnswerOptions,
  type AgentSignalOperatorResult,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { Canvas } from "@shared/model";
import { AppRuntime } from "../runtime";
import { MachineCoreMail } from "../core-runtime";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { ModelService } from "./model/service";
import { ModelActorRefs } from "./model/actor-refs";
import { core } from "../core-process/main-client";
import { subscribe as onCorePush } from "../core-process/push";
import { asNodeId } from "@shared/model";

import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  productNodeKindEnabled,
  SEAT_AWARENESS_COMPILED,
  TASKS_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import { KernelService } from "./kernel/service";
import { registerHostsIpc } from "./hosts/ipc";
import type { AuthorityWindowData } from "@shared/authority";
import { registerSettingsIpc } from "./settings/ipc";
import { registerViewStateIpc } from "./view-state/ipc";
import { shellEnvironment } from "./shell-environment";
import { registerShellEnvironmentIpc } from "./shell-environment/ipc";
import { registerReferencesIpc } from "./references/ipc";
import { installArtifactMove, moveArtifacts } from "./work/artifact-move";
import { liveResourceIpcPorts, registerResourceIpc } from "./work/resource-ipc";
import { registerAutomationIpc } from "./automation/ipc";
import { registerArtifactLinksIpc } from "./work/artifact-links-ipc";
import { registerMentionIpc } from "./work/mention-ipc";
import { SqlClient } from "effect/unstable/sql";
import { readMentions } from "./work/mention-backlinks";
import { SettingsService } from "./settings/service";
import { registerObservabilityIpc } from "./observability";
import { registerUpdateIpc } from "./update/ipc";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { ContentService } from "./content/service";
import type { AgentSignal } from "@shared/agent-signals";
import { messageDelivery } from "./work/message-delivery";
import { appendSeatPrompt, type SeatPromptInput } from "./work/seat-prompt";
import { AgentSignalRepository } from "./signals/repository";
import { readSignalAttachmentPreview } from "./signals/attachment-preview";
import { onAgentSignalChanged } from "./signals/changes";
import { wireSeatReports } from "./term/agent-state/seat-reports";
import {
  locatePreviewForReveal,
  readPreview,
  type PreviewThumbnailer,
} from "./preview/read";
import { remoteVideos } from "./preview/remote-video";
import {
  PREVIEW_THUMB_EDGE,
  type PreviewPlayResult,
  type PreviewRequest,
  type PreviewResult,
  type PreviewRevealResult,
  type PreviewShotSource,
  type PreviewSource,
} from "@shared/preview";
import type { SquadDeleteResult, SquadResult, SquadSaveInput } from "@shared/squads";
import type { SeatOffboardCloser } from "./seat-sessions/offboard-close";
import { startSeatSessions, type SeatSessions } from "./seat-sessions/start-seat-sessions";
import { closingFence } from "./term/closing-fence";
import { makeOnboardNudgeInterject, watchSeatReadiness } from "./term/onboard-nudge-interject";
import { onboardNudgeRefusal } from "@shared/seat-onboarding-status";
import {
  composeOffboardAsk,
  OFFBOARD_MODES,
  type OffboardMode,
  type SeatOffboardAskResult,
} from "@shared/seat-sessions";
import { wireTrafficPreview, type WireTrafficEvent } from "@shared/wire-traffic";
import { isSeatGuidanceSeatId, type SeatGuidanceSetResult } from "@shared/seat-guidance";
import { bindSeatIpc } from "../core-process/ops/ipc-seats";
import type { ProfileDeleteResult, ProfileResult, ProfileSaveInput } from "@shared/agent-profiles";
import type { PortraitOverrideSetResult } from "@shared/portrait-overrides";
import {
  answerAgentSignal,
  dismissAgentSignal,
  listCanvasAgentSignals,
  replyAgentSignal,
} from "./signals/operator";
import { liveArtifactPorts } from "./work/artifact-control";
import { onCanvasChangeForEdgeMap } from "./work/edge-map-notify";
import { WorkRepository } from "./work/repository";
import { TaskRepository } from "./work/task-repository";
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
import { regionEnvReport } from "./region-env/report-ipc";
import { wireFactorySupervisor } from "./term/factory-delivery-composition";
import { terminalObserverPlane } from "./term/observer";
import { termPlane } from "./term/plane";
import { isTrustedMainWebContents } from "./trusted-main-webcontents";
import { trustedRendererIpc } from "./trusted-main-webcontents";
import {
  normalizeSeatCollaborationAsk,
  type SeatCollaborationAskResult,
} from "@shared/seat-collaboration";
import type { ActorRef } from "@shared/work-protocol";
import {
  mainAuthoringGate,
  type MainAuthoringLabel,
} from "./main-authoring-gate";

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
  privilegedIpc.handle(IPC_CHANNELS.modelCanvases, () => core.call("ipc.model.canvases", {}));
  privilegedIpc.handle(IPC_CHANNELS.modelOpen, (_event, input: unknown) =>
    core.call("ipc.model.open", { input }),
  );
  privilegedIpc.handle(IPC_CHANNELS.modelCommand, (_event, input: unknown) =>
    runMainAuthoring("ipc.model.command", () => core.call("ipc.model.command", { input })),
  );
  privilegedIpc.handle(IPC_CHANNELS.modelActorRefs, (_event, input: unknown) =>
    core.call("ipc.model.actorRefs", { input }),
  );

  registerTerminalIpc(privilegedIpc, termPlane, {
    isTrustedSender: isTrustedMainWebContents,
    broadcast,
  });
  registerGitIpc(privilegedIpc);
  registerSettingsIpc(privilegedIpc, broadcast);
  registerShellEnvironmentIpc(privilegedIpc, shellEnvironment, broadcast);
  registerReferencesIpc(privilegedIpc, broadcast);
  registerViewStateIpc(privilegedIpc, broadcast);
  // The renderer's tasks and artifacts: main's stores, main's ruler (resource-ipc.ts).
  const resourcePorts = liveResourceIpcPorts((canvasName) =>
    Effect.tryPromise({
      try: async () => (await core.call("ipc.work.topology", { canvasName })).canvas,
      catch: () => ({
        type: "InternalError" as const,
        message: `canvas ${canvasName} could not be read`,
        details: { retryable: true },
      }),
    }),
    // A task's or an artifact's comments, held at its node: read only.
    (canvasName, nodeId) =>
      Effect.tryPromise({
        try: () => core.call("ipc.work.mailbox", { canvasName, nodeId }),
        catch: () => ({
          type: "InternalError" as const,
          message: `the comments on ${nodeId} could not be read`,
          details: { retryable: true },
        }),
      }));
  registerResourceIpc(
    privilegedIpc,
    (effect) => AppRuntime.runPromise(effect),
    resourcePorts,
    broadcast,
    { task: TASKS_ENABLED, artifact: ARTIFACTS_ENABLED, file: productNodeKindEnabled("files") },
    {
      task: (operation) => runMainAuthoring("ipc.resource.task-apply", operation),
      artifact: (operation) => runMainAuthoring("ipc.resource.artifact-apply", operation),
      thread: (operation) => runMainAuthoring("ipc.resource.thread-post", operation),
    },
  );
  // Moving artifacts (0.11.1, 10): the overseer and the window run the same move, each under its caller's authoring label.
  installArtifactMove((input, by) => AppRuntime.runPromise(moveArtifacts(resourcePorts, input, by)));
  registerAutomationIpc(privilegedIpc, broadcast, (effect) => AppRuntime.runPromise(effect));
  // Where each seat, task, artifact and page is mentioned (work/mention-ipc.ts).
  registerMentionIpc(privilegedIpc, (effect) => AppRuntime.runPromise(effect), {
    topology: (canvasName) =>
      Effect.tryPromise({
        try: async () => (await core.call("ipc.work.topology", { canvasName })).canvas,
        catch: () => ({
          type: "InternalError" as const,
          message: `canvas ${canvasName} could not be read`,
          details: { retryable: true },
        }),
      }),
    read: (canvasName, key, limit, after) =>
      Effect.tryPromise({
        try: () => core.call("ipc.work.mentions", {
          canvasName,
          key,
          limit,
          ...(after === undefined ? {} : { after }),
        }),
        catch: () => ({
          type: "InternalError" as const,
          message: `the mentions on canvas ${canvasName} could not be read`,
          details: { retryable: true },
        }),
      }),
  }, broadcast);
  // The artifacts whose body links one (0.11, 02): read-only, over the same store the CLI reads.
  registerArtifactLinksIpc(
    privilegedIpc,
    (effect) => AppRuntime.runPromise(effect),
    {
      topology: (canvasName) =>
        Effect.tryPromise({
          try: async () => (await core.call("ipc.work.topology", { canvasName })).canvas,
          catch: () => ({
            type: "InternalError" as const,
            message: `canvas ${canvasName} could not be read`,
            details: { retryable: true },
          }),
        }),
    },
    broadcast,
  );
  registerObservabilityIpc(privilegedIpc, broadcast);
  if (FLEET_UI_ENABLED) {
    registerHostsIpc(privilegedIpc);
  }
  // The authority read (0.11/06 F5): null with the authority off, so a ship window shows none of it.
  privilegedIpc.handle(IPC_CHANNELS.authorityRead, () =>
    core.call("ipc.status.authority", {}),
  );
  registerUpdateIpc(
    privilegedIpc,
    broadcast,
    app.getVersion(),
  );
  privilegedIpc.handle(IPC_CHANNELS.canvasDigest, (_event, name: string) =>
    core.call("ipc.status.digest", { name }),
  );

  if (USAGE_ENABLED) {
    privilegedIpc.handle(IPC_CHANNELS.getUsage, () =>
      core.call("ipc.status.usageCurrent", {}),
    );

    privilegedIpc.handle(IPC_CHANNELS.refreshUsage, () =>
      core.call("ipc.status.usageRefresh", {}),
    );
  }

  // The kernel plane: seat and task evaluation over every hydrated canvas,
  // running continuously in main regardless of window state.
  privilegedIpc.handle(IPC_CHANNELS.getKernelState, () =>
    core.call("ipc.status.kernel", {}),
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
    await core.call("ipc.threads.remoteSeatViewed", { bindingId, epoch: remote.epoch });
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
      return runMainAuthoring("ipc.work.collaboration-ask", () =>
        core.call("ipc.threads.collaborationAsk", { draft }),
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
    core.call("ipc.threads.list", { input }),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadMessages, (_event, input: unknown) =>
    core.call("ipc.threads.messages", { input }),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadMentionables, (_event, input: unknown) =>
    core.call("ipc.threads.mentionables", { input }),
  );
  // The operator's read points, one per thread and shared with the phone
  // (work/mail-reads.ts). A mark never rejects: a refusal is undefined.
  privilegedIpc.handle(IPC_CHANNELS.seatThreadReads, (_event, input: unknown) =>
    core.call("ipc.threads.reads", { input }),
  );
  // The header's count: every thread of the seat, never the page the list holds.
  privilegedIpc.handle(IPC_CHANNELS.seatThreadUnread, (_event, input: unknown) =>
    core.call("ipc.threads.unread", { input }),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatThreadMarkRead, (_event, input: unknown): Promise<MailReadPoint | undefined> =>
    core.call("ipc.threads.markRead", { input }).catch(() => undefined),
  );
  subscribeCore(SEAT_THREAD_READ_CHANGED, (change) => broadcast(IPC_CHANNELS.seatThreadReadChanged, change));
  subscribeCore(MAIL_WAITING, (fact) => broadcast(IPC_CHANNELS.mailWaiting, fact));
  void core.call("ipc.threads.watch", {}).catch((error: unknown) => console.error("[threads] read points and waiting mail not watched:", error));
  privilegedIpc.handle(IPC_CHANNELS.seatThreadSend, async (_event, input: unknown): Promise<OperatorThreadSent> => {
    try {
      // The write alone holds the authoring gate; delivery follows it, as before.
      const sent = await runMainAuthoring("ipc.work.thread-send", () => core.call("ipc.threads.write", { input }));
      if ("ok" in sent) return sent;
      return await core.call("ipc.threads.deliver", sent);
    } catch {
      // Fixed words: a thrown error may carry the mail's text.
      return { ok: false, reason: "failed", message: "The mail could not be sent." };
    }
  });
  // A file the operator attaches to mail, one piece at a time, staged as the
  // operator; the mail that names it claims it.
  privilegedIpc.handle(IPC_CHANNELS.operatorContentPut, (_event, input: unknown): Promise<OperatorContentPutResult> =>
    core.call("ipc.content.operatorPut", { input }),
  );

  // Portrait overrides: the operator's per-seat character customization. An
  // install-local preference like settings (no canvas authoring), so it runs
  // outside the main-authoring gate; every change is broadcast as it stands.
  privilegedIpc.handle(IPC_CHANNELS.portraitOverridesList, () => core.call("ipc.content.portraitOverrides", {}));
  privilegedIpc.handle(
    IPC_CHANNELS.portraitOverrideSet,
    async (_event, seatId: unknown, override: unknown): Promise<PortraitOverrideSetResult> => {
      try {
        const saved = await core.call("ipc.content.portraitOverrideSet", { seatId, override });
        if (saved.ok) broadcast(IPC_CHANNELS.portraitOverride, { seatId: saved.seatId, override: saved.override });
        return saved;
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
  privilegedIpc.handle(IPC_CHANNELS.mailWaitingRead, () => core.call("ipc.threads.mailWaiting", {}));
  const runSignalOperator = (
    label: MainAuthoringLabel,
    program: Effect.Effect<AgentSignalOperatorResult, never, AgentSignalRepository | WorkService>,
  ): Promise<AgentSignalOperatorResult> =>
    // The window hears of the answer through the store's own change, as every
    // committed signal write is pushed from one place (main/index.ts), so this
    // path only answers the caller.
    runMainAuthoring(label, () => AppRuntime.runPromise(program))
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
  privilegedIpc.handle(
    IPC_CHANNELS.agentSignalReply,
    async (_event, signalId: string, reply: unknown) => {
      const decoded = Schema.decodeUnknownResult(SignalReply)(reply);
      if (Result.isFailure(decoded)) return { ok: false as const, message: "The reply could not be read." };
      const result = await runSignalOperator(
        "ipc.work.signal-reply",
        replyAgentSignal(String(signalId), decoded.success, {
          topology: (canvasName: string) =>
            Effect.tryPromise({
              try: () => AppRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readTopology(canvasName))),
              catch: () => ({
                type: "InternalError" as const,
                message: `canvas ${canvasName} could not be read`,
                details: { retryable: true },
              }),
            }).pipe(Effect.map((read) => read.canvas)),
          artifacts: liveArtifactPorts,
        }),
      );
      // The hand-in is durable mail now: typed into the seat as an answer is.
      if (result.ok && result.messageId !== undefined) {
        void messageDelivery
          .deliver(result.signal.canvasName, result.signal.nodeId, result.messageId)
          .catch(() => undefined);
      }
      return result;
    },
  );
  // The value a secret form asks for (0.12, N5): the window sends the signal
  // and the value only; main reads the region, the machine and the name from
  // the form the raise stored, writes through the vault's own port, and keeps
  // nothing but names. The value is never echoed, logged or answered with.
  privilegedIpc.handle(
    IPC_CHANNELS.signalSecretPut,
    async (_event, request: SignalSecretPutRequest) => {
      const decoded = Schema.decodeUnknownResult(SignalSecretPutRequest)(request);
      if (Result.isFailure(decoded)) return { ok: false as const, reason: "store-failed" as const, message: "The secret could not be read." };
      const result = await runMainAuthoring("ipc.work.signal-secret-put", () =>
        AppRuntime.runPromise(
          putSignalSecret(decoded.success, {
            home: resolveJuntoHome(),
            userHome: homedir(),
            run: runTool,
            path: async () => (await resolvedSpawnEnv()).PATH,
          }),
        ),
      // Never its text: a thrown message can hold anything the failure saw, and the
      // pane shows a refusal as a sentence. One sentence, no value, no detail.
      ).catch(() => ({ ok: false as const, reason: "store-failed" as const, message: "The secret was not set." }));
      if (result.ok && result.signal !== undefined) {
        if (result.messageId !== undefined) {
          void messageDelivery
            .deliver(result.signal.canvasName, result.signal.nodeId, result.messageId)
            .catch(() => undefined);
        }
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
    return core.call("ipc.library.signal", { signalId: candidate.signalId }).catch(() => undefined);
  };
  const previewThumbnail: PreviewThumbnailer = (bytes, edge) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    if (Math.max(width, height) <= edge) return undefined;
    const scaled = width >= height ? image.resize({ width: edge, quality: "good" }) : image.resize({ height: edge, quality: "good" });
    return scaled.isEmpty() ? undefined : { bytes: scaled.toPNG(), mediaType: "image/png" };
  };
  // The operator's purge of a page box comment's shot: this handler is its
  // only caller (tests/page-shot-purge.test.ts), under its own label.
  privilegedIpc.handle(IPC_CHANNELS.pageShotPurge, (_event, request: unknown): Promise<PageShotPurged> => {
    const named = request as Partial<PageShotPurgeRequest> | null;
    if (typeof named?.canvasName !== "string" || typeof named.nodeId !== "string" || typeof named.messageId !== "string") {
      return Promise.resolve({ ok: false, message: "That comment has no screenshot." });
    }
    const comment = { canvasName: named.canvasName, nodeId: named.nodeId, messageId: named.messageId };
    return runMainAuthoring("ipc.page-shot.purge", () => core.call("ipc.content.pageShotPurge", comment)).catch(() => ({
      ok: false as const,
      message: "The screenshot could not be removed.",
    }));
  });
  privilegedIpc.handle(IPC_CHANNELS.previewRead, async (_event, request: PreviewRequest): Promise<PreviewResult> => {
    const target = request?.target;
    const render = {
      variant: request?.variant === "thumb" ? ("thumb" as const) : ("full" as const),
      thumbnail: previewThumbnail,
      thumbEdge: PREVIEW_THUMB_EDGE,
    };
    // A page box comment's shot: the operator reaches every page, and
    // readPageShot serves it only while its thread holds the claim.
    const source = request?.source as Partial<PreviewShotSource> | undefined;
    if (source?.kind === "comment") {
      if (target?.kind !== "shot" || typeof source.canvasName !== "string" || typeof source.nodeId !== "string" || typeof source.messageId !== "string") {
        return { ok: false, reason: "not-named" };
      }
      const shot = await core
        .call("ipc.library.pageShot", { canvasName: source.canvasName, nodeId: source.nodeId, messageId: source.messageId })
        .catch(() => ({ ok: false, reason: "missing" }) as const);
      if (!shot.ok) return shot;
      const small = render.variant === "thumb" ? previewThumbnail(shot.bytes, PREVIEW_THUMB_EDGE) : undefined;
      const bytes = small?.bytes ?? shot.bytes;
      return {
        ok: true,
        kind: "image",
        name: "page box",
        byteLength: shot.ref.byteLength,
        mediaType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      };
    }
    const signal = await previewSourceSignal(request?.source);
    if (target?.kind === "attachment") {
      return readSignalAttachmentPreview({
        open: (ref) => core.call("content.openForRead", { ref }).catch(() => undefined),
        // Only the operator's open of a file reaches here: the seat's machine is asked for it now.
        pull: (named, away) => core.call("ipc.library.pullSignalFiles", { signal: named, away }).catch(() => undefined),
      }, { signal, index: target.index, render });
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
  const squadsNow = () => core.call("ipc.library.squadsList", {});
  const runSquad = async <A>(
    program: () => Promise<A>,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }> => {
    const result = await program().then(Result.succeed, (error: unknown) =>
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
    const saved = await runSquad(() =>
      core.call("ipc.library.squadSave", { name: String(raw.name ?? ""), body: raw.body as SquadSaveInput["body"] }),
    );
    return saved.ok ? { ok: true, squad: saved.value } : saved;
  });
  privilegedIpc.handle(
    IPC_CHANNELS.squadRename,
    async (_event, squadId: unknown, name: unknown): Promise<SquadResult> => {
      const id = squadIdOf(squadId);
      if (id === undefined) return { ok: false, message: "squad id is invalid" };
      const renamed = await runSquad(() => core.call("ipc.library.squadRename", { squadId: id, name: String(name ?? "") }));
      return renamed.ok ? { ok: true, squad: renamed.value } : renamed;
    },
  );
  privilegedIpc.handle(
    IPC_CHANNELS.squadDelete,
    async (_event, squadId: unknown): Promise<SquadDeleteResult> => {
      const id = squadIdOf(squadId);
      if (id === undefined) return { ok: false, message: "squad id is invalid" };
      const removed = await runSquad(() => core.call("ipc.library.squadRemove", { squadId: id }));
      return removed.ok ? { ok: true, squadId: removed.value } : removed;
    },
  );

  // Seat guidance: the operator's per-seat soul and instructions. An
  // install-local preference like portrait overrides (no canvas authoring), so
  // it runs outside the main-authoring gate. `junto onboard` reads the stored
  // rows, so a write is broadcast as it is stored.
  privilegedIpc.handle(IPC_CHANNELS.seatGuidanceList, () => core.call("ipc.library.guidanceList", {}));
  privilegedIpc.handle(
    IPC_CHANNELS.seatGuidanceSet,
    async (_event, seatId: unknown, guidance: unknown): Promise<SeatGuidanceSetResult> => {
      if (!isSeatGuidanceSeatId(seatId)) return { ok: false, message: "seat id is invalid" };
      const result = await core.call("ipc.library.guidanceSet", { seatId, guidance }).then(Result.succeed, (error: unknown) =>
        Result.fail({ message: error instanceof Error ? error.message : "seat guidance save failed" }),
      );
      if (Result.isFailure(result)) return { ok: false, message: result.failure.message };
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
      core.call("ipc.seats.regionEnvStaleSeats", { canvasName, regionId }),
  );

  // Agent profiles: saved agents placed from the add picker. Every change
  // pushes the whole list; refusals come back as a message, never a throw.
  const profilesNow = () => core.call("ipc.library.profilesList", {});
  const runProfile = async <A>(
    program: () => Promise<A>,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }> => {
    const result = await program().then(Result.succeed, (error: unknown) =>
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
    const saved = await runProfile(() =>
      core.call("ipc.library.profileSave", {
        ...(profileId === undefined ? {} : { profileId }),
        body: raw.body as ProfileSaveInput["body"],
      }),
    );
    return saved.ok ? { ok: true, profile: saved.value } : saved;
  });
  privilegedIpc.handle(
    IPC_CHANNELS.profileRename,
    async (_event, profileId: unknown, name: unknown): Promise<ProfileResult> => {
      const id = profileIdOf(profileId);
      if (id === undefined) return { ok: false, message: "profile id is invalid" };
      const renamed = await runProfile(() => core.call("ipc.library.profileRename", { profileId: id, name: String(name ?? "") }));
      return renamed.ok ? { ok: true, profile: renamed.value } : renamed;
    },
  );
  privilegedIpc.handle(
    IPC_CHANNELS.profileDelete,
    async (_event, profileId: unknown): Promise<ProfileDeleteResult> => {
      const id = profileIdOf(profileId);
      if (id === undefined) return { ok: false, message: "profile id is invalid" };
      const removed = await runProfile(() => core.call("ipc.library.profileRemove", { profileId: id }));
      return removed.ok ? { ok: true, profileId: removed.value } : removed;
    },
  );

  privilegedIpc.handle(IPC_CHANNELS.factoryPauseState, (_event, canvas: string) =>
    core.call("ipc.seats.factoryPauseState", { canvas }),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.factoryPauseSet,
    (_event, canvas: string, paused: boolean): Promise<FactoryPauseSetResult> =>
      core.call("ipc.seats.factoryPauseSet", { canvas, paused }),
  );

  // Image content put — canvas image nodes + note embeds. Content store only;
  // document carries ContentRef URLs, never Base64.
  privilegedIpc.handle(IPC_CHANNELS.contentPutImage, (_event, input: unknown) =>
    core.call("ipc.content.putImage", { input }),
  );

  privilegedIpc.handle(IPC_CHANNELS.workItem, (_event, input: unknown) =>
    core.call("ipc.work.item", { input }),
  );
  privilegedIpc.handle(IPC_CHANNELS.workAttention, (_event, input: unknown) =>
    core.call("ipc.work.attention", { input }),
  );

  privilegedIpc.handle(IPC_CHANNELS.workSinkPage, (_event, input: unknown) =>
    core.call("ipc.work.sinkPage", { input }),
  );

  privilegedIpc.handle(IPC_CHANNELS.workMailPage, (_event, input: unknown) =>
    core.call("ipc.work.mailPage", { input }),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.workSeatRecentOps,
    (
      _event,
      canvas: string,
      nodeId: string,
      limit?: number,
    ) =>
      core.call("ipc.work.seatRecentOps", { canvas, nodeId, ...(limit === undefined ? {} : { limit }) }),
  );

  // The model watches start in the core and publish; main forwards each
  // channel once to the window, as the settings watch does (ops/main-index.ts).
  for (const channel of [
    IPC_CHANNELS.modelChanged,
    IPC_CHANNELS.modelCanvasesChanged,
    IPC_CHANNELS.modelActorRefsChanged,
  ]) onCorePush(channel, (payload) => broadcast(channel, payload));
  void core.call("ipc.watch.model", {});
  void core.call("ipc.watch.modelCanvases", {});
  void core.call("ipc.watch.modelActorRefs", {});

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
      privilegedIpc.handle(IPC_CHANNELS.terminalManagedPrompt, (_event, input: SeatPromptInput) =>
        core.call("ipc.seats.managedPrompt", { input }),
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
      // The operator's nudge: the same sentence, typed now. The core asks the
      // plane (bound here) for the seat, its running state and the interject.
      bindSeatIpc({
        seatOn: managedSeatOn,
        seatRunning: (bindingId) => termPlane.host.get(bindingId)?.status === "running",
        interjectNudge: async (bindingId, text) => {
          const outcome = await interjectOnboardNudge(bindingId, text);
          return outcome === "written"
            ? { ok: true as const }
            : { ok: false as const, message: onboardNudgeRefusal(outcome) };
        },
        noteNudged: (bindingId) => injectionSupervisor.noteNudgeDelivered(bindingId),
      });
      privilegedIpc.handle(IPC_CHANNELS.seatOnboardNudge, (_event, canvasName: unknown, seatId: unknown) =>
        core.call("ipc.seats.onboardNudge", { canvasName, seatId }),
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
        session: (bindingId) => termPlane.host.get(bindingId),
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
      const workRepository = yield* WorkRepository;
      checkoutWatch = makeCheckoutWatchComposition({
        model: yield* ModelService,
        actorRefs: yield* ModelActorRefs,
        settings: settingsForSeed,
        host: termPlane.host,
        crew,
        workRepository,
        tasks: yield* TaskRepository,
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
