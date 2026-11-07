import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { type Context, Effect, Result, Schema } from "effect";
import type { CoreClients } from "./core-process/clients";
import { askCollaboration, registerThreadsIpc } from "./threads/threads-ipc";
import { subscribe as subscribeCore } from "./core-process/main-side/core-pushes";
import {
  IPC_CHANNELS,
} from "@shared/ipc";
import { ARTIFACT_LINKS_IPC_CHANNELS } from "@shared/artifact-links-ipc-channels";
import { RESOURCE_IPC_CHANNELS } from "@shared/resource-ipc-channels";
import { registerBrowserIpc } from "./browser/ipc";
import { registerSeatsIpc } from "./seats/seats-ipc";
import type { BrowserCore } from "../contract/core/browser";
import type { BrowserSessionService } from "./browser/sessions";
import { askOnEveryCore } from "./core-process/every-core";
import type { SurfacePlanes } from "./core-process/main-side/term-surface";
import type { UpdateInstall } from "./update";
import { subscribe as onCorePush } from "./core-process/main-side/core-pushes";

import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  productNodeKindEnabled,
  TASKS_ENABLED,
} from "@shared/features";
import { registerHostsIpc } from "./hosts/ipc";
import { registerSettingsIpc } from "./settings/ipc";
import { mainIndexCalls } from "./core-process/main-index-ipc";
import { registerViewStateIpc } from "./view-state/ipc";
import { registerShellEnvironmentIpc } from "./shell-environment/ipc";
import { registerReferencesIpc } from "./references/ipc";
import { registerLibraryIpc } from "./library/library-ipc";
import { registerContentIpc } from "./content/content-ipc";
import { registerAutomationIpc } from "./automation/ipc";
import { registerArtifactLinksIpc } from "./work/artifact-links-ipc";
import { registerMentionIpc } from "./work/mention-ipc";
import { registerWorkIpc } from "./work/work-ipc";
import { registerModelIpc } from "./model/model-ipc";
import { registerModelWatches } from "./model/watch-ipc";
import { registerStatusIpc } from "./status/status-ipc";
import { registerSignalsIpc } from "./signals/signals-ipc";
import { WIRE_TRAFFIC } from "../contract/core/channels";
import { registerObservabilityIpc } from "./observability/ipc";
import { registerUpdateIpc } from "./update/ipc";
import type { AgentSignal } from "@shared/agent-signals";
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
import type { SeatOffboardCloser } from "../core/seat-sessions/offboard-close";
import type { SeatSessions } from "../core/seat-sessions/start-seat-sessions";
import { registerTerminalIpc } from "./term/ipc";
import { registerSeatAwarenessIpc } from "./term/seat-awareness-ipc";
import { registerSeatCacheDueIpc } from "./term/seat-cache-due-ipc";
import { registerGitIpc } from "./git/ipc";
import { registerResourceIpcCore } from "./core-process/main-side/resources";
import {
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  type ResourceChangedPush,
  type ResourceThreadChangedPush,
} from "../contract/core/channels";
import { registerOperatorHoldsIpc } from "./term/operator-holds-ipc";
import { coreOperatorHolds } from "./core-process/main-side/seat-holds";
import { isTrustedMainWebContents } from "./trusted-main-webcontents";
import { trustedRendererIpc } from "./trusted-main-webcontents";
import {
  normalizeSeatCollaborationAsk,
  type SeatCollaborationAskResult,
} from "@shared/seat-collaboration";
import {
  mainAuthoringGate,
  type MainAuthoringLabel,
} from "../node/main-authoring-gate";

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

const runMainAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<A>,
): Promise<A> => mainAuthoringGate.run(label, operation);

/** What main's boot hands its IPC registrars: its clients of the core, the surface plane it owns, and the one update install. */
export type MainBoot = {
  /** Main's clients of the core's groups (core-process/clients.ts). */
  readonly core: Context.Context<CoreClients>;
  readonly surfacePlanes: SurfacePlanes;
  readonly update: UpdateInstall;
};

