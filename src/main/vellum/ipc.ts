import { BrowserWindow, ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS, type BindingHint, type WorkOpResult } from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { digestCanvas } from "@shared/digest";
import { buildGlyphView } from "@shared/glyph-view";
import { mergePortfolioInto } from "@shared/portfolio";
import { AppRuntime } from "../runtime";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { CanvasesService } from "./canvases";
import { pullCanvasesFromCommandCenter } from "./canvas-pull";
import { registerChatIpc } from "./chat/ipc";
import { ChatServiceContext } from "./chat/service";
import { HermesPlane } from "./hermes/plane";
import { registerHerdrIpc } from "./herdr/ipc";
import type { PulseRegionOptions } from "./kernel/service";
import { KernelService } from "./kernel/service";
import { RegionRollupService } from "./region-rollup";
import { registerHostsIpc } from "./hosts/ipc";
import { registerSettingsIpc } from "./settings/ipc";
import { SettingsService } from "./settings/service";
import { SnapshotsService } from "./snapshots";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { messageDelivery } from "./work/message-delivery";
import { stampMessageDelivered } from "@shared/message-delivery";
import { HerdrPlane } from "./herdr/plane";
import { registerTerminalIpc } from "./term/ipc";
import { termPlane } from "./term/plane";
import { getTrustedMainWebContents } from "./trusted-main-webcontents";
import type { A2AMetadata, Artifact, Message, TaskState } from "@shared/canvas";
import {
  MainAuthoringRefused,
  mainAuthoringGate,
  type MainAuthoringLabel,
} from "./main-authoring-gate";

const broadcast = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    // Guard: close/reopen races can leave a BrowserWindow whose webContents
    // is already destroyed (Object has been destroyed in main).
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
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

/** Remote stations pull canvases; they must not rewrite authorial SoT. */
const denyIfRemoteAuthorial = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const current = yield* settings.get;
  if (current.station.role === "remote") {
    return yield* Effect.fail(
      new Error(
        "Remote station cannot mutate authorial canvases. Author on the Command Center.",
      ),
    );
  }
});

