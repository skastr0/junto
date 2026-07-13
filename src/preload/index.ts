import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type ChassisApi, type VellumApi } from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";

// Every real handler answers in well under this; only a dead/wedged main
// process (e.g. killed during a dev restart) never responds. Rejecting then
// surfaces the renderer's existing error banner instead of a silent freeze —
// the exact failure mode that made a stale instance look "non-responsive".
const IPC_TIMEOUT_MS = 45_000;

// agentMessage fires a real (up to 180s) hermes turn; give it headroom above
// that instead of sharing the default 45s ceiling every other channel uses.
const AGENT_MESSAGE_TIMEOUT_MS = 200_000;

const invoke = <T>(channel: string, timeoutMs: number, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`vellum: backend did not respond (${channel}). Try restarting the app.`));
    }, timeoutMs);
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
  doctor: () => invoke(IPC_CHANNELS.doctor, IPC_TIMEOUT_MS),
  selectFolder: () => invoke(IPC_CHANNELS.selectFolder, IPC_TIMEOUT_MS),
  readDirectory: (path) => invoke(IPC_CHANNELS.readDirectory, IPC_TIMEOUT_MS, path),
  probeCodex: () => invoke(IPC_CHANNELS.probeCodex, IPC_TIMEOUT_MS),
  prismDryRun: () => invoke(IPC_CHANNELS.prismDryRun, IPC_TIMEOUT_MS),
};

const subscribe = <T>(channel: string, listener: (payload: T) => void) => {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

const vellumApi: VellumApi = {
  listCanvases: () => invoke(IPC_CHANNELS.listCanvases, IPC_TIMEOUT_MS),
  readCanvas: (name) => invoke(IPC_CHANNELS.readCanvas, IPC_TIMEOUT_MS, name),
  writeCanvas: (name, doc) => invoke(IPC_CHANNELS.writeCanvas, IPC_TIMEOUT_MS, name, doc),
  createCanvas: (name) => invoke(IPC_CHANNELS.createCanvas, IPC_TIMEOUT_MS, name),
  exportDigest: (name) => invoke(IPC_CHANNELS.exportDigest, IPC_TIMEOUT_MS, name),
  generatePortfolio: (name, options) =>
    invoke(IPC_CHANNELS.generatePortfolio, IPC_TIMEOUT_MS, name, options),
  getSnapshots: () => invoke(IPC_CHANNELS.getSnapshots, IPC_TIMEOUT_MS),
  refreshSnapshots: (hints) => invoke(IPC_CHANNELS.refreshSnapshots, IPC_TIMEOUT_MS, hints),
  towerBrowse: (projectKey) => invoke(IPC_CHANNELS.towerBrowse, IPC_TIMEOUT_MS, projectKey),
  towerSearch: (query, projectKey) =>
    invoke(IPC_CHANNELS.towerSearch, IPC_TIMEOUT_MS, query, projectKey),
  quasarSessions: (quasarKey, limit) =>
    invoke(IPC_CHANNELS.quasarSessions, IPC_TIMEOUT_MS, quasarKey, limit),
  quasarSearch: (query, quasarKey) =>
    invoke(IPC_CHANNELS.quasarSearch, IPC_TIMEOUT_MS, query, quasarKey),
  agentIdentity: (key) => invoke(IPC_CHANNELS.agentIdentity, IPC_TIMEOUT_MS, key),
  agentAvatar: (key) => invoke(IPC_CHANNELS.agentAvatar, IPC_TIMEOUT_MS, key),
  agentMessage: (key, text) => invoke(IPC_CHANNELS.agentMessage, AGENT_MESSAGE_TIMEOUT_MS, key, text),
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
};

contextBridge.exposeInMainWorld("chassis", chassisApi);
contextBridge.exposeInMainWorld("vellum", vellumApi);
