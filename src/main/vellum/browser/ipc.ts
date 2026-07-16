import type { IpcMain, WebContents } from "electron";
import {
  IPC_CHANNELS,
  type BrowserOpenInput,
  type BrowserSurfaceBounds,
} from "@shared/ipc";
import { BrowserSessionService } from "./sessions";
import { electronViewAdapter } from "./view-adapter";

/** Singleton used by IPC + quit hooks (tests construct their own with a spy adapter). */
export const browserSessions = new BrowserSessionService(electronViewAdapter);

export const registerBrowserIpc = (
  ipcMain: IpcMain,
  webContentsGetter: () => Iterable<WebContents>,
): void => {
  browserSessions.setSink((session) => {
    for (const contents of webContentsGetter()) {
      contents.send(IPC_CHANNELS.browserSessionChanged, session);
    }
  });

  ipcMain.handle(IPC_CHANNELS.browserProfiles, () => browserSessions.listProfiles());

  ipcMain.handle(IPC_CHANNELS.browserSurfaceConfig, () => browserSessions.surfaceConfig());

  ipcMain.handle(IPC_CHANNELS.browserOpen, (_e, input: BrowserOpenInput) =>
    browserSessions.open(input),
  );

  ipcMain.handle(IPC_CHANNELS.browserClose, (_e, nodeId: string) =>
    browserSessions.close(nodeId),
  );

  ipcMain.handle(IPC_CHANNELS.browserSessionState, (_e, nodeId: string) =>
    browserSessions.state(nodeId),
  );

  ipcMain.handle(IPC_CHANNELS.browserSessionList, () => browserSessions.list());

  ipcMain.handle(
    IPC_CHANNELS.browserSetBounds,
    (_e, nodeId: string, bounds: BrowserSurfaceBounds) =>
      browserSessions.setBounds(nodeId, bounds),
  );
};