export const registerVellumIpc = (): void => {
  registerHerdrIpc(ipcMain, () => BrowserWindow.getAllWindows().map((w) => w.webContents));
  registerTerminalIpc(ipcMain, termPlane, {
    isTrustedSender: (sender) => {
      const trusted = getTrustedMainWebContents();
      // Headless / pre-window: no trusted WC yet — admit live senders for tests.
      if (trusted === undefined) return !sender.isDestroyed();
      return trusted === sender;
    },
  });
  registerSettingsIpc(ipcMain, broadcast);
  registerHostsIpc(ipcMain);
  ipcMain.handle(IPC_CHANNELS.listCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.list)),
  );

  ipcMain.handle(IPC_CHANNELS.readCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.read(name))),
  );

  ipcMain.handle(IPC_CHANNELS.writeCanvas, (_event, name: string, doc: CanvasDoc, expectedRevision?: string) =>
    runMainAuthoring(
      "ipc.canvas.write",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyIfRemoteAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.write(name, doc, expectedRevision);
        }),
      ),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.createCanvas, (_event, name: string) =>
    runMainAuthoring(
      "ipc.canvas.create",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyIfRemoteAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.create(name);
        }),
      ),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.deleteCanvas, (_event, name: string) =>
    runMainAuthoring(
      "ipc.canvas.delete",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyIfRemoteAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.remove(name);
        }),
      ),
    ),
  );

  // Remote → Command Center canvas pull (read-only; never mutates CC).
  ipcMain.handle(IPC_CHANNELS.pullCanvases, () =>
    runMainAuthoring(
      "ipc.canvas.pull",
      () => AppRuntime.runPromise(pullCanvasesFromCommandCenter),
    ),
  );

  ipcMain.handle(IPC_CHANNELS.exportDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const snapshots = yield* SnapshotsService;
        const result = yield* canvases.read(name);
        const state = yield* snapshots.current;
        // Private glyph browse excised — empty view keeps criteria non-generating.
        const glyphs = buildGlyphView(result.doc, new Map());
        const digest = digestCanvas(name, result.doc, state, glyphs);
        const path = yield* canvases.writeSidecar(name, "digest.txt", digest);
        return { digest, path };
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.generatePortfolio,
    (_event, name: string, options?: { all?: boolean }) =>
      runMainAuthoring(
        "ipc.canvas.portfolio",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const canvases = yield* CanvasesService;
            const snapshots = yield* SnapshotsService;
            // Fresh full-corpus pull (no hints = base project lists from each source).
            const state = yield* snapshots.refresh([]);
            // mergePortfolioInto is idempotent. Run it through the retrying
            // document mutation boundary so a direct-file edit during refresh
            // is merged into, never overwritten by a stale pre-refresh read.
            yield* canvases.mutate(name, (doc) =>
              mergePortfolioInto(doc, state, { all: options?.all ?? false }),
            );
            return yield* canvases.read(name);
          }),
        ),
      ),
  );

  ipcMain.handle(IPC_CHANNELS.getSnapshots, () =>
    AppRuntime.runPromise(Effect.flatMap(SnapshotsService, (snapshots) => snapshots.current)),
  );

  ipcMain.handle(
    IPC_CHANNELS.refreshSnapshots,
    (_event, hints?: ReadonlyArray<BindingHint>) =>
      AppRuntime.runPromise(
        Effect.flatMap(SnapshotsService, (snapshots) => snapshots.refresh(hints)),
      ),
  );

  ipcMain.handle(IPC_CHANNELS.getUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.current)),
  );

  ipcMain.handle(IPC_CHANNELS.refreshUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.refresh())),
  );


  ipcMain.handle(IPC_CHANNELS.agentIdentity, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentIdentity(key)),
  );

  ipcMain.handle(IPC_CHANNELS.agentAvatar, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentAvatar(key)),
  );

  ipcMain.handle(IPC_CHANNELS.agentMessage, (_event, key: string, text: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentMessage(key, text)),
  );

  // The attached-chat plane (hermes ACP sessions per agent node). Shares its
  // ChatService instance with KernelService below — a pulse-driven turn and
  // a human reuse the same live ACP session per agent.
  void registerChatIpc(
    ipcMain,
    () => BrowserWindow.getAllWindows().map((window) => window.webContents),
    AppRuntime.runPromise(ChatServiceContext),
  );

  // The kernel plane: watcher/timer evaluation over every hydrated canvas,
  // running continuously in main regardless of window state.
  ipcMain.handle(IPC_CHANNELS.getKernelState, () =>
    AppRuntime.runPromise(Effect.map(KernelService, (kernel) => kernel.getSnapshot())),
  );

  ipcMain.handle(IPC_CHANNELS.armRegion, (_event, canvasName: string, regionId: string, armed: boolean) =>
    AppRuntime.runPromise(Effect.flatMap(KernelService, (kernel) => kernel.armRegion(canvasName, regionId, armed))),
  );

  ipcMain.handle(
    IPC_CHANNELS.pulseRegion,
    (_event, canvasName: string, regionId: string, opts?: PulseRegionOptions) =>
      AppRuntime.runPromise(Effect.flatMap(KernelService, (kernel) => kernel.pulseRegion(canvasName, regionId, opts))),
  );

  // Region rollups for the bottom bar: derived per call from the current
  // document + snapshots + the chat plane's session/permission state.
  ipcMain.handle(IPC_CHANNELS.regionRollups, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(name))),
  );

  // A2A work plane — seven ops, all serialized through CanvasesService write.
  // Remote stations get a typed WorkOpResult (never a rejected IPC promise).
  const denyRemoteWork = Effect.gen(function* () {
    const settings = yield* SettingsService;
    const current = yield* settings.get;
    if (current.station.role === "remote") {
      return {
        ok: false as const,
        code: "invalid" as const,
        message:
          "Remote station cannot mutate authorial canvases. Author on the Command Center.",
      };
    }
    return null;
  });

  ipcMain.handle(
    IPC_CHANNELS.workTaskCreate,
    (_event, canvas: string, nodeId: string, brief: string, metadata?: A2AMetadata) =>
      runRendererWorkAuthoring(
        "ipc.work.task-create",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskCreate(canvas, nodeId, brief, metadata);
          }),
        ),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.workTaskTransition,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-transition",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskTransition(canvas, nodeId, taskId, state, note);
          }),
        ),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.workTaskClaim,
    (_event, canvas: string, nodeId: string, taskId: string, actor: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-claim",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskClaim(canvas, nodeId, taskId, actor);
          }),
        ),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.workMessageAppend,
    (_event, canvas: string, nodeId: string, taskId: string | null, message: Message) =>
      runRendererWorkAuthoring(
        "ipc.work.message-append",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workMessageAppend(canvas, nodeId, taskId, message);
          }),
        ),
      ),
  );
  ipcMain.handle(
    IPC_CHANNELS.workRequestCreate,
    (_event, canvas: string, nodeId: string, brief: string, metadata?: A2AMetadata) =>
      runRendererWorkAuthoring(
        "ipc.work.request-create",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workRequestCreate(canvas, nodeId, brief, metadata);
          }),
        ),
      ),
  );
  ipcMain.handle(
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
  ipcMain.handle(
    IPC_CHANNELS.workArtifactPublish,
    (_event, canvas: string, nodeId: string, artifact: Artifact) =>
      runRendererWorkAuthoring(
        "ipc.work.artifact-publish",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workArtifactPublish(canvas, nodeId, artifact);
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
      const chat = yield* ChatServiceContext;
      const herdr = yield* HerdrPlane;
      yield* canvases.ensureSeed.pipe(Effect.catchAll(() => Effect.void));
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      usage.subscribe((state) => broadcast(IPC_CHANNELS.usageChanged, state));
      // A kernel flag mutate() is an "own write" CanvasesService suppresses
      // from the normal file-watch broadcast above — this is the explicit
      // push that keeps an open renderer's doc coherent with a kernel write.
      kernel.subscribeCanvasMutated((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      kernel.subscribe((snapshot) => broadcast(IPC_CHANNELS.kernelChanged, snapshot));

      // Message nudge channel: ether.messages → live ACP / herdr terminal.input.
      // Retry only on session-live / stream-attach (no polling, no queue store).
      messageDelivery.configure({
        transport: {
          isAgentLive: (agentKey) => chat.isLive(agentKey),
          sendAgentPrompt: async (agentKey, text) => {
            const result = await chat.chatPrompt(agentKey, text);
            return result.ok;
          },
          sendHerdrText: (terminalId, text) => {
            const streamId = herdr.streams.streamIdForTerminal(terminalId);
            if (!streamId) return false;
            const written = herdr.streams.inputText(streamId, text);
            return written.ok;
          },
          // Native terminals never auto-submit shell text (no Enter). Delivery
          // remains pending until a harness-aware path lands; returning false
          // keeps at-most-once stamp logic from marking undeliverable messages done.
          sendTerminalPaste: (_bindingId, _text, _messageId) => false,
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
          stampDelivered: (canvas, nodeId, messageId, deliveredAt) =>
            runMainAuthoring("delivery.message-stamp", async () => {
              for (let attempt = 0; attempt < 8; attempt += 1) {
                const read = await AppRuntime.runPromise(
                  canvases.read(canvas).pipe(Effect.either),
                );
                if (read._tag === "Left") return false;
                const next = stampMessageDelivered(read.right.doc, nodeId, messageId, deliveredAt);
                if (!next) return false; // already stamped or missing
                const written = await AppRuntime.runPromise(
                  canvases.write(canvas, next, read.right.revision).pipe(Effect.either),
                );
                if (written._tag === "Right") return true;
                const msg =
                  written.left instanceof Error ? written.left.message : String(written.left);
                if (!msg.includes("changed on disk") && !msg.includes("reload before saving")) {
                  return false;
                }
              }
              return false;
            }),
        },
      });
      chat.setSessionLiveHook((agentKey) => messageDelivery.onAgentLive(agentKey));
      herdr.streams.setOpenHook((terminalId) => messageDelivery.onHerdrAttached(terminalId));

      canvases.start();
      snapshots.start();
      // First usage fetch is fire-and-forget off the boot critical path;
      // codexbar can take ~15-20s so it never blocks window open.
      usage.start();
      kernel.start();
    }),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerVellumBrowserIpc = (sessions: BrowserSessionService): void => {
  registerBrowserIpc(
    ipcMain,
    sessions,
    () => BrowserWindow.getAllWindows().map((window) => window.webContents),
  );
};
