import { RESOURCE_IPC_CHANNELS } from "@shared/resource-ipc-channels";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import type { MentionIpcApi, MentionsChanged } from "@shared/mention-ipc";
import { PAGE_BOX_DRAW_MS } from "@shared/page-shot";
import type { ResourceChanged, ResourceIpcApi, ThreadChanged } from "@shared/resource-ipc";
import type { WorkSinkChanged } from "@shared/work-sinks";
import type { WorkMailChanged } from "@shared/work-mail";
import type { CanvasesChanged, Changed } from "@shared/model";
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { FilesChanged, JuntoFilesApi } from "@shared/files";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import type { ShellEnvironmentChange } from "@shared/shell-environment";
import {
  IPC_CHANNELS,
  type ChassisApi,
  type BrowserOpenInput,
  type BrowserProfileWipeInput,
  type BrowserSessionInfo,
  type BrowserSurfaceBounds,
  type CanvasFlushRequest,
  type CanvasQuiesceAndFlushOutcome,
  type CanvasQuiesceAndFlushRequest,
  type LoginItemOpResult,
  type JuntoApi,
  type JuntoBrowserApi,
  type JuntoDemoApi,
  type JuntoGitApi,
  type JuntoHostsApi,
  type JuntoTerminalApi,
  type JuntoUsageApi,
  type KernelSnapshot,
  type ModelActorRefsChanged,
  type NodeRefOpenedDelivery,
  type NodeRefOpenedEvent,
  type ObservabilityLogEntry,
  type ObservabilityQuery,
  type ObservabilitySnapshot,
} from "@shared/ipc";
import type { AutomationsChanged } from "@shared/automation";
import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  LIVE_OVERSEER_ENABLED,
  TASKS_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import type { PreambleEvent } from "@shared/preamble";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import type { MailWaitingFact } from "@shared/mail-waiting";
import type { AgentSignal } from "@shared/agent-signals";
import type { PortraitOverrideEvent } from "@shared/portrait-overrides";
import type { Settings, SettingsOpResult, SettingsPatch, SettingsSectionKey } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { SquadsChanged } from "@shared/squads";
import type { MachineCommandProgress } from "@shared/machine-progress";
import type { SeatGuidanceEvent } from "@shared/seat-guidance";
import type { ReferencesChangedEvent } from "@shared/references";
import type { SeatOffboardProgress } from "@shared/seat-sessions";
import type { SeatCacheDue } from "@shared/seat-cache-due";
import type { SeatOnboardingEvent } from "@shared/seat-onboarding-status";
import type { ProfilesChanged } from "@shared/agent-profiles";
import type { NotifyCue, NotifyTarget } from "@shared/desktop-notifications";
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
const IPC_TIMEOUT_MS = 45_000;
/**
 * A machine send copies a whole build over SSH and starts it. Main owns that
 * command's deadline and its plain reason; this only catches a main that
 * never answers, so it sits past the longest wait an owner command may ask for.
 */
const MACHINE_COMMAND_TIMEOUT_MS = 16 * 60_000;
/** Box-backed host interaction may include provider resume + SSH verification. */
const HOST_ACTIVATION_IPC_TIMEOUT_MS = 360_000;

// Multi-source native fan-out can take well over 45s when vendor web
// endpoints are slow. getUsage stays on the default ceiling — it only reads
// in-memory state.
const USAGE_REFRESH_TIMEOUT_MS = 120_000;

// A seat ask (onboard, offboard, region env report, managed prompt) waits on
// a real agent turn; give it headroom above the default 45s ceiling.
const AGENT_MESSAGE_TIMEOUT_MS = 200_000;

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
 * with their feature (same pattern as `browserApi`); `juntoApi` excludes
 * them so the enabled groups are spread at the exposure site.
 */
type WorkFeatureApiKey = "resource";

const mentionsApi: MentionIpcApi = {
  list: (canvasName, target, page) =>
    invoke(MENTION_IPC_CHANNELS.list, IPC_TIMEOUT_MS, { canvasName, target, ...(page === undefined ? {} : { page }) }),
  onChanged: (listener) => subscribe<MentionsChanged>(MENTION_IPC_CHANNELS.changed, listener),
};

