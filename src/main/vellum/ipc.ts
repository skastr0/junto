import { BrowserWindow, ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS, type BindingHint, type BoothReviewAction, type TowerEmitSignalInput } from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { digestCanvas } from "@shared/digest";
import { buildGlyphView, projectsNeedingGlyphs } from "@shared/glyph-view";
import { mergePortfolioInto } from "@shared/portfolio";
import { AppRuntime, chatService } from "../runtime";
import {
  fetchBoothDraftRead,
  fetchBoothDrafts,
  fetchBoothRequests,
  fetchBoothReview,
} from "./adapters/booth-controls";
import { fetchAgentAvatar, fetchAgentIdentity, fetchAgentMessage } from "./adapters/hermes-identity";
import { fetchQuasarSearch, fetchQuasarSessionDetail, fetchQuasarSessionList } from "./adapters/quasar";
import {
  fetchTowerBrowse,
  fetchTowerCommentGlyph,
  fetchTowerCommentSignal,
  fetchTowerDispatches,
  fetchTowerEmitSignal,
  fetchTowerGlyphRead,
  fetchTowerSearch,
  fetchTowerSignalRead,
} from "./adapters/tower-browse";
import { startBoothAttention } from "./booth-attention";
import { registerBrowserIpc } from "./browser/ipc";
import { CanvasesService } from "./canvases";
import { registerChatIpc } from "./chat/ipc";
import { registerHerdrIpc } from "./herdr/ipc";
import type { PulseRegionOptions } from "./kernel/service";
import { KernelService } from "./kernel/service";
import { SnapshotsService } from "./snapshots";

const broadcast = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
};

