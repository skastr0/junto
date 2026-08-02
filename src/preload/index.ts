import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ChassisApi,
  type ChatEvent,
  type HerdrMirrorEvent,
  type HerdrStreamEvent,
  type HerdrStreamOpenInput,
  type BrowserOpenInput,
  type BrowserProfileWipeInput,
  type BrowserSessionInfo,
  type BrowserSurfaceBounds,
  type CanvasFlushRequest,
  type CanvasQuiesceAndFlushOutcome,
  type CanvasQuiesceAndFlushRequest,
  type LoginItemOpResult,
  type VellumApi,
  type VellumBrowserApi,
  type VellumChatApi,
  type VellumDemoApi,
  type VellumHerdrApi,
  type VellumTerminalApi,
  type KernelSnapshot,
  type NodeRefOpenedDelivery,
  type NodeRefOpenedEvent,
  type ObservabilityLogEntry,
  type ObservabilityQuery,
  type ObservabilitySnapshot,
} from "@shared/ipc";
import type { SnapshotState } from "@shared/entities";
import type { PreambleEvent } from "@shared/preamble";
import type { Settings, SettingsOpResult, SettingsPatch, SettingsSectionKey } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { LicenseStatus } from "@shared/license";
import type { UpdateStatus } from "@shared/update";
import { nodeRefKey, parseNodeRef } from "@shared/node-ref";
import { isRendererPreloadCandidate } from "@shared/trusted-renderer-origin";
import type {
  StateRecoveryExportResult,
  StateRecoveryListResult,
} from "@shared/state-recovery";

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
/** Box-backed host interaction may include provider resume + SSH verification. */
const HOST_ACTIVATION_IPC_TIMEOUT_MS = 360_000;

// Dual codexbar fan-out (enabled providers + codex --all-accounts) can take
// well over 45s when vendor web endpoints are slow. getUsage stays on the
// default ceiling — it only reads in-memory state.
const USAGE_REFRESH_TIMEOUT_MS = 120_000;

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

let pendingNodeRefOpened: NodeRefOpenedDelivery | undefined;
let nodeRefOpenedListener: ((event: NodeRefOpenedEvent) => void | Promise<void>) | undefined;
let nodeRefOpenedRevision = 0;

const DELIVERY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeNodeRefOpened = (payload: unknown): NodeRefOpenedDelivery | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (Object.keys(payload).sort().join(",") !== "canvasName,deliveryId,nodeId,ref") {
    return undefined;
  }
  if (!("ref" in payload) || typeof payload.ref !== "string") return undefined;
  if (!("canvasName" in payload) || typeof payload.canvasName !== "string") return undefined;
  if (!("nodeId" in payload) || typeof payload.nodeId !== "string") return undefined;
  if (!("deliveryId" in payload) || typeof payload.deliveryId !== "string") return undefined;
  if (!DELIVERY_ID_PATTERN.test(payload.deliveryId)) return undefined;
  const parsed = parseNodeRef(payload.ref);
  if (!parsed.ok || nodeRefKey(parsed.value) !== payload.ref) return undefined;
  if (parsed.value.canvasName !== payload.canvasName || parsed.value.nodeId !== payload.nodeId) {
    return undefined;
  }
  return {
    ref: payload.ref,
    canvasName: payload.canvasName,
    nodeId: payload.nodeId,
    deliveryId: payload.deliveryId,
  };
};

const startNodeRefOpened = async (
  delivery: NodeRefOpenedDelivery,
  revision: number,
): Promise<void> => {
  const listener = nodeRefOpenedListener;
  if (listener === undefined) {
    if (revision === nodeRefOpenedRevision) pendingNodeRefOpened = delivery;
    return;
  }
  try {
    await listener({
      ref: delivery.ref,
      canvasName: delivery.canvasName,
      nodeId: delivery.nodeId,
    });
    if (revision === nodeRefOpenedRevision) {
      ipcRenderer.send(IPC_CHANNELS.nodeRefOpenedAck, delivery.deliveryId);
    }
  } catch {
    if (revision === nodeRefOpenedRevision) pendingNodeRefOpened = delivery;
  }
};

