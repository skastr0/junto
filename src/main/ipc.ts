import { ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { CodexService } from "./services/codex";
import { AppRuntime, buildDoctorReport } from "./runtime";
import type { BrowserSessionService } from "./vellum-command/browser/sessions";
import { registerVellumBrowserIpc, registerVellumIpc } from "./vellum-command/ipc";
import { trustedRendererIpc } from "./vellum-command/trusted-main-webcontents";

export const registerBrowserIpcHandlers = (sessions: BrowserSessionService): void => {
  registerVellumBrowserIpc(sessions);
};

export const registerIpcHandlers = (): void => {
  registerVellumIpc();
  const privilegedIpc = trustedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.doctor, () => AppRuntime.runPromise(buildDoctorReport));

  privilegedIpc.handle(IPC_CHANNELS.probeCodex, () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const codex = yield* CodexService;
        return yield* codex.probeAppServer;
      }),
    ),
  );
};
