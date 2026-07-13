import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type ChassisApi, type ChatEvent, type VellumApi, type VellumChatApi } from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";

// Every real handler answers in well under this; only a dead/wedged main
// process (e.g. killed during a dev restart) never responds. Rejecting then
// surfaces the renderer's existing error banner instead of a silent freeze —
// the exact failure mode that made a stale instance look "non-responsive".
const IPC_TIMEOUT_MS = 45_000;

// agentMessage fires a real (up to 180s) hermes turn; give it headroom above
// that instead of sharing the default 45s ceiling every other channel uses.
const AGENT_MESSAGE_TIMEOUT_MS = 200_000;

// A chat turn can run tools for many minutes; streaming events keep the UI
// alive meanwhile, so the invoke ceiling only guards a truly dead backend.
const CHAT_TURN_TIMEOUT_MS = 900_000;

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
  towerGlyphRead: (projectKey, orbit, glyphId) =>
    invoke(IPC_CHANNELS.towerGlyphRead, IPC_TIMEOUT_MS, projectKey, orbit, glyphId),
  towerSignalRead: (projectKey, orbit, signalId) =>
    invoke(IPC_CHANNELS.towerSignalRead, IPC_TIMEOUT_MS, projectKey, orbit, signalId),
  towerDispatches: (projectKey) => invoke(IPC_CHANNELS.towerDispatches, IPC_TIMEOUT_MS, projectKey),
  towerCommentGlyph: (projectKey, orbit, glyphId, body) =>
    invoke(IPC_CHANNELS.towerCommentGlyph, IPC_TIMEOUT_MS, projectKey, orbit, glyphId, body),
  towerCommentSignal: (projectKey, orbit, signalId, body) =>
    invoke(IPC_CHANNELS.towerCommentSignal, IPC_TIMEOUT_MS, projectKey, orbit, signalId, body),
  boothDrafts: (projectKey) => invoke(IPC_CHANNELS.boothDrafts, IPC_TIMEOUT_MS, projectKey),
  boothReview: (projectKey, draftId, action, body) =>
    invoke(IPC_CHANNELS.boothReview, IPC_TIMEOUT_MS, projectKey, draftId, action, body),
  quasarSessions: (quasarKey, limit) =>
    invoke(IPC_CHANNELS.quasarSessions, IPC_TIMEOUT_MS, quasarKey, limit),
  quasarSearch: (query, quasarKey) =>
    invoke(IPC_CHANNELS.quasarSearch, IPC_TIMEOUT_MS, query, quasarKey),
  quasarSessionDetail: (sessionId) =>
    invoke(IPC_CHANNELS.quasarSessionDetail, IPC_TIMEOUT_MS, sessionId),
  agentIdentity: (key) => invoke(IPC_CHANNELS.agentIdentity, IPC_TIMEOUT_MS, key),
  agentAvatar: (key) => invoke(IPC_CHANNELS.agentAvatar, IPC_TIMEOUT_MS, key),
  agentMessage: (key, text) => invoke(IPC_CHANNELS.agentMessage, AGENT_MESSAGE_TIMEOUT_MS, key, text),
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
};

const chatApi: VellumChatApi = {
  chatOpen: (agentKey, resumeSessionId) =>
    invoke(IPC_CHANNELS.chatOpen, IPC_TIMEOUT_MS, agentKey, resumeSessionId),
  chatPrompt: (agentKey, text, contextBlocks) =>
    invoke(IPC_CHANNELS.chatPrompt, CHAT_TURN_TIMEOUT_MS, agentKey, text, contextBlocks),
  chatPermission: (agentKey, requestId, optionId) =>
    invoke(IPC_CHANNELS.chatPermission, IPC_TIMEOUT_MS, agentKey, requestId, optionId),
  chatSetModel: (agentKey, modelId) =>
    invoke(IPC_CHANNELS.chatSetModel, IPC_TIMEOUT_MS, agentKey, modelId),
  chatClose: (agentKey) => invoke(IPC_CHANNELS.chatClose, IPC_TIMEOUT_MS, agentKey),
  onChatEvent: (listener) => subscribe<ChatEvent>(IPC_CHANNELS.chatEvent, listener),
};

contextBridge.exposeInMainWorld("chassis", chassisApi);
contextBridge.exposeInMainWorld("vellum", { ...vellumApi, ...chatApi });
