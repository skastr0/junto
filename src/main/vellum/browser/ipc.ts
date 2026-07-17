import type { IpcMain, WebContents } from "electron";
import { Effect } from "effect";
import {
  IPC_CHANNELS,
  type BrowserOpenInput,
  type BrowserSurfaceBounds,
} from "@shared/ipc";
import { BrowserSessionService } from "./sessions";
import { electronViewAdapter } from "./view-adapter";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { makePageTargetResolver, type PageTargetResolver } from "./page-target";

/** Singleton used by IPC + quit hooks (tests construct their own with a spy adapter). */
export const browserSessions = new BrowserSessionService(electronViewAdapter);

export const resolveBrowserPageTarget: PageTargetResolver = (ref) =>
  AppRuntime.runPromise(
    Effect.flatMap(CanvasesService, (canvases) =>
      Effect.promise(() => makePageTargetResolver(canvases)(ref)),
    ),
  );

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

  ipcMain.handle(IPC_CHANNELS.browserOpen, async (_e, input: BrowserOpenInput) => {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).join(",") !== "ref" ||
      typeof input.ref !== "string"
    ) {
      return { ok: false as const, code: "invalid" as const, message: "canonical page ref required" };
    }
    const target = await resolveBrowserPageTarget(input.ref);
    return target.ok ? browserSessions.open(target.data) : target;
  });

  ipcMain.handle(IPC_CHANNELS.browserClose, (_e, sessionId: string) =>
    browserSessions.close(sessionId),
  );

  ipcMain.handle(IPC_CHANNELS.browserSessionState, (_e, sessionId: string) =>
    browserSessions.state(sessionId),
  );

  ipcMain.handle(IPC_CHANNELS.browserSessionList, () => browserSessions.list());

  ipcMain.handle(
    IPC_CHANNELS.browserSetBounds,
    (_e, sessionId: string, bounds: BrowserSurfaceBounds) =>
      browserSessions.setBounds(sessionId, bounds),
  );
};