export const registerJuntoIpc = (boot: MainBoot): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);
  registerModelIpc(privilegedIpc, boot.core, (operation) => runMainAuthoring("ipc.model.command", operation));

  // With the core in its own process the plane is the core's: main binds none.
  // Main holds no terminal plane: the core runs it, and every call below
  // reaches it through the terminal group (term/ipc.ts).
  registerTerminalIpc(privilegedIpc, {
    isTrustedSender: isTrustedMainWebContents,
    broadcast,
    surfacePlane: boot.surfacePlanes.current,
  }, boot.core);
  registerGitIpc(privilegedIpc, boot.core);
  registerSettingsIpc(privilegedIpc, broadcast, boot.core);
  registerShellEnvironmentIpc(privilegedIpc, broadcast, boot.core);
  registerReferencesIpc(privilegedIpc, broadcast, boot.core);
  registerViewStateIpc(privilegedIpc, broadcast, boot.core);
  // The renderer's tasks and artifacts: the core's stores and the core's
  // ruler (ops/ipc-resources.ts), told to the window as a change lands.
  registerResourceIpcCore(
    privilegedIpc,
    boot.core,
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
  registerAutomationIpc(privilegedIpc, boot.core);
  subscribeCore(IPC_CHANNELS.automationsChanged, (event) => broadcast(IPC_CHANNELS.automationsChanged, event));
  // Where each seat, task, artifact and page is mentioned (work/mention-ipc.ts).
  registerMentionIpc(privilegedIpc, broadcast, boot.core);
  // The artifacts whose body links one (0.11, 02): read-only, answered by the
  // core's work group where the store is (`WorkArtifactLinks`), and the
  // artifact change relayed above tells the panes to read again.
  registerArtifactLinksIpc(privilegedIpc, boot.core);
  registerObservabilityIpc(privilegedIpc, broadcast, boot.core);
  if (FLEET_UI_ENABLED) {
    registerHostsIpc(privilegedIpc, boot.core);
  }
  // The status reads: the authority banner, a canvas digest, usage and the kernel snapshot.
  registerStatusIpc(privilegedIpc, boot.core);
  registerUpdateIpc(
    privilegedIpc,
    broadcast,
    app.getVersion(),
    boot.update,
  );
  // The holds themselves are the core's, where the cache cut asks: main sends
  // each window's report on and keeps none (core-process/ops/seat-holds.ts).
  const operatorHolds = registerOperatorHoldsIpc(
    privilegedIpc,
    coreOperatorHolds(boot.core),
    // Once admission closes the app is going: the core takes its holds with it.
    () => mainAuthoringGate.snapshot().phase === "open",
  );
  // A core that starts again has no holds: every window's last report goes again.
  askOnEveryCore("seats.holds.replay", () => operatorHolds.replay());

  // The plane runs in the core, where the seats and their windows are; main
  // asks it for the latest event per binding a renderer hydrates from, and
  // for the gate seat collaboration reads (term/seat-awareness-ipc.ts).
  const seatAwareness = registerSeatAwarenessIpc(privilegedIpc, boot.core);

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
      if (!(await seatAwareness.enabled())) {
        return {
          ok: false as const,
          error: "seat collaboration is off: turn on Seat awareness in Settings, Experimental",
        };
      }
      const normalized = normalizeSeatCollaborationAsk(input);
      if (!normalized.ok) return normalized;
      const draft = normalized.draft;
      return runMainAuthoring("ipc.work.collaboration-ask", () =>
        askCollaboration(boot.core, draft),
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
  registerThreadsIpc(privilegedIpc, broadcast, boot.core, {
    send: (operation) => runMainAuthoring("ipc.work.thread-send", operation),
  });
  // The window's library (squads, seat guidance, profiles, the preview's reads) and its content
  // writes (operator uploads, image puts, portrait overrides), each asked of its core group
  // (library/library-ipc.ts, content/content-ipc.ts).
  const library = registerLibraryIpc(privilegedIpc, broadcast, boot.core);
  const content = registerContentIpc(privilegedIpc, broadcast, boot.core);

  // Agent signals: the operator reads every seat's claim on a canvas, answers
  // one (typed into the seat as operator mail, then marked answered), or
  // dismisses it. Every change is broadcast as the signal now stands.
  registerSignalsIpc(privilegedIpc, boot.core, {
    answer: (operation) => runMainAuthoring("ipc.work.signal-answer", operation),
    reply: (operation) => runMainAuthoring("ipc.work.signal-reply", operation),
    secretPut: (operation) => runMainAuthoring("ipc.work.signal-secret-put", operation),
    dismiss: (operation) => runMainAuthoring("ipc.work.signal-dismiss", operation),
  });

  // Previews of the files an agent names in a signal's detail. The detail is
  // read here from the store, never taken from the renderer, and the read
  // serves only the paths that text names (preview/read.ts holds the rules).
  const previewSourceSignal = (source: unknown): Promise<AgentSignal | undefined> => {
    const candidate = source as Partial<PreviewSource> | null;
    if (candidate?.kind !== "signal" || typeof candidate.signalId !== "string") {
      return Promise.resolve(undefined);
    }
    return library.signal(candidate.signalId).catch(() => undefined);
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
    return runMainAuthoring("ipc.page-shot.purge", () => content.purgePageShot(comment)).catch(() => ({
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
      const shot = await library
        .pageShot({ canvasName: source.canvasName, nodeId: source.nodeId, messageId: source.messageId })
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
        open: (ref) => mainIndexCalls(boot.core).openForRead(ref).catch(() => undefined),
        // Only the operator's open of a file reaches here: the seat's machine is asked for it now.
        pull: (named, away) => library.pullFiles(named, away).catch(() => undefined),
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


  // The seat calls: region environment, pause plane, the operator's prompt,
  // offboard ask and progress, and the onboarding nudge (seats/seats-ipc.ts).
  registerSeatsIpc(privilegedIpc, boot.core);



  registerWorkIpc(privilegedIpc, boot.core);

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
    IPC_CHANNELS.authorityChanged,
  ]) onCorePush(channel, (payload) => broadcast(channel, payload));
  registerModelWatches(boot.core);

  // What the startup wiring needs of the core's services runs in the core
  // (ops/ipc-startup.ts): the seed, the connection-change notices, the checkout
  // watch, usage, the onboarding nudge's interject and Claude's resume
  // recovery. Main keeps the window's handlers and what only it holds.

  // The advisory seat-awareness plane runs in the core, where the seats and
  // their windows are, and is started from the settings there
  // (term/seat-awareness-live.ts); its events arrive on the push stream above.

  // Offboard: the operator asks from the seat, the agent writes its notes
  // with `junto offboard`, and the core's closer ends the session once the
  // agent is idle, in the mode the agent chose.
  onCorePush(IPC_CHANNELS.seatOffboardProgress, (progress) => broadcast(IPC_CHANNELS.seatOffboardProgress, progress));
  // The auto cache mode's question, here and on linked machines, and the
  // operator's offboard buttons: the core's, where the seats and their views
  // run (term/seat-cache-due-ipc.ts).
  registerSeatCacheDueIpc(privilegedIpc, broadcast, boot.core);
  subscribeCore(IPC_CHANNELS.seatOnboardingChanged, (event) =>
    broadcast(IPC_CHANNELS.seatOnboardingChanged, event),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerJuntoBrowserIpc = (sessions: BrowserSessionService, core: Context.Context<BrowserCore>): void => {
  if (!BROWSER_ENABLED) return;
  registerBrowserIpc(
    trustedRendererIpc(ipcMain),
    sessions,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
    core,
  );
};