export const registerVellumIpc = () => {
  registerHerdrIpc(ipcMain, () => BrowserWindow.getAllWindows().map((w) => w.webContents));
  registerBrowserIpc(ipcMain, () => BrowserWindow.getAllWindows().map((w) => w.webContents));
  ipcMain.handle(IPC_CHANNELS.listCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.list)),
  );

  ipcMain.handle(IPC_CHANNELS.readCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.read(name))),
  );

  ipcMain.handle(IPC_CHANNELS.writeCanvas, (_event, name: string, doc: CanvasDoc) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.write(name, doc))),
  );

  ipcMain.handle(IPC_CHANNELS.createCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.create(name))),
  );

  ipcMain.handle(IPC_CHANNELS.deleteCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.remove(name))),
  );

  ipcMain.handle(IPC_CHANNELS.exportDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const snapshots = yield* SnapshotsService;
        const result = yield* canvases.read(name);
        const state = yield* snapshots.current;
        // Glyph-aware digest: same policy as scripts/digest.ts — only complete
        // non-partial tower browse results feed criteria edges.
        const fetched = new Map<string, Awaited<ReturnType<typeof fetchTowerBrowse>>>();
        for (const project of projectsNeedingGlyphs(result.doc)) {
          fetched.set(project, yield* Effect.promise(() => fetchTowerBrowse(project)));
        }
        const glyphs = buildGlyphView(result.doc, fetched);
        const digest = digestCanvas(name, result.doc, state, glyphs);
        const path = yield* canvases.writeSidecar(name, "digest.txt", digest);
        return { digest, path };
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.generatePortfolio,
    (_event, name: string, options?: { all?: boolean }) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const canvases = yield* CanvasesService;
          const snapshots = yield* SnapshotsService;
          // Fresh full-corpus pull (no hints = base project lists from each source).
          const state = yield* snapshots.refresh([]);
          const existing = yield* canvases.read(name);
          const merged = mergePortfolioInto(existing.doc, state, { all: options?.all ?? false });
          yield* canvases.write(name, merged);
          return yield* canvases.read(name);
        }),
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

  // Source browsing: read-only, hit the live adapters directly (no Effect
  // runtime involvement — these don't touch canvas/snapshot state).
  ipcMain.handle(IPC_CHANNELS.towerBrowse, (_event, projectKey: string) =>
    fetchTowerBrowse(projectKey),
  );

  ipcMain.handle(IPC_CHANNELS.towerSearch, (_event, query: string, projectKey?: string) =>
    fetchTowerSearch(query, projectKey),
  );

  ipcMain.handle(IPC_CHANNELS.towerGlyphRead, (_event, projectKey: string, orbit: string, glyphId: string) =>
    fetchTowerGlyphRead(projectKey, orbit, glyphId),
  );

  ipcMain.handle(IPC_CHANNELS.towerSignalRead, (_event, projectKey: string, orbit: string, signalId: string) =>
    fetchTowerSignalRead(projectKey, orbit, signalId),
  );

  ipcMain.handle(IPC_CHANNELS.towerDispatches, (_event, projectKey: string) =>
    fetchTowerDispatches(projectKey),
  );

  // Deliberate writes: narrow, user-initiated, never automatic.
  ipcMain.handle(
    IPC_CHANNELS.towerCommentGlyph,
    (_event, projectKey: string, orbit: string, glyphId: string, body: string) =>
      fetchTowerCommentGlyph(projectKey, orbit, glyphId, body),
  );

  ipcMain.handle(
    IPC_CHANNELS.towerCommentSignal,
    (_event, projectKey: string, orbit: string, signalId: string, body: string) =>
      fetchTowerCommentSignal(projectKey, orbit, signalId, body),
  );

  ipcMain.handle(IPC_CHANNELS.towerEmitSignal, (_event, input: TowerEmitSignalInput) =>
    fetchTowerEmitSignal(input),
  );

  ipcMain.handle(IPC_CHANNELS.boothDrafts, (_event, projectKey: string) => fetchBoothDrafts(projectKey));

  ipcMain.handle(IPC_CHANNELS.boothDraftRead, (_event, draftId: string) => fetchBoothDraftRead(draftId));

  ipcMain.handle(IPC_CHANNELS.boothRequests, (_event, projectKey: string) => fetchBoothRequests(projectKey));

  ipcMain.handle(
    IPC_CHANNELS.boothReview,
    (_event, projectKey: string, draftId: string, action: BoothReviewAction, body?: string) =>
      fetchBoothReview(projectKey, draftId, action, body),
  );

  ipcMain.handle(IPC_CHANNELS.quasarSessions, (_event, quasarKey: string, limit?: number) =>
    fetchQuasarSessionList(quasarKey, limit),
  );

  ipcMain.handle(IPC_CHANNELS.quasarSearch, (_event, query: string, quasarKey?: string) =>
    fetchQuasarSearch(query, quasarKey),
  );

  ipcMain.handle(IPC_CHANNELS.quasarSessionDetail, (_event, sessionId: string) =>
    fetchQuasarSessionDetail(sessionId),
  );

  ipcMain.handle(IPC_CHANNELS.agentIdentity, (_event, key: string) => fetchAgentIdentity(key));

  ipcMain.handle(IPC_CHANNELS.agentAvatar, (_event, key: string) => fetchAgentAvatar(key));

  ipcMain.handle(IPC_CHANNELS.agentMessage, (_event, key: string, text: string) =>
    fetchAgentMessage(key, text),
  );

  // The attached-chat plane (hermes ACP sessions per agent node). Shares its
  // ChatService instance with KernelService below — a pulse-driven turn and
  // a human reuse the same live ACP session per agent.
  registerChatIpc(ipcMain, () => BrowserWindow.getAllWindows().map((window) => window.webContents), chatService);

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

  // Wire pushes and background loops once at startup.
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const kernel = yield* KernelService;
      yield* canvases.ensureSeed.pipe(Effect.catchAll(() => Effect.void));
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      // Booth review attention: native notification on a rising pending
      // count, off the same poll — window-optional by construction.
      startBoothAttention(snapshots.subscribe);
      // A kernel flag mutate() is an "own write" CanvasesService suppresses
      // from the normal file-watch broadcast above — this is the explicit
      // push that keeps an open renderer's doc coherent with a kernel write.
      kernel.subscribeCanvasMutated((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      kernel.subscribe((snapshot) => broadcast(IPC_CHANNELS.kernelChanged, snapshot));
      canvases.start();
      snapshots.start();
      kernel.start();
    }),
  );
};
