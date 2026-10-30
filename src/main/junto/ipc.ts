import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { Effect, Result, Schema } from "effect";
import type { MailReadPoint, OperatorThreadSent } from "@shared/mail-threads";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../core-process/channels";
import { subscribe as subscribeCore } from "../core-process/push";
import { OperatorAttachments, type OperatorContentPutResult } from "@shared/operator-attachments";
import { SignalReply } from "@shared/signal-reply";
import { SignalSecretPutRequest } from "@shared/vault";
import {
  IPC_CHANNELS,
  type AgentSignalAnswerOptions,
  type AgentSignalOperatorResult,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import { ARTIFACT_LINKS_IPC_CHANNELS } from "@shared/artifact-links-ipc-channels";
import { RESOURCE_IPC_CHANNELS } from "@shared/resource-ipc-channels";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { ModelActorRefs } from "./model/actor-refs";
import { askOnEveryCore } from "../core-process/every-core";
import { core } from "../core-process/main-client";
import { subscribe as onCorePush } from "../core-process/push";

import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  productNodeKindEnabled,
  TASKS_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import { registerHostsIpc } from "./hosts/ipc";
import type { AuthorityWindowData } from "@shared/authority";
import { registerSettingsIpc } from "./settings/ipc";
import { registerViewStateIpc } from "./view-state/ipc";
import { shellEnvironment } from "./shell-environment";
import { registerShellEnvironmentIpc } from "./shell-environment/ipc";
import { registerReferencesIpc } from "./references/ipc";
import { registerAutomationIpc } from "./automation/ipc";
import { registerArtifactLinksIpc } from "./work/artifact-links-ipc";
import { registerMentionIpc } from "./work/mention-ipc";
import { WIRE_TRAFFIC } from "../core-process/channels";
import { registerObservabilityIpc } from "./observability";
import { registerUpdateIpc } from "./update/ipc";
import type { AgentSignal } from "@shared/agent-signals";
import { messageDelivery } from "./work/message-delivery";
import type { SeatPromptInput } from "./work/seat-prompt";
import { readSignalAttachmentPreview } from "./signals/attachment-preview";
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
import type { SeatSessions } from "./seat-sessions/start-seat-sessions";
import {
  composeOffboardAsk,
  OFFBOARD_MODES,
  type OffboardMode,
  type SeatOffboardAskResult,
} from "@shared/seat-sessions";
import { isSeatGuidanceSeatId, type SeatGuidanceSetResult } from "@shared/seat-guidance";
import { SEAT_CACHE_DUE_CHANGED } from "../core-process/channels";
import type { ProfileDeleteResult, ProfileResult, ProfileSaveInput } from "@shared/agent-profiles";
import type { PortraitOverrideSetResult } from "@shared/portrait-overrides";
import { registerTerminalIpc } from "./term/ipc";
import { registerGitIpc } from "./git/ipc";
import { serveSignalTools } from "../core-process/main-side/signals";
import { registerResourceIpcCore } from "../core-process/main-side/resources";
import {
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  type ResourceChangedPush,
  type ResourceThreadChangedPush,
} from "../core-process/channels";
import { resolvedSpawnEnv } from "./adapters/exec";
import { runTool } from "./region-env/tool";
import {
  isLiveClaudeResumeSummaryChoice,
} from "./term/drive/claude-startup";
import { registerOperatorHoldsIpc } from "./term/operator-holds-ipc";
import { coreOperatorHolds } from "../core-process/main-side/seat-holds";
import { removeRegionSecret, saveRegionSecret } from "./region-env/secret-ipc";
import { regionEnvReport } from "./region-env/report-ipc";
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
    .then(async () => broadcast(IPC_CHANNELS.seatCacheDue, await core.call("seatCacheDue.list", {})))
    .catch((error: unknown) => console.error("[offboard] the seats due a choice could not be told:", error));
};

const runMainAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<A>,
): Promise<A> => mainAuthoringGate.run(label, operation);

