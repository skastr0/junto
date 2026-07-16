import type { IpcMain, WebContents } from "electron";
import {
  IPC_CHANNELS,
  type HerdrMouseInput,
  type HerdrPointerCell,
  type HerdrStreamOpenInput,
} from "@shared/ipc";
import { herdrService } from "./service";
import { herdrStreams } from "./stream";

const toOp = <T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }) => {
  if (result.ok) return { ok: true as const, data: result.data };
  return { ok: false as const, code: result.code, message: result.message };
};

export const registerHerdrIpc = (
  ipcMain: IpcMain,
  webContentsGetter: () => Iterable<WebContents>,
): void => {
  herdrStreams.setSink((frame) => {
    for (const contents of webContentsGetter()) {
      contents.send(IPC_CHANNELS.herdrStreamEvent, frame);
    }
  });

  ipcMain.handle(IPC_CHANNELS.herdrHosts, () => herdrService.hosts());

  ipcMain.handle(IPC_CHANNELS.herdrEnsureServer, (_e, hostId: string, session?: string | null) =>
    herdrService.ensureServer(hostId, session).then(toOp),
  );

  ipcMain.handle(IPC_CHANNELS.herdrListSessions, (_e, hostId: string) =>
    herdrService.listSessions(hostId).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListWorkspaces,
    (_e, hostId: string, session?: string | null) =>
      herdrService.listWorkspaces(hostId, session).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListTabs,
    (_e, hostId: string, session?: string | null, workspaceId?: string) =>
      herdrService.listTabs(hostId, session, workspaceId).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListPanes,
    (_e, hostId: string, session?: string | null, workspaceId?: string) =>
      herdrService.listPanes(hostId, session, workspaceId).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListAgents,
    (_e, hostId: string, session?: string | null) =>
      herdrService.listAgents(hostId, session).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrGetMeta,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      herdrService.getPaneMeta(hostId, session, paneId).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreateWorkspace,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly cwd: string; readonly label?: string },
    ) => herdrService.createWorkspace(hostId, session, input).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreateTab,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly workspaceId: string; readonly label?: string },
    ) => herdrService.createTab(hostId, session, input).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreatePane,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly paneId?: string; readonly direction?: "right" | "down"; readonly cwd?: string },
    ) => herdrService.createPane(hostId, session, input).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrKillPane,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      herdrService.killPane(hostId, session, paneId).then(toOp),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrKillTab,
    (_e, hostId: string, session: string | null | undefined, tabId: string) =>
      herdrService.killTab(hostId, session, tabId).then(toOp),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamOpen, (_e, input: HerdrStreamOpenInput) =>
    herdrStreams.open(input),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamInput, (_e, streamId: string, dataBase64: string) =>
    herdrStreams.input(streamId, dataBase64),
  );


  ipcMain.handle(
    IPC_CHANNELS.herdrStreamClipboardImage,
    (_e, streamId: string, extension: string, dataBase64: string) =>
      herdrStreams.clipboardImage(streamId, extension, dataBase64),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamResize,
    (_e, streamId: string, cols: number, rows: number) => herdrStreams.resize(streamId, cols, rows),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamScroll,
    (_e, streamId: string, delta: number, at?: HerdrPointerCell) =>
      herdrStreams.scroll(streamId, delta, at),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamMouse, (_e, streamId: string, input: HerdrMouseInput) =>
    herdrStreams.mouse(streamId, input),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamClose, (_e, streamId: string) =>
    herdrStreams.close(streamId),
  );
};
