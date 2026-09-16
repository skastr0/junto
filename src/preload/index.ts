import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  type ChassisApi,
  type ChatEvent,
  type BrowserOpenInput,
  type BrowserProfileWipeInput,
  type BrowserSessionInfo,
  type BrowserSurfaceBounds,
  type CanvasFlushRequest,
  type CanvasQuiesceAndFlushOutcome,
  type CanvasQuiesceAndFlushRequest,
  type LoginItemOpResult,
  type VellumCommandApi,
  type VellumCommandBrowserApi,
  type VellumCommandChatApi,
  type VellumCommandDemoApi,
  type VellumCommandGitApi,
  type VellumCommandHermesIntegrationApi,
  type VellumCommandHostsApi,
  type VellumCommandSchedulerApi,
  type VellumCommandTerminalApi,
  type VellumCommandUsageApi,
  type KernelSnapshot,
  type NodeRefOpenedDelivery,
  type NodeRefOpenedEvent,
  type ObservabilityLogEntry,
  type ObservabilityQuery,
  type ObservabilitySnapshot,
  type WorkOpResult,
} from "@shared/ipc";
import type { Task } from "@shared/work-model";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  CRON_ENABLED,
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  LIVE_OVERSEER_ENABLED,
  PAD_ENABLED,
  RELAY_ENABLED,
  REQUESTS_ENABLED,
  TASKS_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import type { SnapshotState } from "@shared/entities";
import type { PreambleEvent } from "@shared/preamble";
import type { Settings, SettingsOpResult, SettingsPatch, SettingsSectionKey } from "@shared/settings";
import type { UsageState } from "@shared/usage";
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

// Multi-source native fan-out can take well over 45s when vendor web
// endpoints are slow. getUsage stays on the default ceiling — it only reads
// in-memory state.
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
      reject(new Error(`junto: backend did not respond (${channel}). Try restarting the app.`));
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
  probeCodex: () => invoke(IPC_CHANNELS.probeCodex, IPC_TIMEOUT_MS),
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

const liveApi: import("@shared/overseer-live").OverseerLiveApi = {
  liveStart: (input) => invoke(IPC_CHANNELS.liveStart, IPC_TIMEOUT_MS, input),
  liveEnd: (id) => invoke(IPC_CHANNELS.liveEnd, IPC_TIMEOUT_MS, id),
  liveSnapshot: () => invoke(IPC_CHANNELS.liveSnapshot, IPC_TIMEOUT_MS),
  liveReady: (id, epoch) => invoke(IPC_CHANNELS.liveReady, IPC_TIMEOUT_MS, id, epoch),
  liveProviderEvent: (id, epoch, event) => invoke(IPC_CHANNELS.liveProviderEvent, IPC_TIMEOUT_MS, id, epoch, event),
  liveAttention: (id, attention) => invoke(IPC_CHANNELS.liveAttention, IPC_TIMEOUT_MS, id, attention),
  liveCancel: (id, request) => invoke(IPC_CHANNELS.liveCancel, IPC_TIMEOUT_MS, id, request),
  liveSteer: (id, request, text, attention) => invoke(IPC_CHANNELS.liveSteer, IPC_TIMEOUT_MS, id, request, text, attention),
  liveStopActions: (id) => invoke(IPC_CHANNELS.liveStopActions, IPC_TIMEOUT_MS, id),
  onLiveChanged: (callback) => subscribe(IPC_CHANNELS.liveChanged, callback),
};

/**
 * Work-plane API keys behind a product gate. They leave the exposed object
 * with their feature (same pattern as `browserApi`); `vellumApi` excludes
 * them so the enabled groups are spread at the exposure site.
 */
type WorkFeatureApiKey =
  | "workTaskCreate"
  | "workTaskDescribe"
  | "workTaskTransition"
  | "workTaskPromote"
  | "workTaskComment"
  | "workTaskRespond"
  | "workTaskClaim"
  | "workRequestResolve"
  | "workArtifactArchive"
  | "workArtifactDelete"
  | "workBoardList"
  | "workBoardCreateTopic"
  | "workBoardPost"
  | "workBoardMarkRead"
  | "workBoardNotify"
  | "workPadRead"
  | "workPadPatch";