const deliverNodeRefOpened = (delivery: NodeRefOpenedDelivery): void => {
  const revision = ++nodeRefOpenedRevision;
  pendingNodeRefOpened = delivery;
  if (nodeRefOpenedListener === undefined) return;
  pendingNodeRefOpened = undefined;
  void startNodeRefOpened(delivery, revision);
};

ipcRenderer.on(IPC_CHANNELS.nodeRefOpened, (_event, payload: unknown) => {
  const decoded = decodeNodeRefOpened(payload);
  if (decoded !== undefined) deliverNodeRefOpened(decoded);
});

const onNodeRefOpened = (
  listener: (event: NodeRefOpenedEvent) => void | Promise<void>,
): (() => void) => {
  nodeRefOpenedListener = listener;
  const queued = pendingNodeRefOpened;
  if (queued !== undefined) {
    pendingNodeRefOpened = undefined;
    void startNodeRefOpened(queued, nodeRefOpenedRevision);
  }
  return () => {
    if (nodeRefOpenedListener === listener) nodeRefOpenedListener = undefined;
  };
};

let canvasFlushListener: (() => void | Promise<void>) | undefined;
let pendingCanvasFlush: CanvasFlushRequest | undefined;

const decodeCanvasFlushRequest = (payload: unknown): CanvasFlushRequest | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (Object.keys(payload).join(",") !== "requestId") return undefined;
  if (!("requestId" in payload) || typeof payload.requestId !== "string") return undefined;
  if (!DELIVERY_ID_PATTERN.test(payload.requestId)) return undefined;
  return { requestId: payload.requestId };
};

const deliverCanvasFlush = async (request: CanvasFlushRequest): Promise<void> => {
  const listener = canvasFlushListener;
  if (listener === undefined) {
    pendingCanvasFlush = request;
    return;
  }
  let ok = false;
  try {
    await listener();
    ok = true;
  } catch {
    // Main receives ok:false and keeps the window/app alive. The renderer's
    // save pipeline already owns the user-visible error detail.
  } finally {
    ipcRenderer.send(IPC_CHANNELS.canvasFlushComplete, { requestId: request.requestId, ok });
  }
};

ipcRenderer.on(IPC_CHANNELS.canvasFlushRequested, (_event, payload: unknown) => {
  const request = decodeCanvasFlushRequest(payload);
  if (request === undefined) return;
  pendingCanvasFlush = request;
  if (canvasFlushListener === undefined) return;
  pendingCanvasFlush = undefined;
  void deliverCanvasFlush(request);
});

const onCanvasFlushRequested = (
  listener: () => void | Promise<void>,
): (() => void) => {
  canvasFlushListener = listener;
  const pending = pendingCanvasFlush;
  if (pending !== undefined) {
    pendingCanvasFlush = undefined;
    void deliverCanvasFlush(pending);
  }
  return () => {
    if (canvasFlushListener === listener) canvasFlushListener = undefined;
  };
};

let canvasQuiesceAndFlushListener:
  | ((
      acknowledgeQuiesced: () => void,
    ) => CanvasQuiesceAndFlushOutcome | Promise<CanvasQuiesceAndFlushOutcome>)
  | undefined;
let pendingCanvasQuiesceAndFlush: CanvasQuiesceAndFlushRequest | undefined;
let activeCanvasQuiesceAndFlushRequestId: string | undefined;
const seenCanvasQuiesceAndFlushRequestIds = new Set<string>();

type PrivateFinalWriteOperation = "canvas.write" | "canvas.create";

const finalWriteMetadata = (
  operation: PrivateFinalWriteOperation,
): Readonly<{
  __vellumFinalWrite: Readonly<{
    requestId: string;
    operation: PrivateFinalWriteOperation;
  }>;
}> | undefined => {
  const requestId = activeCanvasQuiesceAndFlushRequestId;
  if (requestId === undefined) return undefined;
  return Object.freeze({
    __vellumFinalWrite: Object.freeze({ requestId, operation }),
  });
};

const invokeCanvasWrite = <T>(
  name: string,
  doc: unknown,
  expectedRevision: string | undefined,
): Promise<T> => {
  const metadata = finalWriteMetadata("canvas.write");
  if (metadata === undefined) {
    return invoke(IPC_CHANNELS.writeCanvas, IPC_TIMEOUT_MS, name, doc, expectedRevision);
  }
  return invoke(
    IPC_CHANNELS.writeCanvas,
    IPC_TIMEOUT_MS,
    name,
    doc,
    expectedRevision,
    metadata,
  );
};

