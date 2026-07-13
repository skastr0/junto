import { BrowserWindow, ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS, type BindingHint, type BoothReviewAction } from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { digestCanvas } from "@shared/digest";
import { mergePortfolioInto } from "@shared/portfolio";
import { AppRuntime } from "../runtime";
import { fetchBoothDrafts, fetchBoothReview } from "./adapters/booth-controls";
import { fetchAgentAvatar, fetchAgentIdentity, fetchAgentMessage } from "./adapters/hermes-identity";
import { fetchQuasarSearch, fetchQuasarSessionDetail, fetchQuasarSessionList } from "./adapters/quasar";
import {
  fetchTowerBrowse,
  fetchTowerCommentGlyph,
  fetchTowerCommentSignal,
  fetchTowerDispatches,
  fetchTowerGlyphRead,
  fetchTowerSearch,
  fetchTowerSignalRead,
} from "./adapters/tower-browse";
import { CanvasesService } from "./canvases";
import { registerChatIpc } from "./chat/ipc";
import { SnapshotsService } from "./snapshots";

const broadcast = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
};

export const registerVellumIpc = () => {
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

  ipcMain.handle(IPC_CHANNELS.exportDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const snapshots = yield* SnapshotsService;
        const result = yield* canvases.read(name);
        const state = yield* snapshots.current;
        const digest = digestCanvas(name, result.doc, state);
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

  ipcMain.handle(IPC_CHANNELS.boothDrafts, (_event, projectKey: string) => fetchBoothDrafts(projectKey));

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

  // The attached-chat plane (hermes ACP sessions per agent node).
  registerChatIpc(ipcMain, () => BrowserWindow.getAllWindows().map((window) => window.webContents));

  // Wire pushes and background loops once at startup.
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      yield* canvases.ensureSeed.pipe(Effect.catchAll(() => Effect.void));
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      canvases.start();
      snapshots.start();
    }),
  );
};