const juntoApi: Omit<JuntoApi, keyof typeof liveApi | WorkFeatureApiKey> = {
  platform: process.platform,
  mentions: mentionsApi,
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
  closeWindow: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
  yieldMenuKeys: (yielding) => ipcRenderer.send(IPC_CHANNELS.menuYield, yielding),
  canvasDigest: (name) => invoke(IPC_CHANNELS.canvasDigest, IPC_TIMEOUT_MS, name),
  modelOpen: (input) => invoke(IPC_CHANNELS.modelOpen, IPC_TIMEOUT_MS, input),
  modelCanvases: () => invoke(IPC_CHANNELS.modelCanvases, IPC_TIMEOUT_MS),
  modelCommand: (command) => invoke(IPC_CHANNELS.modelCommand, IPC_TIMEOUT_MS, command),
  onModelChanged: (listener) => subscribe<Changed>(IPC_CHANNELS.modelChanged, listener),
  onModelCanvasesChanged: (listener) =>
    subscribe<CanvasesChanged>(IPC_CHANNELS.modelCanvasesChanged, listener),
  modelActorRefs: (input) => invoke(IPC_CHANNELS.modelActorRefs, IPC_TIMEOUT_MS, input),
  onModelActorRefsChanged: (listener) =>
    subscribe<ModelActorRefsChanged>(IPC_CHANNELS.modelActorRefsChanged, listener),
  modelStart: (input) => invoke(IPC_CHANNELS.modelStart, IPC_TIMEOUT_MS, input),
  modelSeatLaunchState: (input) => invoke(IPC_CHANNELS.modelSeatLaunchState, IPC_TIMEOUT_MS, input),
  modelStop: (input) => invoke(IPC_CHANNELS.modelStop, IPC_TIMEOUT_MS, input),
  getKernelState: () => invoke<KernelSnapshot>(IPC_CHANNELS.getKernelState, IPC_TIMEOUT_MS),
  factoryPauseState: (canvas) =>
    invoke(IPC_CHANNELS.factoryPauseState, IPC_TIMEOUT_MS, canvas),
  agentSignalsList: (canvas) =>
    invoke(IPC_CHANNELS.agentSignalsList, IPC_TIMEOUT_MS, canvas),
  mailWaiting: () => invoke(IPC_CHANNELS.mailWaitingRead, IPC_TIMEOUT_MS),
  agentSignalRespond: (signalId, text, options) =>
    invoke(IPC_CHANNELS.agentSignalRespond, IPC_TIMEOUT_MS, signalId, text, options),
  agentSignalDismiss: (signalId) =>
    invoke(IPC_CHANNELS.agentSignalDismiss, IPC_TIMEOUT_MS, signalId),
  previewRead: (request) => invoke(IPC_CHANNELS.previewRead, IPC_TIMEOUT_MS, request),
  pageShotPurge: (request) => invoke(IPC_CHANNELS.pageShotPurge, IPC_TIMEOUT_MS, request),
  previewReveal: (source, path) =>
    invoke(IPC_CHANNELS.previewReveal, IPC_TIMEOUT_MS, source, path),
  previewPlay: (source, index) => invoke(IPC_CHANNELS.previewPlay, IPC_TIMEOUT_MS, source, index),
  portraitOverridesList: () => invoke(IPC_CHANNELS.portraitOverridesList, IPC_TIMEOUT_MS),
  portraitOverrideSet: (seatId, override) =>
    invoke(IPC_CHANNELS.portraitOverrideSet, IPC_TIMEOUT_MS, seatId, override),
  squadsList: () => invoke(IPC_CHANNELS.squadsList, IPC_TIMEOUT_MS),
  squadSave: (input) => invoke(IPC_CHANNELS.squadSave, IPC_TIMEOUT_MS, input),
  squadRename: (squadId, name) => invoke(IPC_CHANNELS.squadRename, IPC_TIMEOUT_MS, squadId, name),
  squadDelete: (squadId) => invoke(IPC_CHANNELS.squadDelete, IPC_TIMEOUT_MS, squadId),
  seatGuidanceList: () => invoke(IPC_CHANNELS.seatGuidanceList, IPC_TIMEOUT_MS),
  seatGuidanceSet: (seatId, guidance) =>
    invoke(IPC_CHANNELS.seatGuidanceSet, IPC_TIMEOUT_MS, seatId, guidance),
  appBriefingRead: () => invoke(IPC_CHANNELS.appBriefingRead, IPC_TIMEOUT_MS),
  appBriefingWrite: (body) => invoke(IPC_CHANNELS.appBriefingWrite, IPC_TIMEOUT_MS, body),
  referencesList: (place) => invoke(IPC_CHANNELS.referencesList, IPC_TIMEOUT_MS, place),
  referencesRead: (input) => invoke(IPC_CHANNELS.referencesRead, IPC_TIMEOUT_MS, input),
  referencesWrite: (input) => invoke(IPC_CHANNELS.referencesWrite, IPC_TIMEOUT_MS, input),
  referencesDelete: (input) => invoke(IPC_CHANNELS.referencesDelete, IPC_TIMEOUT_MS, input),
  regionEnvSaveSecret: (input) =>
    invoke(IPC_CHANNELS.regionEnvSaveSecret, IPC_TIMEOUT_MS, input),
  regionEnvRemoveSecret: (secretId) =>
    invoke(IPC_CHANNELS.regionEnvRemoveSecret, IPC_TIMEOUT_MS, secretId),
  // Resolving reads the operator's stores (Keychain, 1Password), each bounded
  // by its own timeout; give the whole report the long budget.
  regionEnvReport: (canvasName, regionId) =>
    invoke(IPC_CHANNELS.regionEnvReport, AGENT_MESSAGE_TIMEOUT_MS, canvasName, regionId),
  regionEnvStaleSeats: (canvasName, regionId) =>
    invoke(IPC_CHANNELS.regionEnvStaleSeats, IPC_TIMEOUT_MS, canvasName, regionId),
  seatOffboardAsk: (canvasName, seatId, mode) =>
    invoke(IPC_CHANNELS.seatOffboardAsk, AGENT_MESSAGE_TIMEOUT_MS, canvasName, seatId, mode),
  seatOffboardRun: (input) =>
    invoke(IPC_CHANNELS.seatOffboardRun, AGENT_MESSAGE_TIMEOUT_MS, input),
  seatOffboardStatus: (canvasName, seatIds) =>
    invoke(IPC_CHANNELS.seatOffboardStatus, IPC_TIMEOUT_MS, canvasName, seatIds),
  seatOffboardProgressList: () => invoke(IPC_CHANNELS.seatOffboardProgressList, IPC_TIMEOUT_MS),
  seatCacheDueList: () => invoke(IPC_CHANNELS.seatCacheDueList, IPC_TIMEOUT_MS),
  seatCacheDueAnswer: (input) => invoke(IPC_CHANNELS.seatCacheDueAnswer, IPC_TIMEOUT_MS, input),
  seatOnboardingSnapshot: () => invoke(IPC_CHANNELS.seatOnboardingSnapshot, IPC_TIMEOUT_MS),
  seatOnboardNudge: (canvasName, seatId) =>
    invoke(IPC_CHANNELS.seatOnboardNudge, AGENT_MESSAGE_TIMEOUT_MS, canvasName, seatId),
  profilesList: () => invoke(IPC_CHANNELS.profilesList, IPC_TIMEOUT_MS),
  profileSave: (input) => invoke(IPC_CHANNELS.profileSave, IPC_TIMEOUT_MS, input),
  profileRename: (profileId, name) => invoke(IPC_CHANNELS.profileRename, IPC_TIMEOUT_MS, profileId, name),
  profileDelete: (profileId) => invoke(IPC_CHANNELS.profileDelete, IPC_TIMEOUT_MS, profileId),
  factoryPauseSet: (canvas, paused) =>
    invoke(IPC_CHANNELS.factoryPauseSet, IPC_TIMEOUT_MS, canvas, paused),
  contentPutImage: (input) =>
    invoke(IPC_CHANNELS.contentPutImage, IPC_TIMEOUT_MS, input),
  workItem: (query) => invoke(IPC_CHANNELS.workItem, IPC_TIMEOUT_MS, query),
  workAttention: (query) => invoke(IPC_CHANNELS.workAttention, IPC_TIMEOUT_MS, query),
  workSinkPage: (query) => invoke(IPC_CHANNELS.workSinkPage, IPC_TIMEOUT_MS, query),
  onWorkSinkChanged: (listener) => subscribe<WorkSinkChanged>(IPC_CHANNELS.workSinkChanged, listener),
  automationList: (canvas, request) => invoke(IPC_CHANNELS.automationList, IPC_TIMEOUT_MS, canvas, request),
  automationFirings: (canvas, request) => invoke(IPC_CHANNELS.automationFirings, IPC_TIMEOUT_MS, canvas, request),
  automationApply: (canvas, request) => invoke(IPC_CHANNELS.automationApply, IPC_TIMEOUT_MS, canvas, request),
  onAutomationsChanged: (listener) => subscribe<AutomationsChanged>(IPC_CHANNELS.automationsChanged, listener),
  workMailPage: (query) => invoke(IPC_CHANNELS.workMailPage, IPC_TIMEOUT_MS, query),
  onWorkMailChanged: (listener) => subscribe<WorkMailChanged>(IPC_CHANNELS.workMailChanged, listener),
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
  onPreamble: (listener) => subscribe<PreambleEvent>(IPC_CHANNELS.preamble, listener),
  onWireTraffic: (listener) =>
    subscribe<WireTrafficEvent>(IPC_CHANNELS.wireTraffic, listener),
  onMailWaiting: (listener) => subscribe<MailWaitingFact>(IPC_CHANNELS.mailWaiting, listener),
  onAgentSignal: (listener) => subscribe<AgentSignal>(IPC_CHANNELS.agentSignal, listener),
  onPortraitOverride: (listener) =>
    subscribe<PortraitOverrideEvent>(IPC_CHANNELS.portraitOverride, listener),
  onSquadsChanged: (listener) => subscribe<SquadsChanged>(IPC_CHANNELS.squadsChanged, listener),
  onSeatGuidance: (listener) => subscribe<SeatGuidanceEvent>(IPC_CHANNELS.seatGuidance, listener),
  onReferencesChanged: (listener) => subscribe<ReferencesChangedEvent>(IPC_CHANNELS.referencesChanged, listener),
  onSeatOffboardProgress: (listener) =>
    subscribe<SeatOffboardProgress>(IPC_CHANNELS.seatOffboardProgress, listener),
  onSeatCacheDue: (listener) => subscribe<ReadonlyArray<SeatCacheDue>>(IPC_CHANNELS.seatCacheDue, listener),
  onSeatOnboardingChanged: (listener) =>
    subscribe<SeatOnboardingEvent>(IPC_CHANNELS.seatOnboardingChanged, listener),
  onProfilesChanged: (listener) => subscribe<ProfilesChanged>(IPC_CHANNELS.profilesChanged, listener),
  notificationsReport: (report) => invoke(IPC_CHANNELS.notificationsReport, IPC_TIMEOUT_MS, report),
  notificationsTest: () => invoke(IPC_CHANNELS.notificationsTest, IPC_TIMEOUT_MS),
  notificationsDelivery: () => invoke(IPC_CHANNELS.notificationsDelivery, IPC_TIMEOUT_MS),
  notificationsOpenSystemSettings: () =>
    invoke(IPC_CHANNELS.notificationsOpenSystemSettings, IPC_TIMEOUT_MS),
  onNotificationActivate: (listener) =>
    subscribe<NotifyTarget>(IPC_CHANNELS.notificationActivate, listener),
  onNotificationCue: (listener) =>
    subscribe<{ readonly cue: NotifyCue }>(IPC_CHANNELS.notificationCue, listener),
  shellEnvironment: {
    status: () => invoke(IPC_CHANNELS.shellEnvironmentStatus, IPC_TIMEOUT_MS),
    refresh: () => invoke(IPC_CHANNELS.shellEnvironmentRefresh, IPC_TIMEOUT_MS),
    onChange: (listener) => subscribe<ShellEnvironmentChange>(IPC_CHANNELS.shellEnvironmentChanged, listener),
  },
  companionStatus: () => invoke(IPC_CHANNELS.companionStatus, IPC_TIMEOUT_MS),
  companionPairStart: () => invoke(IPC_CHANNELS.companionPairStart, IPC_TIMEOUT_MS),
  companionPairCancel: (deviceId) => invoke(IPC_CHANNELS.companionPairCancel, IPC_TIMEOUT_MS, deviceId),
  companionPairCopyLink: (deviceId) => invoke(IPC_CHANNELS.companionPairCopyLink, IPC_TIMEOUT_MS, deviceId),
  companionDevices: () => invoke(IPC_CHANNELS.companionDevices, IPC_TIMEOUT_MS),
  companionDeviceRemove: (deviceId) => invoke(IPC_CHANNELS.companionDeviceRemove, IPC_TIMEOUT_MS, deviceId),
  companionDeviceRestore: (target) => invoke(IPC_CHANNELS.companionDeviceRestore, IPC_TIMEOUT_MS, target),
  onCompanionDevicesChanged: (listener) =>
    subscribe<ReadonlyArray<CompanionDeviceRecord>>(IPC_CHANNELS.companionDevicesChanged, listener),
  companionRemoteLogin: () => invoke(IPC_CHANNELS.companionRemoteLogin, IPC_TIMEOUT_MS),
  companionOpenRemoteLoginSettings: () => invoke(IPC_CHANNELS.companionOpenRemoteLoginSettings, IPC_TIMEOUT_MS),
  onKernelChanged: (listener) => subscribe<KernelSnapshot>(IPC_CHANNELS.kernelChanged, listener),
  settingsGet: () => invoke<SettingsOpResult>(IPC_CHANNELS.settingsGet, IPC_TIMEOUT_MS),
  settingsPatch: (patch: SettingsPatch) =>
    invoke<SettingsOpResult>(IPC_CHANNELS.settingsPatch, IPC_TIMEOUT_MS, patch),
  settingsSetMachinePreferences: (machine) =>
    invoke<SettingsOpResult>(
      IPC_CHANNELS.settingsSetMachinePreferences,
      IPC_TIMEOUT_MS,
      machine,
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

const taskResourceApi: ResourceIpcApi["task"] = {
  list: (canvasName, nodeId) => invoke(RESOURCE_IPC_CHANNELS.task.list, IPC_TIMEOUT_MS, { canvasName, nodeId }),
  all: (canvasName) => invoke(RESOURCE_IPC_CHANNELS.task.all, IPC_TIMEOUT_MS, { canvasName }),
  context: (canvasName) => invoke(RESOURCE_IPC_CHANNELS.task.context, IPC_TIMEOUT_MS, { canvasName }),
  apply: (canvasName, nodeId, taskId, opId, command) =>
    invoke(RESOURCE_IPC_CHANNELS.task.apply, IPC_TIMEOUT_MS, { canvasName, nodeId, taskId, opId, command }),
  pending: (canvasName, nodeId) => invoke(RESOURCE_IPC_CHANNELS.task.pending, IPC_TIMEOUT_MS, { canvasName, nodeId }),
  onChanged: (listener) => subscribe<ResourceChanged>(RESOURCE_IPC_CHANNELS.task.changed, listener),
};

const artifactResourceApi: ResourceIpcApi["artifact"] = {
  list: (canvasName, nodeId) => invoke(RESOURCE_IPC_CHANNELS.artifact.list, IPC_TIMEOUT_MS, { canvasName, nodeId }),
  history: (canvasName, artifactId) =>
    invoke(RESOURCE_IPC_CHANNELS.artifact.history, IPC_TIMEOUT_MS, { canvasName, artifactId }),
  body: (canvasName, artifactId, version) =>
    invoke(RESOURCE_IPC_CHANNELS.artifact.body, IPC_TIMEOUT_MS, { canvasName, artifactId, version }),
  apply: (canvasName, nodeId, artifactId, opId, op) =>
    invoke(RESOURCE_IPC_CHANNELS.artifact.apply, IPC_TIMEOUT_MS, { canvasName, nodeId, artifactId, opId, op }),
  pending: (canvasName, nodeId) => invoke(RESOURCE_IPC_CHANNELS.artifact.pending, IPC_TIMEOUT_MS, { canvasName, nodeId }),
  onChanged: (listener) => subscribe<ResourceChanged>(RESOURCE_IPC_CHANNELS.artifact.changed, listener),
};

const threadResourceApi: ResourceIpcApi["thread"] = {
  list: (canvasName, subject) => invoke(RESOURCE_IPC_CHANNELS.thread.list, IPC_TIMEOUT_MS, { canvasName, subject }),
  post: (canvasName, subject, post) => invoke(RESOURCE_IPC_CHANNELS.thread.post, IPC_TIMEOUT_MS, { canvasName, subject, post }),
  onChanged: (listener) => subscribe<ThreadChanged>(RESOURCE_IPC_CHANNELS.thread.changed, listener),
};


const usageApi: JuntoUsageApi = {
  getUsage: () => invoke(IPC_CHANNELS.getUsage, IPC_TIMEOUT_MS),
  refreshUsage: () => invoke(IPC_CHANNELS.refreshUsage, USAGE_REFRESH_TIMEOUT_MS),
  onUsageChanged: (listener) =>
    subscribe<UsageState>(IPC_CHANNELS.usageChanged, listener),
};

const browserApi: JuntoBrowserApi = {
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
  browserPageState: (sessionId) => invoke(IPC_CHANNELS.browserPageState, IPC_TIMEOUT_MS, sessionId),
  browserTakeOver: (sessionId) => invoke(IPC_CHANNELS.browserTakeOver, IPC_TIMEOUT_MS, sessionId),
  // Drawing waits on the operator's drag; main ends it at PAGE_BOX_DRAW_MS.
  browserBoxStart: (sessionId) => invoke(IPC_CHANNELS.browserBoxStart, PAGE_BOX_DRAW_MS + IPC_TIMEOUT_MS, sessionId),
  browserBoxPost: (sessionId, shotId, text) =>
    invoke(IPC_CHANNELS.browserBoxPost, IPC_TIMEOUT_MS, sessionId, shotId, text),
  browserBoxDiscard: (sessionId, shotId) => invoke(IPC_CHANNELS.browserBoxDiscard, IPC_TIMEOUT_MS, sessionId, shotId),
  browserRelease: (sessionId) => invoke(IPC_CHANNELS.browserRelease, IPC_TIMEOUT_MS, sessionId),
  browserGoto: (sessionId, url, tab) =>
    tab === undefined
      ? invoke(IPC_CHANNELS.browserGoto, IPC_TIMEOUT_MS, sessionId, url)
      : invoke(IPC_CHANNELS.browserGoto, IPC_TIMEOUT_MS, sessionId, url, tab),
  browserTraverse: (sessionId, step) => invoke(IPC_CHANNELS.browserTraverse, IPC_TIMEOUT_MS, sessionId, step),
  browserOpenTab: (sessionId, url) =>
    url === undefined
      ? invoke(IPC_CHANNELS.browserOpenTab, IPC_TIMEOUT_MS, sessionId)
      : invoke(IPC_CHANNELS.browserOpenTab, IPC_TIMEOUT_MS, sessionId, url),
  browserCloseTab: (sessionId, tab) => invoke(IPC_CHANNELS.browserCloseTab, IPC_TIMEOUT_MS, sessionId, tab),
  browserActivateTab: (sessionId, tab) => invoke(IPC_CHANNELS.browserActivateTab, IPC_TIMEOUT_MS, sessionId, tab),
  browserFocusPage: (sessionId) => invoke(IPC_CHANNELS.browserFocusPage, IPC_TIMEOUT_MS, sessionId),
  onBrowserPageChanged: (listener) => subscribe<string>(IPC_CHANNELS.browserPageChanged, listener),
};

const terminalApi: JuntoTerminalApi = {
  terminalList: (hostId) =>
    invoke(
      IPC_CHANNELS.terminalList,
      HOST_ACTIVATION_IPC_TIMEOUT_MS,
      hostId,
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
  onTerminalLeaseEnded: (listener) => subscribe(IPC_CHANNELS.terminalLeaseEnded, listener),
  managedTerminalModels: (harness) =>
    invoke(IPC_CHANNELS.managedTerminalModels, IPC_TIMEOUT_MS, harness),
  managedTerminalProfiles: () =>
    invoke(IPC_CHANNELS.managedTerminalProfiles, IPC_TIMEOUT_MS),
  managedTerminalHarnesses: () =>
    invoke(IPC_CHANNELS.managedTerminalHarnesses, IPC_TIMEOUT_MS),
  machineInventory: (machine) =>
    invoke(IPC_CHANNELS.machineInventory, IPC_TIMEOUT_MS, machine),
  nativeSettingsRead: (input) =>
    invoke(IPC_CHANNELS.nativeSettingsRead, IPC_TIMEOUT_MS, input),
  nativeSettingWrite: (write) =>
    invoke(IPC_CHANNELS.nativeSettingWrite, IPC_TIMEOUT_MS, write),
  machineProviders: (machine) => invoke(IPC_CHANNELS.machineProviders, IPC_TIMEOUT_MS, machine),
  machineProvidersWrite: (input) => invoke(IPC_CHANNELS.machineProvidersWrite, IPC_TIMEOUT_MS, input),
  machineRecord: (machine) => invoke(IPC_CHANNELS.machineRecord, IPC_TIMEOUT_MS, machine),
  machineRecordWrite: (input) => invoke(IPC_CHANNELS.machineRecordWrite, IPC_TIMEOUT_MS, input),
  machineCacheWindows: (machine) => invoke(IPC_CHANNELS.machineCacheWindows, IPC_TIMEOUT_MS, machine),
  machineCacheWindowsWrite: (input) => invoke(IPC_CHANNELS.machineCacheWindowsWrite, IPC_TIMEOUT_MS, input),
  managedTerminalFlags: (harness, cwd) =>
    invoke(IPC_CHANNELS.managedTerminalFlags, IPC_TIMEOUT_MS, harness, cwd),
  agentSeatStateSnapshot: () =>
    invoke(IPC_CHANNELS.agentSeatStateSnapshot, IPC_TIMEOUT_MS),
  agentSeatViewed: (bindingId) =>
    invoke(IPC_CHANNELS.agentSeatViewed, IPC_TIMEOUT_MS, bindingId),
  seatSurfacesOpen: (bindingIds) =>
    invoke(IPC_CHANNELS.seatSurfacesOpen, IPC_TIMEOUT_MS, bindingIds),
  seatOperatorTyped: (bindingId) =>
    invoke(IPC_CHANNELS.seatOperatorTyped, IPC_TIMEOUT_MS, bindingId),
  onAgentSeatStateChanged: (listener) =>
    subscribe(IPC_CHANNELS.agentSeatStateChanged, listener),
  seatAwarenessSnapshot: () =>
    invoke(IPC_CHANNELS.seatAwarenessSnapshot, IPC_TIMEOUT_MS),
  onSeatAwarenessChanged: (listener) =>
    subscribe(IPC_CHANNELS.seatAwarenessChanged, listener),
  seatCollaborationAsk: (input) =>
    invoke(IPC_CHANNELS.seatCollaborationAsk, IPC_TIMEOUT_MS, input),
  seatThreadsList: (query) => invoke(IPC_CHANNELS.seatThreadsList, IPC_TIMEOUT_MS, query),
  seatThreadMessages: (query) => invoke(IPC_CHANNELS.seatThreadMessages, IPC_TIMEOUT_MS, query),
  seatThreadSend: (input) => invoke(IPC_CHANNELS.seatThreadSend, IPC_TIMEOUT_MS, input),
  seatThreadMentionables: (query) => invoke(IPC_CHANNELS.seatThreadMentionables, IPC_TIMEOUT_MS, query),
  operatorContentPut: (input) => invoke(IPC_CHANNELS.operatorContentPut, IPC_TIMEOUT_MS, input),
};

const gitApi: JuntoGitApi = {
  gitStatus: (cwd) => invoke(IPC_CHANNELS.gitStatus, IPC_TIMEOUT_MS, cwd),
  gitLog: (cwd, limit) => invoke(IPC_CHANNELS.gitLog, IPC_TIMEOUT_MS, cwd, limit),
  gitShow: (cwd, sha) => invoke(IPC_CHANNELS.gitShow, IPC_TIMEOUT_MS, cwd, sha),
  gitSummary: (cwd) => invoke(IPC_CHANNELS.gitSummary, IPC_TIMEOUT_MS, cwd),
  gitReview: (cwd, view) => invoke(IPC_CHANNELS.gitReview, IPC_TIMEOUT_MS, cwd, view),
  gitCommit: (cwd, sha) => invoke(IPC_CHANNELS.gitCommit, IPC_TIMEOUT_MS, cwd, sha),
};

const filesApi: JuntoFilesApi = {
  files: {
    open: (ref) => invoke(IPC_CHANNELS.filesOpen, IPC_TIMEOUT_MS, ref),
    close: (ref) => invoke(IPC_CHANNELS.filesClose, IPC_TIMEOUT_MS, ref),
    count: (ref) => invoke(IPC_CHANNELS.filesCount, IPC_TIMEOUT_MS, ref),
    list: (ref, dir) => invoke(IPC_CHANNELS.filesList, IPC_TIMEOUT_MS, ref, dir),
    search: (ref, query, seq) => invoke(IPC_CHANNELS.filesSearch, IPC_TIMEOUT_MS, ref, query, seq),
    read: (ref, path) => invoke(IPC_CHANNELS.filesRead, IPC_TIMEOUT_MS, ref, path),
    write: (ref, path, text, base) => invoke(IPC_CHANNELS.filesWrite, IPC_TIMEOUT_MS, ref, path, text, base),
    create: (ref, path, dir) => invoke(IPC_CHANNELS.filesCreate, IPC_TIMEOUT_MS, ref, path, dir),
    rename: (ref, path, name) => invoke(IPC_CHANNELS.filesRename, IPC_TIMEOUT_MS, ref, path, name),
    move: (ref, path, intoDir) => invoke(IPC_CHANNELS.filesMove, IPC_TIMEOUT_MS, ref, path, intoDir),
    trash: (ref, path) => invoke(IPC_CHANNELS.filesTrash, IPC_TIMEOUT_MS, ref, path),
    // A dropped folder can be large; main owns the copy, this only catches a main that never answers.
    import: (ref, intoDir, sources) => invoke(IPC_CHANNELS.filesImport, AGENT_MESSAGE_TIMEOUT_MS, ref, intoDir, sources),
    openInDefaultApp: (ref, path) => invoke(IPC_CHANNELS.filesOpenInDefaultApp, IPC_TIMEOUT_MS, ref, path),
    revealInFinder: (ref, path) => invoke(IPC_CHANNELS.filesReveal, IPC_TIMEOUT_MS, ref, path),
    onChange: (listener) => subscribe<FilesChanged>(IPC_CHANNELS.filesChanged, listener),
    // Only a File the OS handed over (a drop, a picker) has a path; one the
    // page builds has none. Main copies in only the paths reported here.
    pathForDroppedFile: (file) => {
      let path = "";
      try {
        path = webUtils.getPathForFile(file);
      } catch {
        return "";
      }
      if (path !== "") ipcRenderer.send(IPC_CHANNELS.filesDropped, path);
      return path;
    },
  },
};

const demoApi: JuntoDemoApi = {
  demoState: () => invoke(IPC_CHANNELS.demoState, IPC_TIMEOUT_MS),
  demoWriteEdl: (edl) => invoke(IPC_CHANNELS.demoWriteEdl, IPC_TIMEOUT_MS, edl),
};

const hostsApi: JuntoHostsApi = {
  hostsList: () => invoke(IPC_CHANNELS.hostsList, IPC_TIMEOUT_MS),
  machineCommand: (request) => invoke(IPC_CHANNELS.machineCommand, MACHINE_COMMAND_TIMEOUT_MS, request),
  onMachineProgress: (listener) => subscribe<MachineCommandProgress>(IPC_CHANNELS.machineProgress, listener),
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
  contextBridge.exposeInMainWorld("junto", {
    ...juntoApi,
    ...(TASKS_ENABLED || ARTIFACTS_ENABLED
      ? {
          resource: {
            ...(TASKS_ENABLED ? { task: taskResourceApi } : {}),
            ...(ARTIFACTS_ENABLED ? { artifact: artifactResourceApi } : {}),
            thread: threadResourceApi,
          },
        }
      : {}),
    ...(LIVE_OVERSEER_ENABLED ? liveApi : {}),
    ...(USAGE_ENABLED ? usageApi : {}),
    ...(FLEET_UI_ENABLED ? hostsApi : {}),
    ...terminalApi,
    ...gitApi,
    ...filesApi,
    ...(BROWSER_ENABLED ? browserApi : {}),
    ...demoApi,
  });
}