const invokeCanvasCreate = <T>(name: string): Promise<T> => {
  const metadata = finalWriteMetadata("canvas.create");
  if (metadata === undefined) return invoke(IPC_CHANNELS.createCanvas, IPC_TIMEOUT_MS, name);
  return invoke(IPC_CHANNELS.createCanvas, IPC_TIMEOUT_MS, name, metadata);
};

const decodeCanvasQuiesceAndFlushRequest = (
  payload: unknown,
): CanvasQuiesceAndFlushRequest | undefined => decodeCanvasFlushRequest(payload);

const deliverCanvasQuiesceAndFlush = async (
  request: CanvasQuiesceAndFlushRequest,
): Promise<void> => {
  const listener = canvasQuiesceAndFlushListener;
  if (listener === undefined) {
    pendingCanvasQuiesceAndFlush = request;
    return;
  }
  if (activeCanvasQuiesceAndFlushRequestId !== undefined) {
    ipcRenderer.send(IPC_CHANNELS.canvasQuiesceAndFlushComplete, {
      requestId: request.requestId,
      ok: false,
      quiesced: false,
    });
    return;
  }
  activeCanvasQuiesceAndFlushRequestId = request.requestId;
  let quiesced = false;
  const acknowledgeQuiesced = (): void => {
    if (quiesced) return;
    quiesced = true;
    ipcRenderer.send(IPC_CHANNELS.canvasQuiesceAndFlushStarted, {
      requestId: request.requestId,
    });
  };
  let outcome: CanvasQuiesceAndFlushOutcome = { ok: false, quiesced: false };
  try {
    const result = await listener(acknowledgeQuiesced);
    if (typeof result?.ok === "boolean" && typeof result.quiesced === "boolean") {
      // Started is monotonic evidence from this preload generation. A buggy
      // listener result may add evidence, but it can never retract that ACK.
      outcome = { ok: result.ok, quiesced: quiesced || result.quiesced };
    }
  } catch {
    outcome = { ok: false, quiesced };
  } finally {
    if (activeCanvasQuiesceAndFlushRequestId === request.requestId) {
      activeCanvasQuiesceAndFlushRequestId = undefined;
    }
    ipcRenderer.send(IPC_CHANNELS.canvasQuiesceAndFlushComplete, {
      requestId: request.requestId,
      ...outcome,
    });
  }
};

ipcRenderer.on(IPC_CHANNELS.canvasQuiesceAndFlushRequested, (_event, payload: unknown) => {
  const request = decodeCanvasQuiesceAndFlushRequest(payload);
  if (request === undefined) return;
  const inFlightRequestId =
    activeCanvasQuiesceAndFlushRequestId ?? pendingCanvasQuiesceAndFlush?.requestId;
  if (inFlightRequestId !== undefined) {
    // A duplicate delivery cannot supersede the active request. Do not emit a
    // negative completion for that same id: main could mistake it for the
    // active delivery's outcome. A distinct overlap is explicitly refused.
    if (request.requestId !== inFlightRequestId) {
      seenCanvasQuiesceAndFlushRequestIds.add(request.requestId);
      ipcRenderer.send(IPC_CHANNELS.canvasQuiesceAndFlushComplete, {
        requestId: request.requestId,
        ok: false,
        quiesced: false,
      });
    }
    return;
  }
  if (seenCanvasQuiesceAndFlushRequestIds.has(request.requestId)) {
    ipcRenderer.send(IPC_CHANNELS.canvasQuiesceAndFlushComplete, {
      requestId: request.requestId,
      ok: false,
      quiesced: false,
    });
    return;
  }
  seenCanvasQuiesceAndFlushRequestIds.add(request.requestId);
  pendingCanvasQuiesceAndFlush = request;
  if (canvasQuiesceAndFlushListener === undefined) return;
  pendingCanvasQuiesceAndFlush = undefined;
  void deliverCanvasQuiesceAndFlush(request);
});

