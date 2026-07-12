import { BrowserWindow, ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS, type BindingHint } from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { digestCanvas } from "@shared/digest";
import { AppRuntime } from "../runtime";
import { CanvasesService } from "./canvases";
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
