import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { PRODUCT_NAME } from "@shared/product-name";
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
  // This installation's station facts are Electron's to say; the doctor's
  // service answers come from the core, where those services live.
  privilegedIpc.handle(IPC_CHANNELS.doctor, () =>
    core.call("ipc.doctor.report", {
      station: {
        name: PRODUCT_NAME,
        version: app.getVersion(),
        userDataPath: app.getPath("userData"),
      },
    }),
  );
};