const onCanvasQuiesceAndFlushRequested = (
  listener: (
    acknowledgeQuiesced: () => void,
  ) => CanvasQuiesceAndFlushOutcome | Promise<CanvasQuiesceAndFlushOutcome>,
): (() => void) => {
  canvasQuiesceAndFlushListener = listener;
  const pending = pendingCanvasQuiesceAndFlush;
  if (pending !== undefined) {
    pendingCanvasQuiesceAndFlush = undefined;
    void deliverCanvasQuiesceAndFlush(pending);
  }
  return () => {
    if (canvasQuiesceAndFlushListener === listener) {
      canvasQuiesceAndFlushListener = undefined;
    }
  };
};

let rendererSurfaceMounted = false;
let rendererSurfaceChallenge: string | undefined;

const sendRendererSurfaceReceipt = (): void => {
  if (!rendererSurfaceMounted || rendererSurfaceChallenge === undefined) return;
  ipcRenderer.send(IPC_CHANNELS.rendererSurfaceReady, rendererSurfaceChallenge);
};

ipcRenderer.on(IPC_CHANNELS.rendererSurfaceChallenge, (_event, candidate: unknown) => {
  if (typeof candidate !== "string" || candidate.length === 0) return;
  rendererSurfaceChallenge = candidate;
  sendRendererSurfaceReceipt();
});

