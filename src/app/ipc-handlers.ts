import { app, ipcMain } from "electron";
import { Context } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { PRODUCT_NAME } from "@shared/product-name";
import type { BrowserCore } from "../contract/core/browser";
import { HostsCore } from "../contract/core/hosts-ipc";
import { AppRuntime } from "./runtime";

import type { BrowserSessionService } from "./browser/sessions";
import { registerJuntoBrowserIpc, registerJuntoIpc, type MainBoot } from "./ipc";
import { trustedRendererIpc } from "./trusted-main-webcontents";

export const registerBrowserIpcHandlers = (sessions: BrowserSessionService, core: Context.Context<BrowserCore>): void => {
  registerJuntoBrowserIpc(sessions, core);
};

export const registerIpcHandlers = (boot: MainBoot): void => {
  registerJuntoIpc(boot);
  const privilegedIpc = trustedRendererIpc(ipcMain);
  const hosts = Context.get(boot.core, HostsCore);
  // This installation's station facts are Electron's to say; the doctor's
  // service answers come from the core, where those services live.
  privilegedIpc.handle(IPC_CHANNELS.doctor, () =>
    AppRuntime.runPromise(
      hosts.HostsDoctorReport({
        station: {
          name: PRODUCT_NAME,
          version: app.getVersion(),
          userDataPath: app.getPath("userData"),
        },
      }),
    ),
  );
};
