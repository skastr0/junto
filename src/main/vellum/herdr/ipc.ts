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
  interface StreamOwner {
    readonly streamId: string;
    readonly sender: WebContents;
    readonly onDestroyed: () => void;
    readonly onRenderProcessGone: () => void;
    readonly onDidStartLoading: () => void;
  }

  const streamOwnersByStreamId = new Map<string, StreamOwner>();

  const releaseStreamOwner = (streamId: string): StreamOwner | undefined => {
    const owner = streamOwnersByStreamId.get(streamId);
    if (!owner) return undefined;
    streamOwnersByStreamId.delete(streamId);
    try {
      if (!owner.sender.isDestroyed()) {
        owner.sender.removeListener("destroyed", owner.onDestroyed);
        owner.sender.removeListener("render-process-gone", owner.onRenderProcessGone);
        owner.sender.removeListener("did-start-loading", owner.onDidStartLoading);
      }
    } catch {
      // ignore
    }
    return owner;
  };

  // Default deny: an unrecognized/untracked streamId is unauthorized. Tests
  // must register ownership the way production does (open through the
  // handler with a fake sender) or drive plane.streams directly below IPC.
  const isAuthorized = (sender: WebContents, streamId: string): boolean => {
    const owner = streamOwnersByStreamId.get(streamId);
    if (!owner) return false;
    return owner.sender === sender && !sender.isDestroyed();
  };

  void withPlane((plane) => {
    plane.streams.setSink((frame) => {
      const owner = streamOwnersByStreamId.get(frame.streamId);
      // Ownerless frame: dropped. If it is "closed", release is a no-op
      // (there is nothing to release) — no broadcast fallback.
      if (!owner) return;
      if (!owner.sender.isDestroyed()) {
        owner.sender.send(IPC_CHANNELS.herdrStreamEvent, frame);
      }
      if (frame.type === "closed") {
        releaseStreamOwner(frame.streamId);
      }
    });

    // Mirror change push — a freshness flip is "state"; data churn is "change".
    const lastFresh = new Map<string, boolean>();
    plane.mirrors.onChange((hostId) => {
      const mirror = plane.mirrors.mirrorFor(hostId);
      const fresh = mirror?.isFresh() ?? false;
      const kind: HerdrMirrorEvent["kind"] = lastFresh.get(hostId) === fresh ? "change" : "state";
      lastFresh.set(hostId, fresh);
      const payload: HerdrMirrorEvent = { hostId, kind, fresh };
      for (const contents of webContentsGetter()) {
        if (!contents.isDestroyed()) {
          contents.send(IPC_CHANNELS.herdrMirrorEvent, payload);
        }
      }
    });
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
      withPlane(async (plane) => {
        const result = await plane.service.getPaneMeta(hostId, session, paneId);
        if (result.ok) {
          // Feed processes into host service map (no SSH unless interest + queue).
          plane.serviceMap.observeProcesses({
            hostId,
            session,
            paneId,
            processes: result.data.processes,
          });
          const service = plane.serviceMap.get(hostId, session, paneId);
          if (service) {
            return toOp({ ok: true, data: { ...result.data, service } });
          }
        }
        return toOp(result);
      }),
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

  ipcMain.handle(IPC_CHANNELS.herdrStreamOpen, (event, input: HerdrStreamOpenInput) =>
    withPlane((plane) => {
      const sender = event.sender;
      if (!sender || sender.isDestroyed()) {
        return { ok: false, message: "renderer gone" };
      }

      const res = plane.streams.open(input);
      if (!res.ok || !res.streamId) return res;
      const streamId = res.streamId;

      // open() is synchronous — this only fires when a synchronous side
      // effect inside `open` itself destroyed the sender (as the test
      // simulates), not an async race. Close the stream we just opened
      // rather than leaving it alive and unreachable.
      if (sender.isDestroyed()) {
        plane.streams.close(streamId, "renderer_gone");
        return { ok: false, message: "renderer gone" };
      }

      releaseStreamOwner(streamId);

      // Sender already gone by the time these fire — release first (there
      // is no one left to deliver a final frame to), then close.
      const detachOnRendererGone = (reason: string) => () => {
        releaseStreamOwner(streamId);
        plane.streams.close(streamId, reason);
      };
      const onDestroyed = detachOnRendererGone("renderer_destroyed");
      const onRenderProcessGone = detachOnRendererGone("renderer_process_gone");
      // An ordinary reload/navigation fires "did-start-loading" but never
      // "destroyed"/"render-process-gone" — without this, reload leaked the
      // control stream + ssh child alive and unreachable. Deliver the final
      // "closed" frame before release (close-then-release, mirroring
      // herdrStreamClose) so the still-alive sender sees it.
      const onDidStartLoading = () => {
        plane.streams.close(streamId, "renderer_reloaded");
        releaseStreamOwner(streamId);
      };

      sender.once("destroyed", onDestroyed);
      sender.once("render-process-gone", onRenderProcessGone);
      sender.once("did-start-loading", onDidStartLoading);

      streamOwnersByStreamId.set(streamId, {
        streamId,
        sender,
        onDestroyed,
        onRenderProcessGone,
        onDidStartLoading,
      });

      return res;
    }),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamInput, (event, streamId: string, dataBase64: string) =>
    withPlane((plane) => {
      if (!isAuthorized(event.sender, streamId)) return { ok: false, error: "unauthorized stream owner" };
      return plane.streams.input(streamId, dataBase64);
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamPasteImage,
    (event, streamId: string, extension: string, dataBase64: string) =>
      withPlane((plane) => {
        if (!isAuthorized(event.sender, streamId)) return { ok: false, error: "unauthorized stream owner" };
        return plane.streams.pasteImage(streamId, extension, dataBase64);
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamResize,
    (event, streamId: string, cols: number, rows: number) =>
      withPlane((plane) => {
        if (!isAuthorized(event.sender, streamId)) return { ok: false, error: "unauthorized stream owner" };
        return plane.streams.resize(streamId, cols, rows);
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrStreamScroll,
    (event, streamId: string, delta: number, at?: HerdrPointerCell) =>
      withPlane((plane) => {
        if (!isAuthorized(event.sender, streamId)) return { ok: false, error: "unauthorized stream owner" };
        return plane.streams.scroll(streamId, delta, at);
      }),
  );

  ipcMain.handle(IPC_CHANNELS.herdrStreamClose, (event, streamId: string) =>
    withPlane((plane) => {
      if (!isAuthorized(event.sender, streamId)) return { ok: false, error: "unauthorized stream owner" };
      const res = plane.streams.close(streamId);
      releaseStreamOwner(streamId);
      return res;
    }),
  );

  ipcMain.handle(IPC_CHANNELS.herdrObserveTouch, (_e, input: HerdrObserveTouchInput) =>
    withPlane((plane) => plane.observePool.ensureObserve(input)),
  );

  ipcMain.handle(IPC_CHANNELS.herdrObserveRetained, (_e, terminalId: string) =>
    withPlane((plane) => plane.observePool.retainedFrames(terminalId)),
  );

  // --- HostServiceMap (process → port → URL); append-only, no stream ownership ---
  ipcMain.handle(
    IPC_CHANNELS.herdrServiceMapGet,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      withPlane((plane) => {
        const data = plane.serviceMap.get(hostId, session, paneId) ?? null;
        return { ok: true as const, data };
      }),
  );

  ipcMain.handle(
    IPC_CHANNELS.herdrServiceMapProbe,
    (_e, hostId: string, session: string | null | undefined, paneId: string) =>
      withPlane((plane) => {
        const data = plane.serviceMap.requestProbe({
          hostId,
          session,
          paneId,
          priority: "intent",
        });
        return { ok: true as const, data };
      }),
  );

  // Push service map updates to all renderers (cheap JSON; cards filter by pane).
  void withPlane((plane) => {
    plane.serviceMap.onChange((proj) => {
      for (const contents of webContentsGetter()) {
        if (!contents.isDestroyed()) {
          contents.send(IPC_CHANNELS.herdrServiceMapEvent, proj);
        }
      }
    });
  });
};
