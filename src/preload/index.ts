import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type ChassisApi, type VellumApi } from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";

const chassisApi: ChassisApi = {
  doctor: () => ipcRenderer.invoke(IPC_CHANNELS.doctor),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectFolder),
  readDirectory: (path) => ipcRenderer.invoke(IPC_CHANNELS.readDirectory, path),
  probeCodex: () => ipcRenderer.invoke(IPC_CHANNELS.probeCodex),
  prismDryRun: () => ipcRenderer.invoke(IPC_CHANNELS.prismDryRun),
};

const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

const vellumApi: VellumApi = {
  listCanvases: () => ipcRenderer.invoke(IPC_CHANNELS.listCanvases),
  readCanvas: (name) => ipcRenderer.invoke(IPC_CHANNELS.readCanvas, name),
  writeCanvas: (name, doc) => ipcRenderer.invoke(IPC_CHANNELS.writeCanvas, name, doc),
  createCanvas: (name) => ipcRenderer.invoke(IPC_CHANNELS.createCanvas, name),
  exportDigest: (name) => ipcRenderer.invoke(IPC_CHANNELS.exportDigest, name),
  generatePortfolio: (name, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.generatePortfolio, name, options),
  getSnapshots: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshots),
  refreshSnapshots: (hints) => ipcRenderer.invoke(IPC_CHANNELS.refreshSnapshots, hints),
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
};

contextBridge.exposeInMainWorld("chassis", chassisApi);
contextBridge.exposeInMainWorld("vellum", vellumApi);