const vellumApi: VellumApi = {
  platform: process.platform,
  licenseStatus: () =>
    invoke(IPC_CHANNELS.licenseStatus, IPC_TIMEOUT_MS),
  licenseActivate: (licenseKey) =>
    invoke(
      IPC_CHANNELS.licenseActivate,
      IPC_TIMEOUT_MS,
      licenseKey,
    ),
  licenseRefresh: () =>
    invoke(IPC_CHANNELS.licenseRefresh, IPC_TIMEOUT_MS),
  licenseDeactivate: () =>
    invoke(IPC_CHANNELS.licenseDeactivate, IPC_TIMEOUT_MS),
  licenseOpenCustomerPortal: () =>
    invoke(
      IPC_CHANNELS.licenseOpenCustomerPortal,
      IPC_TIMEOUT_MS,
    ),
  licenseRestart: () =>
    invoke(IPC_CHANNELS.licenseRestart, IPC_TIMEOUT_MS),
  onLicenseChanged: (listener) =>
    subscribe<LicenseStatus>(IPC_CHANNELS.licenseChanged, listener),
  updateGetState: () =>
    invoke(IPC_CHANNELS.updateGetState, IPC_TIMEOUT_MS),
  updateCheck: () =>
    invoke(IPC_CHANNELS.updateCheck, IPC_TIMEOUT_MS),
  updateRestartAndInstall: () =>
    invoke(IPC_CHANNELS.updateRestartAndInstall, IPC_TIMEOUT_MS),
  onUpdateStateChanged: (listener) =>
    subscribe<UpdateStatus>(IPC_CHANNELS.updateStateChanged, listener),
  rendererSurfaceReady: () => {
    rendererSurfaceMounted = true;
    sendRendererSurfaceReceipt();
  },
  listCanvases: () => invoke(IPC_CHANNELS.listCanvases, IPC_TIMEOUT_MS),
  readCanvas: (name) => invoke(IPC_CHANNELS.readCanvas, IPC_TIMEOUT_MS, name),
  writeCanvas: (name, doc, expectedRevision) =>
    invokeCanvasWrite(name, doc, expectedRevision),
  createCanvas: (name) => invokeCanvasCreate(name),
  deleteCanvas: (name) => invoke(IPC_CHANNELS.deleteCanvas, IPC_TIMEOUT_MS, name),
  exportDigest: (name) => invoke(IPC_CHANNELS.exportDigest, IPC_TIMEOUT_MS, name),
  generatePortfolio: (name, options) =>
    invoke(IPC_CHANNELS.generatePortfolio, IPC_TIMEOUT_MS, name, options),
  getSnapshots: () => invoke(IPC_CHANNELS.getSnapshots, IPC_TIMEOUT_MS),
  refreshSnapshots: (hints) => invoke(IPC_CHANNELS.refreshSnapshots, IPC_TIMEOUT_MS, hints),
  getUsage: () => invoke(IPC_CHANNELS.getUsage, IPC_TIMEOUT_MS),
  refreshUsage: () => invoke(IPC_CHANNELS.refreshUsage, USAGE_REFRESH_TIMEOUT_MS),
  agentMessage: (key, text) => invoke(IPC_CHANNELS.agentMessage, AGENT_MESSAGE_TIMEOUT_MS, key, text),
  getKernelState: () => invoke<KernelSnapshot>(IPC_CHANNELS.getKernelState, IPC_TIMEOUT_MS),
  factoryPauseState: (canvas) =>
    invoke(IPC_CHANNELS.factoryPauseState, IPC_TIMEOUT_MS, canvas),
  factoryPauseSet: (canvas, scope, paused) =>
    invoke(IPC_CHANNELS.factoryPauseSet, IPC_TIMEOUT_MS, canvas, scope, paused),
  regionRollups: (name) =>
    invoke(IPC_CHANNELS.regionRollups, IPC_TIMEOUT_MS, name),
  contentPutImage: (input) =>
    invoke(IPC_CHANNELS.contentPutImage, IPC_TIMEOUT_MS, input),
  workTaskCreate: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria) =>
    invoke(
      IPC_CHANNELS.workTaskCreate,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      brief,
      metadata,
      reason,
      media,
      dependsOn,
      finishCriteria,
    ),
  workTaskPropose: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria) =>
    invoke(
      IPC_CHANNELS.workTaskPropose,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      brief,
      metadata,
      reason,
      media,
      dependsOn,
      finishCriteria,
    ),
  workTaskApproveProposal: (canvas, nodeId, taskId) =>
    invoke(IPC_CHANNELS.workTaskApproveProposal, IPC_TIMEOUT_MS, canvas, nodeId, taskId),
  workTaskDescribe: (canvas, nodeId, taskId, brief) =>
    invoke(IPC_CHANNELS.workTaskDescribe, IPC_TIMEOUT_MS, canvas, nodeId, taskId, brief),
  workTaskTransition: (canvas, nodeId, taskId, state, note, completionEvidence) =>
    invoke(
      IPC_CHANNELS.workTaskTransition,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      taskId,
      state,
      note,
      completionEvidence,
    ),
  workTaskRespond: (canvas, nodeId, taskId, responseText, disposition) =>
    invoke(
      IPC_CHANNELS.workTaskRespond,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      taskId,
      responseText,
      disposition,
    ),
  workTaskClaim: (canvas, nodeId, taskId, actor) =>
    invoke(IPC_CHANNELS.workTaskClaim, IPC_TIMEOUT_MS, canvas, nodeId, taskId, actor),
  workRequestResolve: (canvas, nodeId, taskId, responseText, disposition) =>
    invoke(
      IPC_CHANNELS.workRequestResolve,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      taskId,
      responseText,
      disposition,
    ),
  workBoardList: (canvas, nodeId, topicId) =>
    invoke(
      IPC_CHANNELS.workBoardList,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
    ),
  workBoardCreateTopic: (canvas, nodeId, title, body, notify) =>
    invoke(
      IPC_CHANNELS.workBoardCreateTopic,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      title,
      body,
      notify,
    ),
  workBoardPost: (canvas, nodeId, topicId, text) =>
    invoke(
      IPC_CHANNELS.workBoardPost,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
      text,
    ),
  workBoardMarkRead: (canvas, nodeId, topicId) =>
    invoke(
      IPC_CHANNELS.workBoardMarkRead,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
    ),
  workBoardNotify: (canvas, nodeId, topicId) =>
    invoke(
      IPC_CHANNELS.workBoardNotify,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
    ),
  onNodeRefOpened,
  onCanvasFlushRequested,
  onCanvasQuiesceAndFlushRequested,
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onPreamble: (listener) => subscribe<PreambleEvent>(IPC_CHANNELS.preamble, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
  onUsageChanged: (listener) => subscribe<UsageState>(IPC_CHANNELS.usageChanged, listener),
  onKernelChanged: (listener) => subscribe<KernelSnapshot>(IPC_CHANNELS.kernelChanged, listener),
  hostsList: () => invoke(IPC_CHANNELS.hostsList, IPC_TIMEOUT_MS),
  hostsDiscoverPeers: () => invoke(IPC_CHANNELS.hostsDiscoverPeers, IPC_TIMEOUT_MS),
  hostsUpsert: (host: unknown) => invoke(IPC_CHANNELS.hostsUpsert, IPC_TIMEOUT_MS, host),
  hostsRemove: (id: string) => invoke(IPC_CHANNELS.hostsRemove, IPC_TIMEOUT_MS, id),
  hostsTest: (id: string) => invoke(IPC_CHANNELS.hostsTest, IPC_TIMEOUT_MS, id),
  hostsConfigureRemote: (id: string) =>
    invoke(IPC_CHANNELS.hostsConfigureRemote, IPC_TIMEOUT_MS, id),
  hostsDeployRemote: (input) =>
    invoke(IPC_CHANNELS.hostsDeployRemote, 1_200_000, input),
  hostsDeployJobGet: (hostId: string) =>
    invoke(IPC_CHANNELS.hostsDeployJobGet, IPC_TIMEOUT_MS, hostId),
  hostsDeployJobsList: () =>
    invoke(IPC_CHANNELS.hostsDeployJobsList, IPC_TIMEOUT_MS),
  onHostsDeployJobChanged: (listener) =>
    subscribe(IPC_CHANNELS.hostsDeployJobChanged, listener),
  hostsDeployCapabilities: () =>
    invoke(IPC_CHANNELS.hostsDeployCapabilities, IPC_TIMEOUT_MS),
  boxAvailability: () =>
    invoke(IPC_CHANNELS.boxAvailability, IPC_TIMEOUT_MS),
  boxListOwned: () =>
    invoke(IPC_CHANNELS.boxListOwned, IPC_TIMEOUT_MS),
  boxCreate: () =>
    invoke(IPC_CHANNELS.boxCreate, 120_000),
  boxRefresh: (boxId: string) =>
    invoke(IPC_CHANNELS.boxRefresh, IPC_TIMEOUT_MS, boxId),
  boxPrepareSsh: (boxId: string) =>
    invoke(IPC_CHANNELS.boxPrepareSsh, 180_000, boxId),
  boxStop: (boxId: string) =>
    invoke(IPC_CHANNELS.boxStop, 180_000, boxId),
  boxResume: (boxId: string) =>
    invoke(IPC_CHANNELS.boxResume, 180_000, boxId),
  boxDetach: (boxId: string) =>
    invoke(IPC_CHANNELS.boxDetach, IPC_TIMEOUT_MS, boxId),
  settingsGet: () => invoke<SettingsOpResult>(IPC_CHANNELS.settingsGet, IPC_TIMEOUT_MS),
  settingsPatch: (patch: SettingsPatch) =>
    invoke<SettingsOpResult>(IPC_CHANNELS.settingsPatch, IPC_TIMEOUT_MS, patch),
  settingsSetStationTopology: (station) =>
    invoke<SettingsOpResult>(
      IPC_CHANNELS.settingsSetStationTopology,
      IPC_TIMEOUT_MS,
      station,
    ),
  settingsReset: (section?: SettingsSectionKey) =>
    invoke<SettingsOpResult>(IPC_CHANNELS.settingsReset, IPC_TIMEOUT_MS, section),
  stateBackupsList: async () =>
    await invoke<StateRecoveryListResult>(
      IPC_CHANNELS.stateBackupsList,
      IPC_TIMEOUT_MS,
    ),
  stateBackupExport: async (id) =>
    await invoke<StateRecoveryExportResult>(
      IPC_CHANNELS.stateBackupExport,
      IPC_TIMEOUT_MS,
      id,
    ),
  loginItemGet: () => invoke<LoginItemOpResult>(IPC_CHANNELS.loginItemGet, IPC_TIMEOUT_MS),
  loginItemSet: (openAtLogin: boolean) =>
    invoke<LoginItemOpResult>(IPC_CHANNELS.loginItemSet, IPC_TIMEOUT_MS, openAtLogin),
  onSettingsChanged: (listener) => subscribe<Settings>(IPC_CHANNELS.settingsChanged, listener),
  observabilityQuery: (query?: ObservabilityQuery) =>
    invoke<ObservabilitySnapshot>(
      IPC_CHANNELS.observabilityQuery,
      IPC_TIMEOUT_MS,
      query,
    ),
  observabilityClear: () =>
    invoke<ObservabilitySnapshot>(IPC_CHANNELS.observabilityClear, IPC_TIMEOUT_MS),
  observabilityWatch: () =>
    invoke<ObservabilitySnapshot>(IPC_CHANNELS.observabilityWatch, IPC_TIMEOUT_MS),
  observabilityUnwatch: () =>
    invoke<{ ok: true }>(IPC_CHANNELS.observabilityUnwatch, IPC_TIMEOUT_MS),
  onObservabilityLog: (listener) =>
    subscribe<ObservabilityLogEntry>(IPC_CHANNELS.observabilityLog, listener),
  onObservabilityCleared: (listener) =>
    subscribe<{ newestId: number; total: number; dropped: number }>(
      IPC_CHANNELS.observabilityCleared,
      listener,
    ),
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
  chatBeginNodeDelete: (resources) =>
    invoke(IPC_CHANNELS.chatBeginNodeDelete, IPC_TIMEOUT_MS, resources),
  chatFinishNodeDelete: (leaseId, outcome) =>
    invoke(IPC_CHANNELS.chatFinishNodeDelete, IPC_TIMEOUT_MS, leaseId, outcome),
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
  herdrServiceMapGet: (hostId, session, paneId) =>
    invoke(IPC_CHANNELS.herdrServiceMapGet, IPC_TIMEOUT_MS, hostId, session, paneId),
  herdrServiceMapProbe: (hostId, session, paneId) =>
    invoke(IPC_CHANNELS.herdrServiceMapProbe, IPC_TIMEOUT_MS, hostId, session, paneId),
  onHerdrServiceMapEvent: (listener) =>
    subscribe(IPC_CHANNELS.herdrServiceMapEvent, listener),
  herdrServeCatalogGet: (hostId) =>
    invoke(IPC_CHANNELS.herdrServeCatalogGet, IPC_TIMEOUT_MS, hostId),
  herdrServeCatalogRefresh: (hostId) =>
    invoke(IPC_CHANNELS.herdrServeCatalogRefresh, IPC_TIMEOUT_MS, hostId),
  herdrMarkPaneSeen: (hostId, session, paneId) =>
    invoke(IPC_CHANNELS.herdrMarkPaneSeen, IPC_TIMEOUT_MS, hostId, session, paneId),
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
  herdrStreamPasteImage: (streamId, extension, dataBase64) =>
    invoke(IPC_CHANNELS.herdrStreamPasteImage, IPC_TIMEOUT_MS, streamId, extension, dataBase64),
  herdrStreamResize: (streamId, cols, rows) =>
    invoke(IPC_CHANNELS.herdrStreamResize, IPC_TIMEOUT_MS, streamId, cols, rows),
  herdrStreamScroll: (streamId, delta, at) =>
    invoke(IPC_CHANNELS.herdrStreamScroll, IPC_TIMEOUT_MS, streamId, delta, at),
  herdrStreamClose: (streamId) => invoke(IPC_CHANNELS.herdrStreamClose, IPC_TIMEOUT_MS, streamId),
  herdrObserveTouch: (input) => invoke(IPC_CHANNELS.herdrObserveTouch, IPC_TIMEOUT_MS, input),
  herdrObserveRetained: (terminalId) =>
    invoke(IPC_CHANNELS.herdrObserveRetained, IPC_TIMEOUT_MS, terminalId),
  onHerdrStreamEvent: (listener) => subscribe<HerdrStreamEvent>(IPC_CHANNELS.herdrStreamEvent, listener),
  herdrMirrorState: () => invoke(IPC_CHANNELS.herdrMirrorState, IPC_TIMEOUT_MS),
  onHerdrMirrorEvent: (listener) =>
    subscribe<HerdrMirrorEvent>(IPC_CHANNELS.herdrMirrorEvent, listener),
};

