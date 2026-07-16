import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ArmRegionResult,
  type ChassisApi,
  type ChatEvent,
  type HerdrStreamEvent,
  type HerdrStreamOpenInput,
  type BrowserOpenInput,
  type BrowserSessionInfo,
  type BrowserSurfaceBounds,
  type VellumApi,
  type VellumBrowserApi,
  type VellumChatApi,
  type VellumHerdrApi,
  type KernelSnapshot,
} from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";

// Every real handler answers in well under this; only a dead/wedged main
// process (e.g. killed during a dev restart) never responds. Rejecting then
// surfaces the renderer's existing error banner instead of a silent freeze —
// the exact failure mode that made a stale instance look "non-responsive".
//
// chatOpen/chatSetModel budget: main-side AcpClient.request() bounds
// session/new + session/load + session/set_model at 30s each
// (chat/acp-client.ts REQUEST_TIMEOUT_MS), strictly under this 45s ceiling —
// the main process always wins the race and tears the wedged session down
// before the renderer's own timeout would fire.
const IPC_TIMEOUT_MS = 45_000;

// agentMessage fires a real (up to 180s) hermes turn; give it headroom above
// that instead of sharing the default 45s ceiling every other channel uses.
const AGENT_MESSAGE_TIMEOUT_MS = 200_000;

// A chat turn can run tools for many minutes; streaming events keep the UI
// alive meanwhile, so the invoke ceiling only guards a truly dead backend.
//
// chatPrompt budget: main-side AcpClient.request() bounds session/prompt at
// 840s (chat/acp-client.ts REQUEST_TIMEOUT_MS), strictly under this 900s
// ceiling, for the same reason — main tears the session down first.
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
  deleteCanvas: (name) => invoke(IPC_CHANNELS.deleteCanvas, IPC_TIMEOUT_MS, name),
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
  towerEmitSignal: (input) => invoke(IPC_CHANNELS.towerEmitSignal, IPC_TIMEOUT_MS, input),
  boothDrafts: (projectKey) => invoke(IPC_CHANNELS.boothDrafts, IPC_TIMEOUT_MS, projectKey),
  boothDraftRead: (draftId) => invoke(IPC_CHANNELS.boothDraftRead, IPC_TIMEOUT_MS, draftId),
  boothRequests: (projectKey) => invoke(IPC_CHANNELS.boothRequests, IPC_TIMEOUT_MS, projectKey),
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
  getKernelState: () => invoke<KernelSnapshot>(IPC_CHANNELS.getKernelState, IPC_TIMEOUT_MS),
  armRegion: (canvasName, regionId, armed) =>
    invoke<ArmRegionResult>(IPC_CHANNELS.armRegion, IPC_TIMEOUT_MS, canvasName, regionId, armed),
  pulseRegion: (canvasName, regionId, opts) =>
    invoke<void>(IPC_CHANNELS.pulseRegion, IPC_TIMEOUT_MS, canvasName, regionId, opts),
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
  onKernelChanged: (listener) => subscribe<KernelSnapshot>(IPC_CHANNELS.kernelChanged, listener),
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

