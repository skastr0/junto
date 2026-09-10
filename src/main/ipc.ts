import { dialog, ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { CodexService } from "./services/codex";
import { FolderService } from "./services/folder";
import { AppRuntime, buildDoctorReport } from "./runtime";
import type { BrowserSessionService } from "./vellum/browser/sessions";
import { registerVellumBrowserIpc, registerVellumIpc } from "./vellum/ipc";
import { trustedRendererIpc } from "./vellum/trusted-main-webcontents";

export const registerBrowserIpcHandlers = (sessions: BrowserSessionService): void => {
  registerVellumBrowserIpc(sessions);
};

export const registerIpcHandlers = (): void => {
  registerVellumIpc();
  const privilegedIpc = trustedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.doctor, () => AppRuntime.runPromise(buildDoctorReport));

  privilegedIpc.handle(IPC_CHANNELS.selectFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open a local folder",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const root = result.filePaths[0]!;
    const entries = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const folder = yield* FolderService;
        return yield* folder.readDirectory(root);
      }),
    );

    return { root, entries };
  });

  privilegedIpc.handle(IPC_CHANNELS.readDirectory, (_event, path: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const folder = yield* FolderService;
        return yield* folder.readDirectory(path);
      }),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.probeCodex, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const codex = yield* CodexService;
        return yield* codex.probeAppServer;
      }),
    ),
  );
};