// The secret write's tool run and login PATH stay main's: the core asks for
// them by host call, and main's half is registered here, once, whichever
// process the core runs in.
serveSignalTools({
  run: (call) => runTool(call),
  path: async () => (await resolvedSpawnEnv()).PATH,
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

  // With the core in its own process the plane is the core's: main binds none.
  // Main holds no terminal plane: the core runs it, and every call below
  // reaches it by name (term/ipc.ts).
  registerTerminalIpc(privilegedIpc, {
    isTrustedSender: isTrustedMainWebContents,
    broadcast,
  });
  registerGitIpc(privilegedIpc);
  registerSettingsIpc(privilegedIpc, broadcast);
  registerShellEnvironmentIpc(privilegedIpc, shellEnvironment, broadcast);
  registerReferencesIpc(privilegedIpc, broadcast);
  registerViewStateIpc(privilegedIpc, broadcast);
  // The renderer's tasks and artifacts: the core's stores and the core's
  // ruler (ops/ipc-resources.ts), told to the window as a change lands.
  registerResourceIpcCore(
    privilegedIpc,
    core,
    { task: TASKS_ENABLED, artifact: ARTIFACTS_ENABLED, file: productNodeKindEnabled("files") },
    {
      task: (operation) => runMainAuthoring("ipc.resource.task-apply", operation),
      artifact: (operation) => runMainAuthoring("ipc.resource.artifact-apply", operation),
      thread: (operation) => runMainAuthoring("ipc.resource.thread-post", operation),
    },
  );
  subscribeCore(RESOURCE_CHANGED, (event) => {
    const notice = event as ResourceChangedPush;
    broadcast(notice.channel, { canvasName: notice.canvasName });
    // A body link lives or dies with an artifact write, and that write is the
    // only thing that changes one (work/body-links.ts): the same notice tells
    // the panes that read links.
    if (notice.channel === RESOURCE_IPC_CHANNELS.artifact.changed) {
      broadcast(ARTIFACT_LINKS_IPC_CHANNELS.changed, { canvasName: notice.canvasName });
    }
  });
  subscribeCore(RESOURCE_THREAD_CHANGED, (event) => {
    const notice = event as ResourceThreadChangedPush;
    broadcast(notice.channel, { canvasName: notice.canvasName, kind: notice.kind });
  });
  // A message typed into a seat, and a held line said on it, from the core.
  subscribeCore(WIRE_TRAFFIC, (event) => broadcast(IPC_CHANNELS.wireTraffic, event));
  registerAutomationIpc(privilegedIpc);
  subscribeCore(IPC_CHANNELS.automationsChanged, (event) => broadcast(IPC_CHANNELS.automationsChanged, event));
  // Where each seat, task, artifact and page is mentioned (work/mention-ipc.ts).
  registerMentionIpc(privilegedIpc, broadcast);
  // The artifacts whose body links one (0.11, 02): read-only, answered by the
  // core where the store is (`ipc.work.artifactLinks`), and the artifact change
  // relayed above tells the panes to read again.
  registerArtifactLinksIpc(privilegedIpc);
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
    core.call("ipc.threads.seatStates", {}),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentSeatViewed, async (_event, bindingId: unknown) => {
    if (typeof bindingId !== "string" || bindingId.length === 0) return;
    await core.call("ipc.threads.seatViewed", { bindingId });
  });

  // The holds themselves are the core's, where the cache cut asks: main sends
  // each window's report on and keeps none (core-process/ops/seat-holds.ts).
  const operatorHolds = registerOperatorHoldsIpc(
    privilegedIpc,
    coreOperatorHolds(core),
    // Once admission closes the app is going: the core takes its holds with it.
    () => mainAuthoringGate.snapshot().phase === "open",
  );
  // A core that starts again has no holds: every window's last report goes again.
  askOnEveryCore("seats.holds.replay", () => operatorHolds.replay());

  // The plane runs in the core, where the seats and their windows are; main
  // asks it for the latest event per binding a renderer hydrates from.
  privilegedIpc.handle(IPC_CHANNELS.seatAwarenessSnapshot, async () =>
    (await core.call("seats.awareness", {})).events,
  );

  // Seat collaboration — one seat asks a peer for help. The request is an
  // ordinary mailbox message, so delivery, wakes and the reply path are the
  // ones crew mail already owns; this handler only composes and validates it.
  // Operator-originated: the awareness sidecar can suggest a peer, but nothing
  // reaches a seat's mailbox unless the operator asks for it.
  privilegedIpc.handle(
    IPC_CHANNELS.seatCollaborationAsk,
    async (_event, input: unknown): Promise<SeatCollaborationAskResult> => {
      // The live plane is the resolved gate: compiled, and turned on in
      // Settings, Experimental (or shipped on). It runs in the core.
      if (!(await core.call("seats.awareness", {})).enabled) {
        return {
          ok: false as const,
          error: "seat collaboration is off: turn on Seat awareness in Settings, Experimental",
        };
      }
      const normalized = normalizeSeatCollaborationAsk(input);
      if (!normalized.ok) return normalized;
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
  askOnEveryCore("ipc.threads.watch", () => core.call("ipc.threads.watch", {}));
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
    core.call("ipc.signals.list", { canvasName: canvas }),
  );
  privilegedIpc.handle(IPC_CHANNELS.mailWaitingRead, () => core.call("ipc.threads.mailWaiting", {}));
  const runSignalOperator = (
    label: MainAuthoringLabel,
    operation: () => Promise<AgentSignalOperatorResult>,
  ): Promise<AgentSignalOperatorResult> =>
    // The window hears of the answer through the store's own change, as every
    // committed signal write is pushed from one place (main/index.ts), so this
    // path only answers the caller.
    runMainAuthoring(label, operation)
      .catch((error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : "signal update failed",
      }));
  privilegedIpc.handle(
    IPC_CHANNELS.agentSignalRespond,
    async (_event, signalId: string, text: string, options?: AgentSignalAnswerOptions) => {
      const files = Schema.decodeUnknownResult(OperatorAttachments)(options?.attachments ?? []);
      if (Result.isFailure(files)) return { ok: false as const, message: "The attached files could not be read." };
      const result = await runSignalOperator("ipc.work.signal-answer", () =>
        core.call("ipc.signals.answer", {
          signalId: String(signalId),
          text: String(text),
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
      const result = await runSignalOperator("ipc.work.signal-reply", () =>
        core.call("ipc.signals.reply", { signalId: String(signalId), reply: decoded.success }),
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
        core.call("ipc.signals.secretPut", { request: decoded.success }),
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
    runSignalOperator("ipc.work.signal-dismiss", () =>
      core.call("ipc.signals.dismiss", { signalId: String(signalId) }),
    ),
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
    IPC_CHANNELS.workMailChanged,
    IPC_CHANNELS.workSinkChanged,
    IPC_CHANNELS.seatAwarenessChanged,
    IPC_CHANNELS.usageChanged,
    IPC_CHANNELS.kernelChanged,
    IPC_CHANNELS.coreRestarted,
  ]) onCorePush(channel, (payload) => broadcast(channel, payload));
  askOnEveryCore("ipc.watch.model", () => core.call("ipc.watch.model", {}));
  askOnEveryCore("ipc.watch.modelCanvases", () => core.call("ipc.watch.modelCanvases", {}));
  askOnEveryCore("ipc.watch.modelActorRefs", () => core.call("ipc.watch.modelActorRefs", {}));

  // What the startup wiring needs of the core's services runs in the core
  // (ops/ipc-startup.ts): the seed, the connection-change notices, the checkout
  // watch, usage, the onboarding nudge's interject and Claude's resume
  // recovery. Main keeps the window's handlers and what only it holds.

  // The advisory seat-awareness plane runs in the core, where the seats and
  // their windows are, and is started from the settings there
  // (term/seat-awareness-live.ts); its events arrive on the push stream above.

  privilegedIpc.handle(IPC_CHANNELS.terminalManagedPrompt, (_event, input: SeatPromptInput) =>
    core.call("ipc.seats.managedPrompt", { input }),
  );
  // Offboard: the operator asks from the seat, the agent writes its notes
  // with `junto offboard`, and the core's closer ends the session once the
  // agent is idle, in the mode the agent chose.
  onCorePush(IPC_CHANNELS.seatOffboardProgress, (progress) => broadcast(IPC_CHANNELS.seatOffboardProgress, progress));
  privilegedIpc.handle(IPC_CHANNELS.seatOffboardProgressList, () => core.call("ipc.seats.offboardProgress", {}));
  // The auto cache mode's question: the seats due it, here and on linked machines, and the operator's answer.
  // Both are the core's, where the seats and their views run.
  onCorePush(SEAT_CACHE_DUE_CHANGED, () => pushSeatCacheDue());
  privilegedIpc.handle(IPC_CHANNELS.seatCacheDueList, () => core.call("seatCacheDue.list", {}));
  privilegedIpc.handle(IPC_CHANNELS.seatCacheDueAnswer, (_event, input: unknown) =>
    core.call("seatCacheDue.answer", { input }),
  );
  // Operator offboard: ask or offboard now, one seat or many, and what the
  // buttons should say first. The same operation the overseer and the
  // automatic rules go through (seat-sessions/operator-offboard.ts).
  privilegedIpc.handle(IPC_CHANNELS.seatOffboardRun, (_event, input: unknown) =>
    core.call("seatOffboard.run", { input }),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.seatOffboardStatus,
    (_event, canvasName: unknown, seatIds: unknown) => core.call("seatOffboard.status", { canvasName, seatIds }),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.seatOffboardAsk,
    (_event, canvasName: unknown, seatId: unknown, mode: unknown): Promise<SeatOffboardAskResult> =>
      core.call("ipc.seats.offboardAsk", { canvasName, seatId, mode }),
  );
  subscribeCore(IPC_CHANNELS.seatOnboardingChanged, (event) =>
    broadcast(IPC_CHANNELS.seatOnboardingChanged, event),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatOnboardingSnapshot, () =>
    core.call("ipc.threads.onboarding", {}),
  );
  privilegedIpc.handle(IPC_CHANNELS.seatOnboardNudge, (_event, canvasName: unknown, seatId: unknown) =>
    core.call("ipc.seats.onboardNudge", { canvasName, seatId }),
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