const vellumApi: Omit<VellumCommandApi, keyof typeof liveApi | WorkFeatureApiKey> = {
  platform: process.platform,
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
    invoke(IPC_CHANNELS.writeCanvas, IPC_TIMEOUT_MS, name, doc, expectedRevision),
  canvasOverseerSet: (input) =>
    invoke(IPC_CHANNELS.canvasOverseerSet, IPC_TIMEOUT_MS, input),
  createCanvas: (name) => invoke(IPC_CHANNELS.createCanvas, IPC_TIMEOUT_MS, name),
  deleteCanvas: (name) => invoke(IPC_CHANNELS.deleteCanvas, IPC_TIMEOUT_MS, name),
  exportDigest: (name) => invoke(IPC_CHANNELS.exportDigest, IPC_TIMEOUT_MS, name),
  getSnapshots: () => invoke(IPC_CHANNELS.getSnapshots, IPC_TIMEOUT_MS),
  getKernelState: () => invoke<KernelSnapshot>(IPC_CHANNELS.getKernelState, IPC_TIMEOUT_MS),
  factoryPauseState: (canvas) =>
    invoke(IPC_CHANNELS.factoryPauseState, IPC_TIMEOUT_MS, canvas),
  factoryPauseSet: (canvas, scope, paused) =>
    invoke(IPC_CHANNELS.factoryPauseSet, IPC_TIMEOUT_MS, canvas, scope, paused),
  regionRollups: (name) =>
    invoke(IPC_CHANNELS.regionRollups, IPC_TIMEOUT_MS, name),
  contentPutImage: (input) =>
    invoke(IPC_CHANNELS.contentPutImage, IPC_TIMEOUT_MS, input),
  workSeatRecentOps: (canvas, nodeId, limit) =>
    invoke(
      IPC_CHANNELS.workSeatRecentOps,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      limit,
    ),
  onNodeRefOpened,
  onCanvasFlushRequested,
  onCanvasQuiesceAndFlushRequested,
  onCanvasChanged: (listener) => subscribe<string>(IPC_CHANNELS.canvasChanged, listener),
  onPreamble: (listener) => subscribe<PreambleEvent>(IPC_CHANNELS.preamble, listener),
  onSnapshotsChanged: (listener) =>
    subscribe<SnapshotState>(IPC_CHANNELS.snapshotsChanged, listener),
  onKernelChanged: (listener) => subscribe<KernelSnapshot>(IPC_CHANNELS.kernelChanged, listener),
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

const taskWorkApi: Pick<
  VellumCommandApi,
  | "workTaskCreate"
  | "workTaskDescribe"
  | "workTaskTransition"
  | "workTaskPromote"
  | "workTaskComment"
  | "workTaskRespond"
  | "workTaskClaim"
> = {
  workTaskCreate: (canvas, nodeId, brief, metadata, reason, media, dependsOn, finishCriteria, rules, options) =>
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
      rules,
      options,
    ),
  workTaskDescribe: (canvas, nodeId, taskId, brief) =>
    invoke(IPC_CHANNELS.workTaskDescribe, IPC_TIMEOUT_MS, canvas, nodeId, taskId, brief),
  workTaskTransition: (
    canvas,
    nodeId,
    taskId,
    state,
    note,
    completionEvidence,
    path,
  ) =>
    invoke(
      IPC_CHANNELS.workTaskTransition,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      taskId,
      state,
      note,
      completionEvidence,
      path,
    ),
  workTaskPromote: (canvas, nodeId, taskId, note) =>
    invoke(IPC_CHANNELS.workTaskPromote, IPC_TIMEOUT_MS, canvas, nodeId, taskId, note),
  workTaskComment: (canvas, nodeId, taskId, text) =>
    invoke(
      IPC_CHANNELS.workTaskComment,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      taskId,
      text,
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
};

const requestsWorkApi: Pick<VellumCommandApi, "workRequestResolve"> = {
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
};

const artifactsWorkApi: Pick<
  VellumCommandApi,
  "workArtifactArchive" | "workArtifactDelete"
> = {
  workArtifactArchive: (canvas, nodeId, artifactId, archived) =>
    invoke(
      IPC_CHANNELS.workArtifactArchive,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      artifactId,
      archived,
    ),
  workArtifactDelete: (canvas, nodeId, artifactId) =>
    invoke(
      IPC_CHANNELS.workArtifactDelete,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      artifactId,
    ),
};

const boardWorkApi: Pick<
  VellumCommandApi,
  | "workBoardList"
  | "workBoardCreateTopic"
  | "workBoardPost"
  | "workBoardMarkRead"
  | "workBoardNotify"
> = {
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
  workBoardMarkRead: (canvas, nodeId, topicId, upToPosition?: number) =>
    invoke(
      IPC_CHANNELS.workBoardMarkRead,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
      upToPosition,
    ),
  workBoardNotify: (canvas, nodeId, topicId) =>
    invoke(
      IPC_CHANNELS.workBoardNotify,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      topicId,
    ),
};

const padWorkApi: Pick<VellumCommandApi, "workPadRead" | "workPadPatch"> = {
  workPadRead: (canvas, nodeId, pinId) =>
    invoke(
      IPC_CHANNELS.workPadRead,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      pinId,
    ),
  workPadPatch: (canvas, nodeId, patches) =>
    invoke(
      IPC_CHANNELS.workPadPatch,
      IPC_TIMEOUT_MS,
      canvas,
      nodeId,
      patches,
    ),
};

const hermesIntegrationApi: VellumCommandHermesIntegrationApi = {
  generatePortfolio: (name, options) =>
    invoke(IPC_CHANNELS.generatePortfolio, IPC_TIMEOUT_MS, name, options),
  refreshSnapshots: (hints) =>
    invoke(IPC_CHANNELS.refreshSnapshots, IPC_TIMEOUT_MS, hints),
  agentMessage: (key, text) =>
    invoke(IPC_CHANNELS.agentMessage, AGENT_MESSAGE_TIMEOUT_MS, key, text),
};

const schedulerApi: VellumCommandSchedulerApi = {
  schedulerFire: (canvas, sourceNodeId) =>
    invoke(IPC_CHANNELS.schedulerFire, IPC_TIMEOUT_MS, canvas, sourceNodeId),
};

const usageApi: VellumCommandUsageApi = {
  getUsage: () => invoke(IPC_CHANNELS.getUsage, IPC_TIMEOUT_MS),
  refreshUsage: () => invoke(IPC_CHANNELS.refreshUsage, USAGE_REFRESH_TIMEOUT_MS),
  onUsageChanged: (listener) =>
    subscribe<UsageState>(IPC_CHANNELS.usageChanged, listener),
};

const chatApi: VellumCommandChatApi = {
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

const browserApi: VellumCommandBrowserApi = {
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

const terminalApi: VellumCommandTerminalApi = {
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
  terminalBeginNodeDelete: (resources) =>
    invoke(
      IPC_CHANNELS.terminalBeginNodeDelete,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      resources,
    ),
  terminalFinishNodeDelete: (leaseId, outcome) =>
    invoke(
      IPC_CHANNELS.terminalFinishNodeDelete,
      IPC_TIMEOUT_MS,
      leaseId,
      outcome,
    ),
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
  terminalManagedPrompt: (input) =>
    invoke(IPC_CHANNELS.terminalManagedPrompt, AGENT_MESSAGE_TIMEOUT_MS, input),
  terminalResize: (leaseId, cols, rows) => invoke(IPC_CHANNELS.terminalResize, IPC_TIMEOUT_MS, leaseId, cols, rows),
  onTerminalEvent: (listener) => subscribe(IPC_CHANNELS.terminalEvent, listener),
  managedTerminalModels: (harness) =>
    invoke(IPC_CHANNELS.managedTerminalModels, IPC_TIMEOUT_MS, harness),
  managedTerminalProfiles: () =>
    invoke(IPC_CHANNELS.managedTerminalProfiles, IPC_TIMEOUT_MS),
  managedTerminalHarnesses: () =>
    invoke(IPC_CHANNELS.managedTerminalHarnesses, IPC_TIMEOUT_MS),
  agentSeatStateSnapshot: () =>
    invoke(IPC_CHANNELS.agentSeatStateSnapshot, IPC_TIMEOUT_MS),
  onAgentSeatStateChanged: (listener) =>
    subscribe(IPC_CHANNELS.agentSeatStateChanged, listener),
};

const gitApi: VellumCommandGitApi = {
  gitStatus: (cwd) => invoke(IPC_CHANNELS.gitStatus, IPC_TIMEOUT_MS, cwd),
  gitLog: (cwd, limit) => invoke(IPC_CHANNELS.gitLog, IPC_TIMEOUT_MS, cwd, limit),
  gitShow: (cwd, sha) => invoke(IPC_CHANNELS.gitShow, IPC_TIMEOUT_MS, cwd, sha),
};

const demoApi: VellumCommandDemoApi = {
  demoState: () => invoke(IPC_CHANNELS.demoState, IPC_TIMEOUT_MS),
  demoWriteEdl: (edl) => invoke(IPC_CHANNELS.demoWriteEdl, IPC_TIMEOUT_MS, edl),
};

const hostsApi: VellumCommandHostsApi = {
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
  contextBridge.exposeInMainWorld("vellumCommand", {
    ...vellumApi,
    ...(TASKS_ENABLED ? taskWorkApi : {}),
    ...(REQUESTS_ENABLED ? requestsWorkApi : {}),
    ...(ARTIFACTS_ENABLED ? artifactsWorkApi : {}),
    ...(BOARD_ENABLED ? boardWorkApi : {}),
    ...(PAD_ENABLED ? padWorkApi : {}),
    ...(LIVE_OVERSEER_ENABLED ? liveApi : {}),
    ...chatApi,
    ...(USAGE_ENABLED ? usageApi : {}),
    ...(CRON_ENABLED || RELAY_ENABLED ? schedulerApi : {}),
    ...(HERMES_INTEGRATION_ENABLED ? hermesIntegrationApi : {}),
    ...(FLEET_UI_ENABLED ? hostsApi : {}),
    ...terminalApi,
    ...gitApi,
    ...(BROWSER_ENABLED ? browserApi : {}),
    ...demoApi,
  });
}
