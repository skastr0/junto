import type { IpcMain, WebContents } from "electron";
import { Context, Effect } from "effect";
import {
  IPC_CHANNELS,
  type HerdrMirrorEvent,
  type HerdrObserveTouchInput,
  type HerdrPointerCell,
  type HerdrStreamOpenInput,
} from "@shared/ipc";
import { AppRuntime } from "../../runtime";
import { listHerdrHosts } from "./hosts";
import { HerdrPlane } from "./plane";

const toOp = <T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }) => {
  if (result.ok) return { ok: true as const, data: result.data };
  return { ok: false as const, code: result.code, message: result.message };
};

const withPlane = <A>(run: (plane: Context.Tag.Service<typeof HerdrPlane>) => A | PromiseLike<A>) =>
  AppRuntime.runPromise(
    Effect.flatMap(HerdrPlane, (plane) => Effect.promise(() => Promise.resolve(run(plane)))),
  );

export const registerHerdrIpc = (
  ipcMain: IpcMain,
  webContentsGetter: () => Iterable<WebContents>,
): void => {
  void withPlane((plane) => {
    plane.streams.setSink((frame) => {
      for (const contents of webContentsGetter()) {
        contents.send(IPC_CHANNELS.herdrStreamEvent, frame);
      }
    });

    // Mirror change push — a freshness flip is "state"; data churn is "change".
    const lastFresh = new Map<string, boolean>();
    for (const host of listHerdrHosts()) {
      const mirror = plane.mirrors.mirrorFor(host.id);
      if (!mirror) continue;
      mirror.onChange(() => {
        const fresh = mirror.isFresh();
        const kind: HerdrMirrorEvent["kind"] = lastFresh.get(host.id) === fresh ? "change" : "state";
        lastFresh.set(host.id, fresh);
        const payload: HerdrMirrorEvent = { hostId: host.id, kind, fresh };
        for (const contents of webContentsGetter()) {
          contents.send(IPC_CHANNELS.herdrMirrorEvent, payload);
        }
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.herdrMirrorState, () => withPlane((plane) => plane.mirrors.states()));

  ipcMain.handle(IPC_CHANNELS.herdrHosts, () => withPlane((plane) => plane.service.hosts()));

  ipcMain.handle(IPC_CHANNELS.herdrEnsureServer, (_e, hostId: string, session?: string | null) =>
    withPlane((plane) => plane.service.ensureServer(hostId, session).then(toOp)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrListSessions, (_e, hostId: string) =>
    withPlane((plane) => plane.service.listSessions(hostId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListWorkspaces,
    (_e, hostId: string, session?: string | null) =>
      withPlane((plane) => plane.service.listWorkspaces(hostId, session).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListTabs,
    (_e, hostId: string, session?: string | null, workspaceId?: string) =>
      withPlane((plane) => plane.service.listTabs(hostId, session, workspaceId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListPanes,
    (_e, hostId: string, session?: string | null, workspaceId?: string) =>
      withPlane((plane) => plane.service.listPanes(hostId, session, workspaceId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrListAgents,
    (_e, hostId: string, session?: string | null) =>
      withPlane((plane) => plane.service.listAgents(hostId, session).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrGetMeta,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      withPlane((plane) => plane.service.getPaneMeta(hostId, session, paneId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrMarkPaneSeen,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      withPlane((plane) => plane.service.markPaneSeen(hostId, session, paneId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreateWorkspace,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly cwd: string; readonly label?: string },
    ) => withPlane((plane) => plane.service.createWorkspace(hostId, session, input).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreateTab,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly workspaceId: string; readonly label?: string },
    ) => withPlane((plane) => plane.service.createTab(hostId, session, input).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrCreatePane,
    (
      _e,
      hostId: string,
      session: string | null | undefined,
      input: { readonly paneId?: string; readonly direction?: "right" | "down"; readonly cwd?: string },
    ) => withPlane((plane) => plane.service.createPane(hostId, session, input).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrKillPane,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      withPlane((plane) => plane.service.killPane(hostId, session, paneId).then(toOp)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrKillTab,
    (_e, hostId: string, session: string | null | undefined, tabId: string) =>
      withPlane((plane) => plane.service.killTab(hostId, session, tabId).then(toOp)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamOpen, (_e, input: HerdrStreamOpenInput) =>
    withPlane((plane) => plane.streams.open(input)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamInput, (_e, streamId: string, dataBase64: string) =>
    withPlane((plane) => plane.streams.input(streamId, dataBase64)),
  );


  ipcMain.handle(
    IPC_CHANNELS.herdrStreamPasteImage,
    (_e, streamId: string, extension: string, dataBase64: string) =>
      withPlane((plane) => plane.streams.pasteImage(streamId, extension, dataBase64)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamResize,
    (_e, streamId: string, cols: number, rows: number) =>
      withPlane((plane) => plane.streams.resize(streamId, cols, rows)),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamScroll,
    (_e, streamId: string, delta: number, at?: HerdrPointerCell) =>
      withPlane((plane) => plane.streams.scroll(streamId, delta, at)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamClose, (_e, streamId: string) =>
    withPlane((plane) => plane.streams.close(streamId)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrObserveTouch, (_e, input: HerdrObserveTouchInput) =>
    withPlane((plane) => plane.observePool.ensureObserve(input)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrObserveRetained, (_e, terminalId: string) =>
    withPlane((plane) => plane.observePool.retainedFrames(terminalId)),
  );
};