const browserApi: VellumBrowserApi = {
  browserProfiles: () => invoke(IPC_CHANNELS.browserProfiles, IPC_TIMEOUT_MS),
  browserSurfaceConfig: () => invoke(IPC_CHANNELS.browserSurfaceConfig, IPC_TIMEOUT_MS),
  browserOpen: (input: BrowserOpenInput) =>
    invoke(
      IPC_CHANNELS.browserOpen,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      input,
    ),
  browserClose: (sessionId) => invoke(IPC_CHANNELS.browserClose, IPC_TIMEOUT_MS, sessionId),
  browserStop: (sessionId) => invoke(IPC_CHANNELS.browserStop, IPC_TIMEOUT_MS, sessionId),
  browserWipeProfile: (input: BrowserProfileWipeInput) =>
    invoke(IPC_CHANNELS.browserWipeProfile, IPC_TIMEOUT_MS, input),
  browserSessionState: (sessionId) =>
    invoke(IPC_CHANNELS.browserSessionState, IPC_TIMEOUT_MS, sessionId),
  browserSessionList: () => invoke(IPC_CHANNELS.browserSessionList, IPC_TIMEOUT_MS),
  browserSetBounds: (sessionId, bounds: BrowserSurfaceBounds) =>
    invoke(IPC_CHANNELS.browserSetBounds, IPC_TIMEOUT_MS, sessionId, bounds),
  onBrowserSessionChanged: (listener) =>
    subscribe<BrowserSessionInfo>(IPC_CHANNELS.browserSessionChanged, listener),
};

