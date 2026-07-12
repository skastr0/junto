import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type ChassisApi, type VellumApi } from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";

// Every real handler answers in well under this; only a dead/wedged main
// process (e.g. killed during a dev restart) never responds. Rejecting then
// surfaces the renderer's existing error banner instead of a silent freeze —
// the exact failure mode that made a stale instance look "non-responsive".
const IPC_TIMEOUT_MS = 45_000;

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`vellum: backend did not respond (${channel}). Try restarting the app.`));
    }, IPC_TIMEOUT_MS);
    ipcRenderer.invoke(channel, ...args).then(
      (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const chassisApi: ChassisApi = {
  doctor: () => invoke(IPC_CHANNELS.doctor),
  selectFolder: () => invoke(IPC_CHANNELS.selectFolder),
  readDirectory: (path) => invoke(IPC_CHANNELS.readDirectory, path),
  probeCodex: () => invoke(IPC_CHANNELS.probeCodex),
  prismDryRun: () => invoke(IPC_CHANNELS.prismDryRun),
};

const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

const vellumApi: VellumApi = {
  listCanvases: () => invoke(IPC_CHANNELS.listCanvases),
  readCanvas: (name) => invoke(IPC_CHANNELS.readCanvas, name),
  writeCanvas: (name, doc) => invoke(IPC_CHANNELS.writeCanvas, name, doc),
  createCanvas: (name) => invoke(IPC_CHANNELS.createCanvas, name),
  exportDigest: (name) => invoke(IPC_CHANNELS.exportDigest, name),
  generatePortfolio: (name, options) =>
    invoke(IPC_CHANNELS.generatePortfolio, name, options),
  getSnapshots: () => invoke(IPC_CHANNELS.getSnapshots),
  refreshSnapshots: (hints) => invoke(IPC_CHANNELS.refreshSnapshots, hints),
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
};

contextBridge.exposeInMainWorld("chassis", chassisApi);
contextBridge.exposeInMainWorld("vellum", vellumApi);
