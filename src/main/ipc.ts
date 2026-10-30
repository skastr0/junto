import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { core } from "./core-process/main-client";
import type { BrowserSessionService } from "./junto/browser/sessions";
import { registerJuntoBrowserIpc, registerJuntoIpc } from "./junto/ipc";
import { trustedRendererIpc } from "./junto/trusted-main-webcontents";

export const registerBrowserIpcHandlers = (sessions: BrowserSessionService): void => {
  registerJuntoBrowserIpc(sessions);
};

export const registerIpcHandlers = (): void => {
  registerJuntoIpc();
  const privilegedIpc = trustedRendererIpc(ipcMain);
  privilegedIpc.handle(IPC_CHANNELS.doctor, () => core.call("ipc.doctor.report", {}));
};
