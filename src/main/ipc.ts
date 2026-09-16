import { ipcMain } from "electron";
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { CodexService } from "./services/codex";
import { AppRuntime, buildDoctorReport } from "./runtime";
import type { BrowserSessionService } from "./junto/browser/sessions";
import { registerJuntoBrowserIpc, registerJuntoIpc } from "./junto/ipc";
import { trustedRendererIpc } from "./junto/trusted-main-webcontents";

export const registerBrowserIpcHandlers = (sessions: BrowserSessionService): void => {
  registerJuntoBrowserIpc(sessions);
};

export const registerIpcHandlers = (): void => {
  registerJuntoIpc();
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