const herdrApi: VellumHerdrApi = {
  herdrHosts: () => invoke(IPC_CHANNELS.herdrHosts, IPC_TIMEOUT_MS),
  herdrEnsureServer: (hostId, session) =>
    invoke(IPC_CHANNELS.herdrEnsureServer, IPC_TIMEOUT_MS, hostId, session),
  herdrListSessions: (hostId) => invoke(IPC_CHANNELS.herdrListSessions, IPC_TIMEOUT_MS, hostId),
  herdrListWorkspaces: (hostId, session) =>
    invoke(IPC_CHANNELS.herdrListWorkspaces, IPC_TIMEOUT_MS, hostId, session),
  herdrListTabs: (hostId, session, workspaceId) =>
    invoke(IPC_CHANNELS.herdrListTabs, IPC_TIMEOUT_MS, hostId, session, workspaceId),
  herdrListPanes: (hostId, session, workspaceId) =>
    invoke(IPC_CHANNELS.herdrListPanes, IPC_TIMEOUT_MS, hostId, session, workspaceId),
  herdrListAgents: (hostId, session) =>
    invoke(IPC_CHANNELS.herdrListAgents, IPC_TIMEOUT_MS, hostId, session),
  herdrGetMeta: (hostId, session, paneId) =>
    invoke(IPC_CHANNELS.herdrGetMeta, IPC_TIMEOUT_MS, hostId, session, paneId),
  herdrCreateWorkspace: (hostId, session, input) =>
    invoke(IPC_CHANNELS.herdrCreateWorkspace, IPC_TIMEOUT_MS, hostId, session, input),
  herdrCreateTab: (hostId, session, input) =>
    invoke(IPC_CHANNELS.herdrCreateTab, IPC_TIMEOUT_MS, hostId, session, input),
  herdrCreatePane: (hostId, session, input) =>
    invoke(IPC_CHANNELS.herdrCreatePane, IPC_TIMEOUT_MS, hostId, session, input),
  herdrKillPane: (hostId, session, paneId) =>
    invoke(IPC_CHANNELS.herdrKillPane, IPC_TIMEOUT_MS, hostId, session, paneId),
  herdrKillTab: (hostId, session, tabId) =>
    invoke(IPC_CHANNELS.herdrKillTab, IPC_TIMEOUT_MS, hostId, session, tabId),
  herdrStreamOpen: (input: HerdrStreamOpenInput) =>
    invoke(IPC_CHANNELS.herdrStreamOpen, IPC_TIMEOUT_MS, input),
  herdrStreamInput: (streamId, dataBase64) =>
    invoke(IPC_CHANNELS.herdrStreamInput, IPC_TIMEOUT_MS, streamId, dataBase64),
  herdrStreamResize: (streamId, cols, rows) =>
    invoke(IPC_CHANNELS.herdrStreamResize, IPC_TIMEOUT_MS, streamId, cols, rows),
  herdrStreamScroll: (streamId, delta, at) =>
    invoke(IPC_CHANNELS.herdrStreamScroll, IPC_TIMEOUT_MS, streamId, delta, at),
  herdrStreamClose: (streamId) => invoke(IPC_CHANNELS.herdrStreamClose, IPC_TIMEOUT_MS, streamId),
  onHerdrStreamEvent: (listener) => subscribe<HerdrStreamEvent>(IPC_CHANNELS.herdrStreamEvent, listener),
};

const browserApi: VellumBrowserApi = {
  browserProfiles: () => invoke(IPC_CHANNELS.browserProfiles, IPC_TIMEOUT_MS),
  browserOpen: (input: BrowserOpenInput) => invoke(IPC_CHANNELS.browserOpen, IPC_TIMEOUT_MS, input),
  browserClose: (nodeId) => invoke(IPC_CHANNELS.browserClose, IPC_TIMEOUT_MS, nodeId),
  browserSessionState: (nodeId) =>
    invoke(IPC_CHANNELS.browserSessionState, IPC_TIMEOUT_MS, nodeId),
  browserSessionList: () => invoke(IPC_CHANNELS.browserSessionList, IPC_TIMEOUT_MS),
  browserSetBounds: (nodeId, bounds: BrowserSurfaceBounds) =>
    invoke(IPC_CHANNELS.browserSetBounds, IPC_TIMEOUT_MS, nodeId, bounds),
  onBrowserSessionChanged: (listener) =>
    subscribe<BrowserSessionInfo>(IPC_CHANNELS.browserSessionChanged, listener),
};

contextBridge.exposeInMainWorld("chassis", chassisApi);
contextBridge.exposeInMainWorld("vellum", { ...vellumApi, ...chatApi, ...herdrApi, ...browserApi });
