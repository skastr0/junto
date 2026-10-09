import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
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
};