const terminalApi: VellumTerminalApi = {
  terminalList: (hostId) =>
    invoke(
      IPC_CHANNELS.terminalList,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      hostId,
    ),
  terminalCreate: (input) =>
    invoke(
      IPC_CHANNELS.terminalCreate,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      input,
    ),
  terminalGet: (bindingId, hostId) =>
    invoke(
      IPC_CHANNELS.terminalGet,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      bindingId,
      hostId,
    ),
  terminalKill: (bindingId, hostId) => invoke(IPC_CHANNELS.terminalKill, IPC_TIMEOUT_MS, bindingId, hostId),
  hostDirectoryRead: (hostId, path) =>
    invoke(
      IPC_CHANNELS.hostDirectoryRead,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      hostId,
      path,
    ),
  terminalBindCanvas: (bindingId, ref, hostId) =>
    invoke(IPC_CHANNELS.terminalBindCanvas, IPC_TIMEOUT_MS, bindingId, ref, hostId),
  terminalAttach: (input) =>
    invoke(
      IPC_CHANNELS.terminalAttach,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      input,
    ),
  terminalRelease: (leaseId) => invoke(IPC_CHANNELS.terminalRelease, IPC_TIMEOUT_MS, leaseId),
  terminalWrite: (leaseId, data, encoding) => invoke(IPC_CHANNELS.terminalWrite, IPC_TIMEOUT_MS, leaseId, data, encoding),
  terminalResize: (leaseId, cols, rows) => invoke(IPC_CHANNELS.terminalResize, IPC_TIMEOUT_MS, leaseId, cols, rows),
  onTerminalEvent: (listener) => subscribe(IPC_CHANNELS.terminalEvent, listener),
  managedTerminalModels: (harness) =>
    invoke(IPC_CHANNELS.managedTerminalModels, IPC_TIMEOUT_MS, harness),
  managedTerminalProfiles: () =>
    invoke(IPC_CHANNELS.managedTerminalProfiles, IPC_TIMEOUT_MS),
  agentSeatStateSnapshot: () =>
    invoke(IPC_CHANNELS.agentSeatStateSnapshot, IPC_TIMEOUT_MS),
  onAgentSeatStateChanged: (listener) =>
    subscribe(IPC_CHANNELS.agentSeatStateChanged, listener),
};

const demoApi: VellumDemoApi = {
  demoState: () => invoke(IPC_CHANNELS.demoState, IPC_TIMEOUT_MS),
  demoCommand: (command) => invoke(IPC_CHANNELS.demoCommand, IPC_TIMEOUT_MS, command),
  demoWriteEdl: (edl) => invoke(IPC_CHANNELS.demoWriteEdl, IPC_TIMEOUT_MS, edl),
};


// A preload is attached before Chromium has committed a document. Do not hand
// a remote page the product API during that interval. Main independently
// checks the exact WebContents + committed authority, which is what protects
// a hostile loopback service in development.
const preloadLocation = typeof globalThis.location === "undefined"
  ? undefined // Node-only preload unit tests have no document.
  : globalThis.location.href;

if (preloadLocation === undefined || isRendererPreloadCandidate(preloadLocation)) {
  contextBridge.exposeInMainWorld("chassis", chassisApi);
  contextBridge.exposeInMainWorld("vellum", {
    ...vellumApi,
    ...chatApi,
    ...herdrApi,
    ...terminalApi,
    ...browserApi,
    ...demoApi,
  });
}
