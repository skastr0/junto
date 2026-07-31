import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
} from "electron";
import { Context, Effect } from "effect";
import { classifyBrowserTarget } from "@shared/browser-policy";
import {
  IPC_CHANNELS,
  type CanvasFlushResult,
  type CanvasQuiesceAndFlushResult,
  type NodeRefOpenedDelivery,
} from "@shared/ipc";
import type { PreambleEvent } from "@shared/preamble";
import {
  resolvedSpawnEnv,
  terminateAdapterChildrenOnQuit,
} from "./vellum/adapters/exec";
import { appProcessPlane } from "./vellum/app-process-plane";
import { beginBoxProcessShutdown } from "./vellum/box";
import { AppRuntime } from "./runtime";
import { releaseDemoRuntimeIsolation } from "./vellum/demo/runtime-isolation";
import { registerBrowserIpcHandlers, registerIpcHandlers } from "./ipc";
import { CanvasesService } from "./vellum/canvases";
import { STATE_UPDATE_PREFLIGHT_SWITCH } from "./vellum/state/candidate-readiness";
import { resolveControlHome } from "./vellum/control-home";
import { registerDemoIpcHandlers } from "./vellum/demo/ipc";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  startBrowserComposition,
  type BrowserComposition,
} from "./vellum/browser/composition";
import { makeBrowserCompositionHost } from "./vellum/browser/composition-host";
import { makeElectronBrowserViewAttachmentTarget } from "./vellum/browser/view-adapter";
import { makeElectronBrowserReadinessProductPath } from "./vellum/browser/readiness-product-path";
import { makeBrowserProductPathProbe } from "./vellum/browser/readiness-probe";
import { installBrowserProductPathProbe } from "./vellum/station-readiness";
import { findHostById, hostsSnapshot } from "./vellum/hosts/snapshot";
import { hostHasCapability } from "@shared/remote-hosts";
import { HerdrPlane } from "./vellum/herdr/plane";
import { HermesPlane } from "./vellum/hermes/plane";
import { termPlane, termPlaneBlocksAppExit } from "./vellum/term/plane";
import { configureTerminalRouterLayeredRunner } from "./vellum/term/router";
import { ChatServiceContext } from "./vellum/chat/service";
import { resolveBrowserPageTarget } from "./vellum/browser/ipc";
import { developmentElectronSecurityPolicyPath, electronSecurityPolicyHealthy, packagedElectronObservationHighWaterPath, packagedElectronObservationPath, packagedElectronSecurityPolicyPath } from "./vellum/electron-security-health";
import { startBrowserControlServer, type BrowserControlServer } from "./vellum/browser/control";
import {
  startWorkControlServer,
  workControlReadiness,
  type WorkControlServer,
} from "./vellum/work/control";
import {
  startStationControlServer,
  stationControlReadiness,
  type StationControlServer,
} from "./vellum/station/control-server";
import {
  startStationRemoteReportPump,
  type StationRemoteReportPump,
} from "./vellum/station/remote-report-pump";
import { StationFleetPropagation } from "./vellum/station/fleet-propagation";
import { StationApiService } from "./vellum/station/api";
import { StationRepository } from "./vellum/station/repository";
import { WorkRepository } from "./vellum/work/repository";
import { makeOwnerLocalStationControlHandoffAuthority } from "./vellum/station/peer-authority";
import {
  startCanvasControlServer,
  type CanvasControlServer,
} from "./vellum/canvas-control";
import { KernelService } from "./vellum/kernel/service";
import { makeEdgeGrantService } from "./vellum/browser/edge-grant";
import { prepareDefaultBrowserStationAdmissionAuthority } from "./vellum/browser/station-admission";
import { configurePeerPidHelperRoots } from "./vellum/process-identity";
import { evaluateSchemaCompatibility } from "./vellum/state/schema-version-probe";
import { runStartupStateFailureDialog } from "./vellum/state/startup-state-failure-dialog";
import { ensureSchemaCompatibleOrRecover } from "./vellum/update/startup-schema-recovery";
import { isManagedBrowserWebContents } from "./vellum/browser/web-policy";
import {
  canonicalNodeRefUri,
  latestNodeRefUri,
  makeNodeRefIngress,
} from "./vellum/node-ref-ingress";
import type { NodeRefKey } from "@shared/node-ref";
import { resolveNodeRef } from "./vellum/node-ref-resolver";
import {
  createQuitPreparationArbiter,
  createSignalQuitState,
  installProcessSignalTermination,
  runNormalQuitPreparation,
} from "./vellum/process-signal-termination";
import {
  isTrustedMainWebContents,
  setTrustedMainWebContents,
} from "./vellum/trusted-main-webcontents";
import { createTrustedRendererNavigation } from "./vellum/trusted-renderer-navigation";
import { createRendererSurfaceReadiness } from "./vellum/renderer-surface-readiness";
import {
  createRendererSurfaceRecovery,
  resolveRendererSurfaceTimeoutMs,
} from "./vellum/renderer-surface-recovery";
import {
  assessLiveWork,
  buildQuitConfirmPrompt,
  hasLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
} from "./vellum/quit-live-work";
import { mainAuthoringGate } from "./vellum/main-authoring-gate";
import { remoteLeaseState } from "./vellum/license/remote-lease-state";
import {
  installTrustedRendererPermissionPolicy,
  installTrustedRendererProtocol,
  registerTrustedRendererScheme,
} from "./vellum/trusted-renderer-protocol";
import {
  CONTENT_PROTOCOL_SCHEME_REGISTRATION,
  installContentProtocol,
} from "./vellum/content/protocol";
import { ContentService } from "./vellum/content/service";
import {
  resolveTrustedRendererOrigin,
  type TrustedRendererOrigin,
} from "@shared/trusted-renderer-origin";
import { loadStationSupervisor } from "./vellum/supervision/select";
import { SettingsService } from "./vellum/settings/service";
import { StateEngine } from "./vellum/state/service";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum/state/migrations";
import { inspectStateUpdateCandidate } from "./vellum/state/candidate-readiness";
import { withStateUpdateCandidate } from "./vellum/state/update-candidate";
import { installUpdateHostHooks } from "./vellum/update";
import { compiledLicenseBuildConfig } from "./vellum/license/compiled-config";
import {
  makeLicenseCoordinator,
  type LicenseCoordinator,
} from "./vellum/license/coordinator";
import { LicenseService } from "./vellum/license/service";
import { hostOperationsShutdown } from "./vellum/hosts/shutdown";
import { makeOperatorCoordinator } from "./vellum/hosts/operator-coordinator";
import {
  operatorControlEnabledFromInitialArgv,
  startOperatorControlServer,
  type OperatorControlServer,
} from "./vellum/operator-control";
import { findPackagedSandboxDisablingSwitch } from "./vellum/packaged-sandbox-policy";
import {
  applyE2eMacOsFocusIsolation,
  e2eFocusIsolationActive,
  e2eMainWindowOptions,
  e2ePresentationFromEnv,
} from "./vellum/e2e-presentation";

// TerminalRouter SSH dials need the process RootLayer; bind AppRuntime once
// so term/router never imports the Electron runtime graph itself.
configureTerminalRouterLayeredRunner((effect) =>
  AppRuntime.runPromise(effect as never),
);

// Browser sessions must resolve and connect directly. An inherited system
// proxy can perform independent DNS resolution and bypass Vellum Command's URL/DNS
// preflight on fleet machines.
app.commandLine.appendSwitch("no-proxy-server");
// Defense in depth for every renderer, including future windows whose local
// preferences might otherwise drift. This must run before app readiness.
app.enableSandbox();
registerTrustedRendererScheme(protocol, [CONTENT_PROTOCOL_SCHEME_REGISTRATION]);

// electron-vite (and some launchd/stdio handoffs) can close the parent pipe
// while main still logs. A bare console.* write then throws EPIPE as an
// uncaught exception and Electron paints the "JavaScript error in main
// process" dialog on top of a still-open window. Swallow only broken-pipe
// IO on the process streams — real logging failures stay loud elsewhere.
const ignoreBrokenPipe = (stream: NodeJS.WriteStream | undefined): void => {
  stream?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "EIO") return;
    throw error;
  });
};
ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

app.on(
  "select-client-certificate",
  (event, webContents, _url, _certificateList, callback) => {
    if (!isManagedBrowserWebContents(webContents)) return;
    event.preventDefault();
    callback();
  },
);

const nodeRefIngress = makeNodeRefIngress((ref) =>
  AppRuntime.runPromise(
    Effect.flatMap(CanvasesService, (canvases) => resolveNodeRef(canvases, ref)),
  ),
);

let nodeRefOwnerReady = false;
let pendingNodeRefUri: NodeRefKey | undefined;
let activeNodeRefDelivery:
  | {
      readonly id: string;
      readonly uri: NodeRefKey;
    }
  | undefined;
let disconnectNodeRefIngress = (): void => undefined;

const reportNodeRefResult = (result: Awaited<ReturnType<typeof nodeRefIngress.accept>>): void => {
  if (!result.ok && result.code !== "superseded") {
    console.error(`[node-ref] locator rejected (${result.code})`);
  }
};

const activatePendingNodeRef = (): void => {
  if (!nodeRefOwnerReady || shutdownAdmissionClosed) return;
  const uri = pendingNodeRefUri;
  if (uri === undefined) return;
  pendingNodeRefUri = undefined;
  const delivery = { id: randomUUID(), uri } as const;
  activeNodeRefDelivery = delivery;
  void nodeRefIngress.accept(uri).then(
    (result) => {
      if (activeNodeRefDelivery?.id !== delivery.id) return;
      if (result.ok || result.code === "superseded") return;
      activeNodeRefDelivery = undefined;
      reportNodeRefResult(result);
    },
    () => {
      if (activeNodeRefDelivery?.id === delivery.id) {
        activeNodeRefDelivery = undefined;
      }
      console.error("[node-ref] owner-memory activation failed");
    },
  );
};

const queueNodeRefUri = (uri: string): void => {
  pendingNodeRefUri = undefined;
  const canonical = canonicalNodeRefUri(uri);
  if (canonical === undefined) {
    activeNodeRefDelivery = undefined;
    if (nodeRefOwnerReady) {
      void nodeRefIngress.accept(uri).then(reportNodeRefResult);
    } else {
      console.error("[node-ref] locator rejected (invalid)");
    }
    return;
  }
  pendingNodeRefUri = canonical;
  activatePendingNodeRef();
};

const retryActiveNodeRef = (): void => {
  const active = activeNodeRefDelivery;
  if (active === undefined) return;
  pendingNodeRefUri = active.uri;
  activatePendingNodeRef();
};

// macOS may emit this before ready. Native handling is prevented synchronously;
// the latest canonical target waits in the eventual owner's bounded memory.
app.on("open-url", (event, uri) => {
  event.preventDefault();
  queueNodeRefUri(uri);
});

const startupNodeRefUri = latestNodeRefUri(process.argv);
if (startupNodeRefUri !== undefined) queueNodeRefUri(startupNodeRefUri);

// Explicit headless mode keeps the runtime, watchers, kernel, and local UDS
// services alive without creating a renderer. It replaces the former dev CDP
// listener: headless qualification must never require a network control port.
const stateUpdatePreflight = process.argv.includes(
  STATE_UPDATE_PREFLIGHT_SWITCH,
);
const headless =
  stateUpdatePreflight || process.argv.includes("--vellum-headless");
// Freeze this privileged ingress decision from the original process argv.
// A later second-instance event cannot enable it in the running singleton.
const operatorControlEnabledAtLaunch =
  operatorControlEnabledFromInitialArgv(process.argv, stateUpdatePreflight);

// Playwright E2E needs a real authoring renderer (not --vellum-headless), but
// must never steal macOS focus or plant Dock icons. VELLUM_E2E_SHOW=1 opts out
// for visual debugging of a single scenario.
const e2ePresentation = e2ePresentationFromEnv();
const e2eIsolateFocus = e2eFocusIsolationActive(e2ePresentation);
applyE2eMacOsFocusIsolation({
  active: e2eIsolateFocus,
  platform: process.platform,
  setActivationPolicy: (policy) => app.setActivationPolicy(policy),
  hideDock: () => {
    app.dock?.hide();
  },
});

let trustedMainWindow: BrowserWindow | undefined;
/** The Command Center is a trusted renderer identity, never "the first window". */
const currentTrustedMainWindow = (): BrowserWindow | undefined => {
  const candidate = trustedMainWindow;
  if (candidate === undefined) return undefined;
  if (!candidate.isDestroyed()) return candidate;
  trustedMainWindow = undefined;
  return undefined;
};
const browserViewAttachmentTarget = makeElectronBrowserViewAttachmentTarget();
const browserCompositionHost = makeBrowserCompositionHost({
  createHiddenWindow: (options) => new BrowserWindow(options),
  views: browserViewAttachmentTarget,
});
// Parsed before BrowserWindow construction. A renderer never becomes trusted
// merely because it happens to be the application's first WebContents.
let trustedRendererOrigin: TrustedRendererOrigin | undefined;
let browserComposition: BrowserComposition | undefined;
let browserControl: BrowserControlServer | undefined;
let uninstallBrowserReadinessProbe: (() => void) | undefined;
let workControl: WorkControlServer | undefined;
let stationControl: StationControlServer | undefined;
let stationRemoteReportPump: StationRemoteReportPump | undefined;
let canvasControl: CanvasControlServer | undefined;
let operatorControl: OperatorControlServer | undefined;
type HerdrPlaneService = Context.Tag.Service<typeof HerdrPlane>;
type HermesPlaneService = Context.Tag.Service<typeof HermesPlane>;
let herdrPlaneService: HerdrPlaneService | undefined;
let hermesPlaneService: HermesPlaneService | undefined;
type KernelServiceShape = Context.Tag.Service<typeof KernelService>;
type StationFleetPropagationShape = Context.Tag.Service<
  typeof StationFleetPropagation
>;
let kernelService: KernelServiceShape | undefined;
let stationFleetPropagationService:
  | StationFleetPropagationShape
  | undefined;
let stationFleetPropagationShutdown: Promise<void> | undefined;
let licenseCoordinator: LicenseCoordinator | undefined;
let unregisterLicenseIpc: (() => void) | undefined;
let licenseClockChangeSubscription: number | undefined;
let rendererWindowAdmissionReady = false;
let productRuntimeStarted = false;
let productRuntimeSuspended = false;
let operatorFleetReady = false;
let shutdownAdmissionClosed = false;
let shutdownReason = "app_quit";
let browserShutdown: Promise<Awaited<ReturnType<BrowserComposition["drainOnQuit"]>>> | undefined;
let workControlShutdown: Promise<Awaited<ReturnType<WorkControlServer["drainOnQuit"]>>> | undefined;
let stationControlShutdown:
  | Promise<Awaited<ReturnType<StationControlServer["close"]>>>
  | undefined;
let stationRemoteReportPumpShutdown: Promise<void> | undefined;
let canvasControlShutdown:
  | Promise<Awaited<ReturnType<CanvasControlServer["close"]>>>
  | undefined;
let operatorControlShutdown:
  | Promise<Awaited<ReturnType<OperatorControlServer["close"]>>>
  | undefined;
let hostOperationsDrain:
  | Promise<Awaited<ReturnType<typeof hostOperationsShutdown.drainOnQuit>>>
  | undefined;
let termPlaneShutdown: Promise<Awaited<ReturnType<typeof termPlane.drainOnQuit>>> | undefined;
let herdrShutdown: Promise<Awaited<ReturnType<HerdrPlaneService["drainOnQuit"]>>> | undefined;
let hermesShutdown:
  | Promise<Awaited<ReturnType<HermesPlaneService["shutdown"]["drainOnQuit"]>>>
  | undefined;
let adapterShutdown:
  | Promise<Awaited<ReturnType<typeof terminateAdapterChildrenOnQuit>>>
  | undefined;
let appProcessShutdown:
  | Promise<Awaited<ReturnType<typeof appProcessPlane.drainOnQuit>>>
  | undefined;
let unsubscribeCanvasEdgeGrants: (() => void) | undefined;
let mainAuthoringPrecommitEpoch: number | undefined;
const signalQuitState = createSignalQuitState();
const quitPreparationArbiter = createQuitPreparationArbiter();
const signalQuiescedWindows = new WeakSet<BrowserWindow>();
let signalRendererDestroyInProgress = false;
/** Active herdr control-stream count provider for the quit live-work gate. */
let herdrActiveControlCount: () => number = () => 0;
let closeWindowsWithoutCanvasFlush = false;
/** Explicit quit confirmed by the operator (or skipped: signal / headless / idle). */
let quitConfirmed = false;
/**
 * Signal / forced-exit path: skip the honest-quit dialog for the next before-quit
 * entry only (consumed once). Cmd+Q still gates on live work. Set from
 * installProcessSignalTermination cleanup; cleared on consume or recoverable
 * pre-commit failure, but retained across the irreversible quiesced boundary.
 */
let skipQuitConfirm = false;
/**
 * Bumps to invalidate an in-flight honest-quit dialog (e.g. signal supersedes
 * Cmd+Q confirm). Confirm accept is ignored when generation no longer matches.
 */
let quitConfirmGeneration = 0;
/** True while a native confirm dialog is open — blocks a second dialog, not signal force. */
let quitConfirmPending = false;

const beginStationFleetPropagationShutdown = (): void => {
  const service = stationFleetPropagationService;
  if (service === undefined) return;
  // The synchronous cut prevents any continuation from opening another
  // outbound route. The retained promise owns exact worker/session teardown
  // and is awaited before the shared Effect runtime is disposed.
  service.beginShutdown();
  stationFleetPropagationShutdown ??= AppRuntime.runPromise(
    service.stop,
  );
};

/**
 * Hard denial only (never activated / unusable product). Closes product
 * ingress but deliberately leaves local PTYs alive — quit remains signal
 * authority. Prefer enterLicenseMaintenance for lapsed prior grants.
 */
const suspendProductRuntimeForLicenseRevocation = (): void => {
  if (productRuntimeSuspended) return;
  productRuntimeSuspended = true;
  operatorFleetReady = false;
  operatorControl?.beginShutdown();
  nodeRefOwnerReady = false;
  pendingNodeRefUri = undefined;
  activeNodeRefDelivery = undefined;
  disconnectNodeRefIngress();
  disconnectNodeRefIngress = () => undefined;

  kernelService?.suspend();
  beginStationFleetPropagationShutdown();
  termPlane.suspendForLicenseRevocation();
  workControl?.beginShutdown();
  canvasControl?.beginShutdown();
  stationRemoteReportPumpShutdown ??= stationRemoteReportPump?.close();
  stationControl?.beginShutdown();
  hostOperationsShutdown.beginShutdown();

  unsubscribeCanvasEdgeGrants?.();
  unsubscribeCanvasEdgeGrants = undefined;
  browserShutdown ??= browserComposition?.drainOnQuit(
    "license_revoked",
  );
};

/**
 * Custody entry after a previously valid grant lapses.
 *
 * Factory hold (coordinator) forces the play control into maintenance and
 * seatPaused=true; productLicenseAdmission mode=maintenance refuses authorial
 * mutations. Owned PTYs/agents are not killed — they stay blocked by pause.
 * Kernel/term monotonic suspend is reserved for hard denial only so full
 * access can return seamlessly without a restart.
 */
const enterLicenseMaintenance = (): void => {
  // Hooks exist for future flush orchestration / UI telemetry. Law is already
  // enforced by licenseFactoryHold + productLicenseAdmission mode.
};

/**
 * Full access restored. Does not auto-unblock seats or auto-play the factory.
 */
const returnFromLicenseMaintenance = (): void => {
  // Operator re-plays / unblocks explicitly after entitlement returns.
};

const CANVAS_FLUSH_TIMEOUT_MS = 45_000;
const pendingCanvasFlushes = new Map<
  number,
  {
    readonly requestId: string;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }
>();

class CanvasQuiesceAndFlushError extends Error {
  constructor(message: string, readonly quiesced: boolean) {
    super(message);
    this.name = "CanvasQuiesceAndFlushError";
  }
}

const pendingCanvasQuiesceAndFlushes = new Map<
  number,
  {
    readonly requestId: string;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: CanvasQuiesceAndFlushError) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    quiesced: boolean;
  }
>();
// A successful final ACK is a narrow synchronous gap before the cleanup
// continuation destroys the renderer. Crash recovery must never reload an
// authoring surface inside that already-durable interval.
const acknowledgedCanvasQuiesceWebContents = new Set<number>();

const decodeCanvasFlushResult = (payload: unknown): CanvasFlushResult | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (Object.keys(payload).sort().join(",") !== "ok,requestId") return undefined;
  if (!("requestId" in payload) || typeof payload.requestId !== "string") return undefined;
  if (!("ok" in payload) || typeof payload.ok !== "boolean") return undefined;
  return { requestId: payload.requestId, ok: payload.ok };
};

const decodeCanvasQuiesceAndFlushResult = (
  payload: unknown,
): CanvasQuiesceAndFlushResult | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (Object.keys(payload).sort().join(",") !== "ok,quiesced,requestId") return undefined;
  if (!("requestId" in payload) || typeof payload.requestId !== "string") return undefined;
  if (!("ok" in payload) || typeof payload.ok !== "boolean") return undefined;
  if (!("quiesced" in payload) || typeof payload.quiesced !== "boolean") return undefined;
  return { requestId: payload.requestId, ok: payload.ok, quiesced: payload.quiesced };
};

const decodeCanvasQuiesceStarted = (payload: unknown): { readonly requestId: string } | undefined => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (Object.keys(payload).join(",") !== "requestId") return undefined;
  if (!("requestId" in payload) || typeof payload.requestId !== "string") return undefined;
  return { requestId: payload.requestId };
};

const requestCanvasFlush = (mainWindow: BrowserWindow): Promise<void> => {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return Promise.resolve();
  const webContentsId = mainWindow.webContents.id;
  const existing = pendingCanvasFlushes.get(webContentsId);
  if (existing !== undefined) return existing.promise;

  const requestId = randomUUID();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => {
    const pending = pendingCanvasFlushes.get(webContentsId);
    if (pending?.requestId !== requestId) return;
    pendingCanvasFlushes.delete(webContentsId);
    reject(new Error("renderer canvas flush timed out"));
  }, CANVAS_FLUSH_TIMEOUT_MS);
  pendingCanvasFlushes.set(webContentsId, { requestId, promise, resolve, reject, timer });
  mainWindow.webContents.send(IPC_CHANNELS.canvasFlushRequested, { requestId });
  return promise;
};

ipcMain.on(IPC_CHANNELS.canvasFlushComplete, (event, payload: unknown) => {
  if (!isTrustedMainWebContents(event.sender)) return;
  const result = decodeCanvasFlushResult(payload);
  if (result === undefined) return;
  const pending = pendingCanvasFlushes.get(event.sender.id);
  if (pending === undefined || pending.requestId !== result.requestId) return;
  clearTimeout(pending.timer);
  pendingCanvasFlushes.delete(event.sender.id);
  if (result.ok) pending.resolve();
  else pending.reject(new Error("renderer rejected close because canvas save failed"));
});

const requestCanvasQuiesceAndFlush = (
  mainWindow: BrowserWindow,
  finalWriteEpoch?: number,
): Promise<void> => {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new CanvasQuiesceAndFlushError(
      "renderer unavailable before canvas quiesce request",
      false,
    ));
  }
  const webContentsId = mainWindow.webContents.id;
  const existing = pendingCanvasQuiesceAndFlushes.get(webContentsId);
  if (existing !== undefined) return existing.promise;

  const requestId = randomUUID();
  let resolve!: () => void;
  let reject!: (error: CanvasQuiesceAndFlushError) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => {
    const pending = pendingCanvasQuiesceAndFlushes.get(webContentsId);
    if (pending?.requestId !== requestId) return;
    pendingCanvasQuiesceAndFlushes.delete(webContentsId);
    // The request may have reached the renderer and closed its monotonic gate;
    // timeout cannot safely authorize either UI recovery or force exit.
    reject(new CanvasQuiesceAndFlushError(
      "renderer canvas quiesce timed out",
      pending.quiesced,
    ));
  }, CANVAS_FLUSH_TIMEOUT_MS);
  pendingCanvasQuiesceAndFlushes.set(webContentsId, {
    requestId,
    promise,
    resolve,
    reject,
    timer,
    quiesced: false,
  });
  const finalWriteBinding = finalWriteEpoch === undefined
    ? undefined
    : { senderId: mainWindow.webContents.id, requestId };
  try {
    if (finalWriteBinding !== undefined) {
      mainAuthoringGate.mintFinalWritePermit(finalWriteEpoch!, finalWriteBinding);
    }
    mainWindow.webContents.send(IPC_CHANNELS.canvasQuiesceAndFlushRequested, { requestId });
  } catch (error) {
    clearTimeout(timer);
    pendingCanvasQuiesceAndFlushes.delete(webContentsId);
    if (finalWriteBinding !== undefined) {
      try {
        mainAuthoringGate.revokeFinalWritePermit(finalWriteEpoch!, finalWriteBinding);
      } catch {
        // A failed send is already blocking quit. Permit revocation stays best-effort.
      }
    }
    reject(new CanvasQuiesceAndFlushError(
      error instanceof Error ? error.message : String(error),
      false,
    ));
  }
  if (finalWriteBinding === undefined) return promise;
  return promise.finally(() => {
    try {
      mainAuthoringGate.revokeFinalWritePermit(finalWriteEpoch!, finalWriteBinding);
    } catch {
      // The caller still performs the post-flush drain and surfaces any retained
      // final authority there. This revocation cannot silently mark the flush clean.
    }
  });
};

ipcMain.on(IPC_CHANNELS.canvasQuiesceAndFlushStarted, (event, payload: unknown) => {
  if (!isTrustedMainWebContents(event.sender)) return;
  const started = decodeCanvasQuiesceStarted(payload);
  if (started === undefined) return;
  const pending = pendingCanvasQuiesceAndFlushes.get(event.sender.id);
  if (pending === undefined || pending.requestId !== started.requestId) return;
  pending.quiesced = true;
  quitPreparationArbiter.observeRendererGateQuiesced();
});

ipcMain.on(IPC_CHANNELS.canvasQuiesceAndFlushComplete, (event, payload: unknown) => {
  if (!isTrustedMainWebContents(event.sender)) return;
  const result = decodeCanvasQuiesceAndFlushResult(payload);
  if (result === undefined) return;
  const pending = pendingCanvasQuiesceAndFlushes.get(event.sender.id);
  if (pending === undefined || pending.requestId !== result.requestId) return;
  clearTimeout(pending.timer);
  pendingCanvasQuiesceAndFlushes.delete(event.sender.id);
  const quiesced = pending.quiesced || result.quiesced;
  if (quiesced) quitPreparationArbiter.observeRendererGateQuiesced();
  if (result.ok && quiesced) {
    acknowledgedCanvasQuiesceWebContents.add(event.sender.id);
    pending.resolve();
    return;
  }
  pending.reject(new CanvasQuiesceAndFlushError(
    "renderer rejected quit because canvas save failed",
    quiesced,
  ));
});

const rejectPendingCanvasQuiesce = (
  webContentsId: number,
  message: string,
  quiesced: boolean,
): boolean => {
  const pending = pendingCanvasQuiesceAndFlushes.get(webContentsId);
  if (pending === undefined) return false;
  clearTimeout(pending.timer);
  pendingCanvasQuiesceAndFlushes.delete(webContentsId);
  pending.reject(new CanvasQuiesceAndFlushError(message, quiesced));
  return true;
};

// Bounded renderer crash recovery. A renderer that dies (GPU reset, OOM kill,
// Chromium crash) is first reloaded in place — that recovers the common
// transient crash without losing the main process (Effect runtime, snapshot
// refresh loop). If deaths keep coming we escalate to a full app relaunch, but
// at most MAX_RECOVERIES within RECOVERY_WINDOW_MS so a hard crash loop gives
// up LOUDLY instead of spinning the CPU forever. Unattended-station-critical:
// these handlers run in packaged builds too, not just dev.
const RECOVERY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_RECOVERIES = 3;
const RENDERER_SURFACE_READY_TIMEOUT_MS = resolveRendererSurfaceTimeoutMs({
  packaged: app.isPackaged,
  testHarness: process.env.VELLUM_E2E === "1",
  override: process.env.VELLUM_E2E_RENDERER_SURFACE_TIMEOUT_MS,
  fallbackMs: 30_000,
});
const rendererSurfaceRecovery = createRendererSurfaceRecovery({
  maxRetries: 3,
  windowMs: RECOVERY_WINDOW_MS,
});
let rendererRecoveryDestroyInProgress = false;
let rendererFailureWindow: BrowserWindow | undefined;
let recoveryWindowStart = Date.now();
let reloadCount = 0;
let relaunchCount = 0;

const registerCrashRecovery = (mainWindow: BrowserWindow) => {
  // Dev observability: forward the renderer console to main stdout so headless
  // failures are visible in the terminal log. Noise-only — stays dev-gated.
  // Electron 43 deprecates the positional console-message signature; use the
  // Event<WebContentsConsoleMessageEventParams> fields instead.
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (event) => {
      if (event.level !== "error" && event.level !== "warning") return;
      const severity = event.level === "error" ? "error" : "warn";
      console.log(
        `[renderer:${severity}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
      );
    });
  }

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason} (exitCode ${details.exitCode})`);
    if (mainWindow.isDestroyed()) return;
    const webContentsId = mainWindow.webContents.id;
    // Final ACK is the only renderer-durability receipt. Once observed, never
    // reload in the narrow continuation gap before synchronous destruction.
    if (acknowledgedCanvasQuiesceWebContents.has(webContentsId)) return;

    // A dead renderer has no surviving admission gate. Reject any pending
    // handshake as recoverable, reset a gate remembered from an earlier timed
    // out attempt, then reload a fresh renderer generation from durable disk.
    rejectPendingCanvasQuiesce(
      webContentsId,
      "renderer crashed before canvas quiesce acknowledgement",
      false,
    );
    signalQuitState.forgetRendererGateAfterProcessLoss();
    quitPreparationArbiter.forgetRendererGateAfterProcessLoss();

    // Clean renderer exit is still process loss: a replacement preload owns a
    // fresh process-local admission latch. Do not carry the old Started receipt
    // into that generation, even when Electron performs its own replacement.
    if (details.reason === "clean-exit") return;

    const now = Date.now();
    if (now - recoveryWindowStart > RECOVERY_WINDOW_MS) {
      recoveryWindowStart = now;
      reloadCount = 0;
      relaunchCount = 0;
    }

    if (reloadCount < MAX_RECOVERIES) {
      reloadCount += 1;
      console.error(`[renderer:gone] in-place reload ${reloadCount}/${MAX_RECOVERIES}`);
      mainWindow.webContents.reload();
      return;
    }

    if (relaunchCount < MAX_RECOVERIES) {
      relaunchCount += 1;
      console.error(`[renderer:gone] reloads exhausted — full relaunch ${relaunchCount}/${MAX_RECOVERIES}`);
      app.relaunch();
      exitAfterDetach(0, "renderer-relaunch");
      return;
    }

    console.error(
      `[renderer:gone] renderer crash loop: >${MAX_RECOVERIES} reloads and >${MAX_RECOVERIES} relaunches ` +
        `within ${RECOVERY_WINDOW_MS}ms. Giving up — manual relaunch required.`,
    );
  });

  mainWindow.webContents.on("unresponsive", () => {
    console.error("[renderer:unresponsive] renderer hung");
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload:error] ${preloadPath}: ${error.message}`);
  });
};

const createWindow = () => {
  // Signal quit has crossed an irreversible durability boundary. Native
  // activate/second-instance events must not resurrect an authoring renderer
  // while the bounded fallback is finishing a partially torn-down runtime.
  if (
    !rendererWindowAdmissionReady ||
    shutdownAdmissionClosed ||
    signalRendererDestroyInProgress ||
    signalQuitState.rendererQuiesced() ||
    quitPreparationArbiter.rendererGateQuiesced() ||
    quitPreparationArbiter.committed()
  ) return;
  const rendererOrigin = trustedRendererOrigin;
  if (rendererOrigin === undefined) {
    console.error("[window] trusted renderer authority was not resolved before window construction");
    exitAfterDetach(1, "trusted-renderer-authority-missing");
    return;
  }
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: "Vellum Command",
    backgroundColor: "#0c0b0a",
    // `hiddenInset` and traffic-light geometry are a macOS presentation
    // contract. Linux window managers receive Electron's native chrome.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    // E2E: off-screen, non-focusable — Playwright still attaches; operator
    // focus and Dock stay undisturbed (see e2e-presentation.ts).
    ...e2eMainWindowOptions(e2ePresentation),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (productRuntimeStarted && !productRuntimeSuspended) {
    void browserCompositionHost.bindVisibleWindow(mainWindow).catch(() => {
      if (!mainWindow.isDestroyed()) mainWindow.destroy();
      exitAfterDetach(1, "browser-composition-host-bind-failure");
    });
  }
  trustedMainWindow = mainWindow;
  // BrowserWindow's `closed` event fires after its native object and
  // WebContents have been destroyed. Capture the routing identity while it is
  // live; dereferencing mainWindow.webContents inside `closed` throws.
  const mainWebContentsId = mainWindow.webContents.id;

  let closeAfterCanvasFlush = false;
  let closeFlush: Promise<void> | undefined;
  mainWindow.on("close", (event) => {
    if (
      !productRuntimeStarted ||
      productRuntimeSuspended ||
      closeWindowsWithoutCanvasFlush ||
      closeAfterCanvasFlush ||
      signalQuiescedWindows.has(mainWindow)
    ) return;
    event.preventDefault();
    if (quitPreparationArbiter.signalPrecommit()) return;
    closeFlush ??= requestCanvasFlush(mainWindow)
      .then(() => {
        // A signal may claim global quit while this ordinary flush is in
        // flight. Its renderer handshake now owns the only close authority.
        if (quitPreparationArbiter.signalPrecommit()) return;
        closeAfterCanvasFlush = true;
        mainWindow.close();
      })
      .catch((error) => {
        console.error("[canvas] window close blocked:", error);
      })
      .finally(() => {
        closeFlush = undefined;
      });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = classifyBrowserTarget(url);
    if (target.allowed) {
      setImmediate(() => {
        void shell.openExternal(target.normalizedUrl).catch(() => {
          console.error("[window] external URL open failed");
        });
      });
    }
    return { action: "deny" };
  });
  const clearRendererTrust = (): void => {
    if (trustedMainWindow === mainWindow) setTrustedMainWebContents(undefined);
  };
  const surfaceReadiness = createRendererSurfaceReadiness({
    timeoutMs: RENDERER_SURFACE_READY_TIMEOUT_MS,
    onTimeout: (phase) => {
      console.error(`[window] trusted renderer ${phase} did not complete before the readiness deadline`);
      clearRendererTrust();
      recoverRendererSurface(mainWindow, phase);
    },
  });
  const acknowledgeRendererSurface = (event: IpcMainEvent, challenge: unknown): void => {
    if (
      event.sender !== mainWindow.webContents ||
      mainWindow.isDestroyed() ||
      event.sender.isDestroyed() ||
      !rendererOrigin.allows(event.sender.getURL())
    ) return;
    if (surfaceReadiness.acknowledge(challenge)) rendererSurfaceRecovery.succeeded();
  };
  ipcMain.on(IPC_CHANNELS.rendererSurfaceReady, acknowledgeRendererSurface);

  const rendererNavigation = createTrustedRendererNavigation({
    origin: rendererOrigin,
    currentUrl: () => mainWindow.webContents.getURL(),
    available: () => !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed(),
    trust: () => setTrustedMainWebContents(mainWindow.webContents, rendererOrigin),
    revoke: clearRendererTrust,
    documentStarted: surfaceReadiness.documentStarted,
    committedDocumentRestored: () => {
      const challenge = surfaceReadiness.committedDocumentRestored();
      if (challenge !== undefined) {
        mainWindow.webContents.send(IPC_CHANNELS.rendererSurfaceChallenge, challenge);
      }
    },
    trustedDocumentCommitted: () => {
      const challenge = surfaceReadiness.trustedDocumentCommitted();
      mainWindow.webContents.send(IPC_CHANNELS.rendererSurfaceChallenge, challenge);
    },
    rejectCommittedUrl: (loadedUrl) => {
      console.error(`[window] trusted renderer rejected loaded URL: ${loadedUrl}`);
      if (!mainWindow.isDestroyed()) mainWindow.destroy();
    },
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    rendererNavigation.willNavigate(event, url);
  });
  mainWindow.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    rendererNavigation.didStartNavigation(inPlace, isMainFrame);
  });
  mainWindow.webContents.on("will-redirect", (event, _url, _inPlace, isMainFrame) => {
    rendererNavigation.willRedirect(event, isMainFrame);
  });
  mainWindow.webContents.on("did-navigate", (_event, url) => {
    rendererNavigation.didNavigate(url);
  });
  mainWindow.webContents.on("did-finish-load", rendererNavigation.didFinishLoad);
  mainWindow.webContents.on("did-fail-load", (_event, _errorCode, _description, _url, isMainFrame) => {
    rendererNavigation.didFailLoad(isMainFrame);
  });
  mainWindow.webContents.on("did-stop-loading", rendererNavigation.didStopLoading);
  mainWindow.webContents.on("render-process-gone", rendererNavigation.documentLost);
  mainWindow.webContents.on("preload-error", rendererNavigation.documentLost);

  let disconnectNodeRefSink = (): void => undefined;
  const disconnect = (): void => {
    disconnectNodeRefSink();
    disconnectNodeRefSink = () => undefined;
    if (disconnectNodeRefIngress === disconnect) disconnectNodeRefIngress = () => undefined;
  };
  const acknowledgeDelivery = (event: IpcMainEvent, deliveryId: unknown): void => {
    const delivery = activeNodeRefDelivery;
    if (
      !isTrustedMainWebContents(event.sender) ||
      typeof deliveryId !== "string" ||
      delivery?.id !== deliveryId
    ) {
      return;
    }
    activeNodeRefDelivery = undefined;
  };
  ipcMain.on(IPC_CHANNELS.nodeRefOpenedAck, acknowledgeDelivery);
  mainWindow.webContents.on("did-start-loading", () => {
    disconnect();
    retryActiveNodeRef();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    if (!isTrustedMainWebContents(mainWindow.webContents)) return;
    disconnect();
    disconnectNodeRefSink = nodeRefIngress.connect((target) => {
      if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        throw new Error("renderer unavailable");
      }
      const delivery = activeNodeRefDelivery;
      if (delivery === undefined || delivery.uri !== target.ref) {
        throw new Error("node-reference delivery unavailable");
      }
      const payload: NodeRefOpenedDelivery = {
        ...target,
        deliveryId: delivery.id,
      };
      mainWindow.webContents.send(IPC_CHANNELS.nodeRefOpened, payload);
      // Never surface/focus during E2E focus isolation — that steals macOS
      // focus from the operator's real work. Production still raises the CC.
      if (!e2eIsolateFocus) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    disconnectNodeRefIngress = disconnect;
  });
  mainWindow.on("closed", () => {
    if (productRuntimeStarted && !productRuntimeSuspended) {
      void browserCompositionHost.releaseVisibleWindow(mainWindow).catch(() => {
        exitAfterDetach(1, "browser-composition-host-release-failure");
      });
    }
    const pending = pendingCanvasFlushes.get(mainWebContentsId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pendingCanvasFlushes.delete(mainWebContentsId);
      pending.reject(new Error("renderer closed before canvas flush completed"));
    }
    rejectPendingCanvasQuiesce(
      mainWebContentsId,
      "renderer closed before canvas quiesce completed",
      false,
    );
    quitPreparationArbiter.forgetRendererGateAfterProcessLoss();
    acknowledgedCanvasQuiesceWebContents.delete(mainWebContentsId);
    if (trustedMainWindow === mainWindow) trustedMainWindow = undefined;
    setTrustedMainWebContents(undefined);
    surfaceReadiness.dispose();
    ipcMain.removeListener(IPC_CHANNELS.rendererSurfaceReady, acknowledgeRendererSurface);
    disconnect();
    ipcMain.removeListener(IPC_CHANNELS.nodeRefOpenedAck, acknowledgeDelivery);
    quitWhenNoOperatorWindow();
  });

  registerCrashRecovery(mainWindow);

  // Arm before loadURL so a request that never reaches did-start-navigation
  // or did-finish-load cannot strand an indefinitely black live window.
  surfaceReadiness.documentStarted();
  void mainWindow.loadURL(rendererOrigin.initialUrl).catch(() => {
    if (app.isPackaged) {
      console.error("[window] trusted renderer load failed");
    } else {
      console.error("[window] development renderer load failed");
    }
    if (!mainWindow.isDestroyed()) mainWindow.destroy();
    exitAfterDetach(1, "renderer-load-failure");
  });

  return mainWindow;
};

const createRendererFailureWindow = (): BrowserWindow => {
  const existing = rendererFailureWindow;
  if (existing !== undefined && !existing.isDestroyed()) {
    if (!e2eIsolateFocus) {
      existing.show();
      existing.focus();
    }
    return existing;
  }
  const failureWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 520,
    minHeight: 300,
    title: "Vellum Command recovery",
    backgroundColor: "#0c0b0a",
    ...e2eMainWindowOptions(e2ePresentation),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  rendererFailureWindow = failureWindow;
  failureWindow.on("close", (event) => {
    // Keep a visible recovery surface while owned-runtime shutdown is unable
    // to prove clean. app.exit after a clean drain bypasses this event.
    if (runtimeDisposed) return;
    event.preventDefault();
    app.quit();
  });
  failureWindow.on("closed", () => {
    if (rendererFailureWindow === failureWindow) rendererFailureWindow = undefined;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Vellum Command recovery</title><style>html{color-scheme:dark;background:#0c0b0a;color:#ede6da;font:15px system-ui}body{max-width:52ch;margin:72px auto;padding:0 28px}h1{font-size:22px}p{line-height:1.55;color:#bdb5a8}</style><h1>Vellum Command could not render its workspace.</h1><p>A trusted workspace could not be restored safely. Quit and reopen Vellum Command; your canvas documents and local sessions were not deleted.</p>`;
  void failureWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (!e2eIsolateFocus) {
    failureWindow.show();
    failureWindow.focus();
  }
  return failureWindow;
};

const recoverRendererSurface = (
  failedWindow: BrowserWindow,
  phase: "load" | "mount",
): void => {
  const action = rendererSurfaceRecovery.failed({ admissionClosed: shutdownAdmissionClosed });
  rendererRecoveryDestroyInProgress = true;
  try {
    if (action === "retry") {
      if (!failedWindow.isDestroyed()) failedWindow.destroy();
      console.error(`[window] retrying trusted renderer after ${phase} timeout`);
      const replacement = createWindow();
      // BrowserWindow destruction emits synchronous lifecycle events. If any
      // of them closes admission before replacement construction, retain a
      // diagnostic instead of accepting a live windowless singleton.
      if (replacement === undefined) createRendererFailureWindow();
    } else {
      console.error(`[window] renderer recovery unavailable after ${phase} timeout`);
      createRendererFailureWindow();
      if (!failedWindow.isDestroyed()) failedWindow.destroy();
    }
  } finally {
    rendererRecoveryDestroyInProgress = false;
  }
};


// A packaged station enters only through its installed platform supervisor.
// Provider observations are status-only: neither launchd pid nor systemd
// MainPID ever becomes process-signal authority in this process.
const ensureSupervised = async (): Promise<boolean> => {
  if (!app.isPackaged) return true; // dev runs are never rerouted
  // The Linux unit is a Remote/headless facility, never a role inference.
  // Read the canonical SQLite topology through the same typed settings
  // component and the one app runtime before deciding whether this process
  // belongs to the Remote supervisor.
  if (process.platform === "linux") {
    try {
      const station = (
        await AppRuntime.runPromise(
          Effect.flatMap(SettingsService, (settings) => settings.get),
        )
      ).station;
      if (
        station.role !== "remote" ||
        station.supervisedPreferred !== true
      ) return true;
    } catch {
      return true;
    }
  }
  const supervisor = await loadStationSupervisor();
  const observation = await supervisor.observe();
  if (observation.state === "absent" || observation.state === "unsupported" ||
      observation.state === "unknown" || observation.state === "degraded") return true;
  if (observation.state === "active" && observation.ownership === "current") return true;
  // Release the lock so the supervisor's new instance can take it.
  app.releaseSingleInstanceLock();
  const handoff = await supervisor.requestHandoff();
  if (handoff.accepted) {
    exitAfterDetach(0, `${supervisor.metadata.provider}-handoff`);
    return false;
  }
  // Handoff failed — reclaim the lock and run unsupervised
  // rather than leaving the operator with nothing.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  console.error(`[${supervisor.metadata.provider}] handoff failed — running unsupervised this session`);
  return true;
};

// Single-instance lock — under a permanent/launchd deployment a second launch
// (Spotlight, `open`, a KeepAlive race) must NOT start a second process that
// would race the same app-owned StateEngine connection and control sockets.
// The second process exits immediately; the first focuses its window — or, when
// the factory is windowless on macOS, recreates the surface (mirror activate).
//
// State-update preflight is not a product instance: the incumbent holds the
// singleton while spawning the candidate for --vellum-state-preflight. If
// preflight also requestSingleInstanceLock(), Electron fails the lock and we
// app.quit() with no receipt — install aborts and the operator stays on the
// old version with "ready to install" still showing.
const packagedSandboxDisablingSwitch = findPackagedSandboxDisablingSwitch({
  packaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
});
const gotSingleInstanceLock = stateUpdatePreflight
  ? true
  : packagedSandboxDisablingSwitch === undefined &&
    app.requestSingleInstanceLock();
if (packagedSandboxDisablingSwitch !== undefined) {
  console.error(
    `[sandbox] packaged startup rejected --${packagedSandboxDisablingSwitch}`,
  );
  // Do not acquire the singleton lock or start product surfaces. Defer only
  // until module evaluation and Electron readiness complete so the canonical
  // owned-resource teardown seam is initialized and remains the sole direct
  // exit authority.
  app.once("ready", () => {
    exitAfterDetach(1, "packaged-sandbox-policy");
  });
} else if (!gotSingleInstanceLock) {
  app.quit();
} else {
  if (!stateUpdatePreflight) {
    app.on("second-instance", (_event, commandLine) => {
      const uri = latestNodeRefUri(commandLine);
      if (uri !== undefined) queueNodeRefUri(uri);
      const existing = currentTrustedMainWindow();
      if (!existing) {
        // Windowless keep-alive: Spotlight/`open -a` must not leave a dead UI.
        if (!headless) createWindow();
        return;
      }
      if (e2eIsolateFocus) return;
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    });
  }

  app.on("activate", () => {
    retryActiveNodeRef();
    if (!headless && currentTrustedMainWindow() === undefined) createWindow();
  });

  void app.whenReady().then(async () => {
    // Re-apply after ready: dock.hide before ready is a no-op / race on some
    // Electron builds, and E2E must never plant a Dock icon mid-suite.
    applyE2eMacOsFocusIsolation({
      active: e2eIsolateFocus,
      platform: process.platform,
      setActivationPolicy: (policy) => app.setActivationPolicy(policy),
      hideDock: () => {
        app.dock?.hide();
      },
    });
    // The signed/audited candidate runs this sealed mode only after the
    // installer has quiesced the incumbent and proved it released SQLite.
    // It opens the fixed canonical database read-only, migrates and inspects
    // only a disposable verified clone, emits one strict receipt, and starts
    // no renderer, socket, actor, browser, terminal, provider, or fleet plane.
    //
    // Keep this inside the ordinary packaged Electron process: RunAsNode stays
    // fused off. No argument or environment value can select another database.
    if (stateUpdatePreflight) {
      if (!app.isPackaged) {
        console.error(
          "[state-preflight] packaged candidate execution is required",
        );
        exitAfterDetach(1, "state-update-preflight-unpackaged");
        return;
      }
      try {
        const receipt = await Effect.runPromise(
          withStateUpdateCandidate(inspectStateUpdateCandidate),
        );
        process.stdout.write(
          `${JSON.stringify(receipt)}\n`,
          () => exitAfterDetach(0, "state-update-preflight-complete"),
        );
      } catch (error) {
        console.error("[state-preflight] candidate readiness failed:", error);
        exitAfterDetach(1, "state-update-preflight-failure");
      }
      return;
    }
    if (!(await ensureSupervised())) return;
    if (shutdownAdmissionClosed) return;

    try {
      // Treat ELECTRON_RENDERER_URL as hostile boot input. Parse it before any
      // BrowserWindow exists, and retain the resulting policy instead of the
      // ambient environment value for all later permission/trust decisions.
      trustedRendererOrigin = resolveTrustedRendererOrigin(
        app.isPackaged,
        process.env.ELECTRON_RENDERER_URL,
      );
      if (app.isPackaged) {
        await installTrustedRendererProtocol(
          session.defaultSession.protocol,
          join(__dirname, "../renderer"),
        );
      }
      installTrustedRendererPermissionPolicy(
        session.defaultSession,
        () => trustedMainWindow,
        trustedRendererOrigin,
      );
    } catch (error) {
      console.error("[window] trusted renderer protocol setup failed");
      console.error(error);
      exitAfterDetach(1, "trusted-renderer-startup-failure");
      return;
    }

    // Warm the resolved spawn environment (login-shell PATH + static floor) so
    // process.env.PATH is fixed before any adapter/service spawns a CLI. Never
    // rejects; adapters also await it lazily, so this is belt-and-suspenders.
    await resolvedSpawnEnv();
    if (shutdownAdmissionClosed) return;

    // Schema gate BEFORE AppRuntime opens SQLite. An older binary must not
    // crash-exit when the installed DB was advanced by a newer build — that
    // bricks auto-update (no healthy session to Restart-and-install). Offer
    // feed recovery without writing the database.
    {
      const compatibility = evaluateSchemaCompatibility();
      if (!compatibility.ok) {
        const outcome = await ensureSchemaCompatibleOrRecover({
          app,
          headless,
          compatibility,
        });
        if (outcome.action === "installing") {
          // quitAndInstall owns process lifetime from here.
          return;
        }
        if (outcome.action === "quit") {
          exitAfterDetach(1, outcome.reason);
          return;
        }
      }
    }

    // Seal process-bind peer-PID helper roots before any UDS control server starts.
    // Packaged: electron-builder extraResources → resources/bin/unix-peer-pid.py
    // Dev: never cwd — only explicit absolute repo scripts/ path.
    {
      const roots: string[] = [];
      if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
        roots.push(join(process.resourcesPath, "bin"));
      }
      if (!app.isPackaged) {
        roots.push(join(app.getAppPath(), "scripts"));
      }
      configurePeerPidHelperRoots(roots);
    }

    // Control sockets must never land under the real operator home when E2E /
    // headless probes sandbox via HOME or --user-data-dir. Electron's
    // app.getPath("home") ignores HOME; resolveControlHome is the isolation gate.
    const controlHomeInput = {
      envHome: process.env.HOME,
      electronHome: app.getPath("home"),
      userData: app.getPath("userData"),
      e2e: process.env.VELLUM_E2E === "1",
      headless,
      packaged: app.isPackaged,
    } as const;
    const termControlHome = resolveControlHome({
      ...controlHomeInput,
      explicitHome: process.env.VELLUM_HOME,
    });
    const browserControlHome = resolveControlHome({
      ...controlHomeInput,
      explicitHome: process.env.VELLUM_BROWSER_HOME ?? process.env.VELLUM_HOME,
    });

    const stations = await AppRuntime.runPromise(StationRepository);
    const stationConfiguration = await AppRuntime.runPromise(
      stations.configuration,
    );

    if (operatorControlEnabledAtLaunch) {
      try {
        const coordinator = makeOperatorCoordinator({
          fleetReady: () =>
            operatorFleetReady &&
            !productRuntimeSuspended &&
            !shutdownAdmissionClosed,
          readiness: () => ({
            database: true,
            workControl: workControlReadiness.ready(),
            simulation: kernelService !== undefined,
            session: stationControl?.ready() ?? false,
          }),
          sessionReady: () => stationControlReadiness.sessionReady(),
        });
        operatorControl = await startOperatorControlServer({
          home: termControlHome,
          dispatch: coordinator.dispatch,
        });
        if (shutdownAdmissionClosed) operatorControl.beginShutdown();
      } catch {
        console.error("[operator-control] failed to start");
        exitAfterDetach(1, "operator-control-startup-failure");
        return;
      }
    }

    // A newly installed packaged headless process has no renderer in which to
    // select its role. Keep exactly the owner-local Station enrollment verbs
    // alive so it can become a configured Remote, then require a restart. No
    // product IPC, work/canvas/term/browser control, kernel, or license
    // provider call is reachable in this bootstrap process.
    if (
      app.isPackaged &&
      headless &&
      stationConfiguration === undefined
    ) {
      try {
        stationControl = await startStationControlServer({
          home: termControlHome,
          appVersion: app.getVersion(),
          stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
          run: (effect) => AppRuntime.runPromise(effect),
          localHandoffAuthority:
            makeOwnerLocalStationControlHandoffAuthority(),
          readiness: () => ({
            database: true,
            workControl: false,
            simulation: false,
          }),
          admitRequest: (request) =>
            request.op === "status" ||
            request.op === "pair" ||
            request.op === "configure",
        });
        if (shutdownAdmissionClosed) stationControl.beginShutdown();
      } catch (error) {
        console.error(
          "[station-control] enrollment bootstrap failed:",
          error,
        );
        exitAfterDetach(1, "station-bootstrap-startup-failure");
      }
      return;
    }

    const licenseConfig = compiledLicenseBuildConfig(app.isPackaged);
    const licenseService = await AppRuntime.runPromise(LicenseService);
    // Remote: seed lease from durable Station contact before admission so a
    // restart within the 3-day window does not force maintenance.
    if (stationConfiguration?.configuration.role === "remote") {
      try {
        const stations = await AppRuntime.runPromise(StationRepository);
        const facts = await AppRuntime.runPromise(stations.statusFacts);
        const candidates: number[] = [];
        if (facts.pairing?.pairedAt) {
          const ms = Date.parse(facts.pairing.pairedAt);
          if (Number.isFinite(ms)) candidates.push(ms);
        }
        const headReceived = facts.projection?.receivedAt;
        if (typeof headReceived === "string") {
          const ms = Date.parse(headReceived);
          if (Number.isFinite(ms)) candidates.push(ms);
        }
        if (candidates.length > 0) {
          remoteLeaseState.hydrate(Math.max(...candidates));
        }
      } catch {
        // Missing pairing/projection is a never-checked-in Remote.
      }
    }
    const coordinator = makeLicenseCoordinator({
      config: licenseConfig,
      mode:
        stationConfiguration?.configuration.role === "remote"
          ? "remote-support"
          : "licensed-command-center",
      service: licenseService,
      run: (effect) => AppRuntime.runPromise(effect),
      openExternal: (url) => shell.openExternal(url),
      application: {
        relaunch: () => app.relaunch(),
        quit: () => app.quit(),
      },
      onEnterMaintenance: enterLicenseMaintenance,
      onReturnToFull: returnFromLicenseMaintenance,
      onAccessRevoked: suspendProductRuntimeForLicenseRevocation,
      remoteLastCheckInAtMs: () => remoteLeaseState.read(),
    });
    licenseCoordinator = coordinator;
    unregisterLicenseIpc = coordinator.registerIpc(ipcMain);
    const licenseDecision =
      await coordinator.decideStartupAdmission();

    if (!licenseDecision.admitted) {
      if (headless) {
        console.error(
          `[license] headless Command Center startup denied (${licenseDecision.status.reason})`,
        );
        exitAfterDetach(1, "license-startup-denied");
        return;
      }
      rendererWindowAdmissionReady = true;
      createWindow();
      return;
    }

    // Retain the exact scoped supervisor before any product IPC can start it.
    // License revocation must be able to cut its synchronous admission and
    // drive its worker/session shutdown even when renderer IPC startup is
    // still between asynchronous boundaries.
    stationFleetPropagationService = await AppRuntime.runPromise(
      StationFleetPropagation,
    );
    if (shutdownAdmissionClosed) {
      beginStationFleetPropagationShutdown();
      return;
    }

    // UpdateService host hooks: release SQLite before sealed preflight, and
    // relaunch without Squirrel install when readiness fails after quiesce.
    // After successful quiesce we mark runtimeDisposed + skipQuitConfirm so
    // electron-updater quitAndInstall is not blocked by before-quit re-commit.
    installUpdateHostHooks({
      quiesceForPreflight: async () => {
        await commitMainAuthoringOnQuit();
        detachRuntimeOnQuit("update-install-preflight");
        await disposeRuntimeFailClosed("update-install-preflight");
        runtimeDisposed = true;
        skipQuitConfirm = true;
        // Candidate preflight is a second Electron process. Drop the product
        // singleton so a preflight that still requests the lock cannot lose to
        // this still-alive (but non-product) process. Preflight itself must
        // not request the lock (see stateUpdatePreflight branch above).
        try {
          app.releaseSingleInstanceLock();
        } catch {
          // already released or unsupported
        }
      },
      relaunchWithoutInstall: () => {
        // app.exit bypasses before-quit; keep the same path on readiness failure.
        skipQuitConfirm = true;
        runtimeDisposed = true;
        app.relaunch();
        app.exit(0);
      },
    });
    registerIpcHandlers();
    registerDemoIpcHandlers();
    if (shutdownAdmissionClosed) return;

    // Content stream protocol: renderer media loads ContentRefs without Base64.
    // Handler resolves through ContentService (manifest + path); never opens DB
    // from the renderer and never exposes host paths in the URL.
    try {
      installContentProtocol(session.defaultSession.protocol, async (ref) => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const content = yield* ContentService;
            return yield* content.openForRead(ref);
          }),
        );
        return result;
      });
    } catch (error) {
      console.error("[content-protocol] failed to install:", error);
      exitAfterDetach(1, "content-protocol-startup-failure");
      return;
    }

    // Work control socket: agent protocol surface over the work plane.
    // Independent of browser composition; owns ~/.vellum/work/{control.sock,token}.
    try {
      workControl = await startWorkControlServer({
        version: app.getVersion(),
        run: (effect) => AppRuntime.runPromise(effect),
        onPreamble: (event: PreambleEvent) => {
          const window = currentTrustedMainWindow();
          if (
            window === undefined ||
            window.webContents.isDestroyed() ||
            !isTrustedMainWebContents(window.webContents)
          ) return;
          window.webContents.send(IPC_CHANNELS.preamble, event);
        },
      });
      if (shutdownAdmissionClosed) workControl.beginShutdown();
    } catch (error) {
      console.error("[work-control] failed to start:", error);
      exitAfterDetach(1, "work-control-startup-failure");
      return;
    }

    const [herdr, chat, hermes] = await Promise.all([
      AppRuntime.runPromise(HerdrPlane),
      AppRuntime.runPromise(ChatServiceContext),
      AppRuntime.runPromise(HermesPlane),
    ]);
    void chat;
    herdrPlaneService = herdr;
    hermesPlaneService = hermes;
    if (shutdownAdmissionClosed) {
      herdr.beginShutdown();
      hermesShutdown ??= hermes.shutdown.drainOnQuit();
      return;
    }
  herdrActiveControlCount = () => herdr.sessions.activeControlCount();
  await AppRuntime.runPromise(herdr.start);
    try {
      canvasControl = await startCanvasControlServer({
        home: termControlHome,
        run: (effect) => AppRuntime.runPromise(effect),
      });
      if (shutdownAdmissionClosed) canvasControl.beginShutdown();
    } catch (error) {
      console.error("[canvas-control] failed to start:", error);
      exitAfterDetach(1, "canvas-control-startup-failure");
      return;
    }
    // Every installation owns one scheduler and Station API listener. Kernel
    // start is idempotent with the IPC startup path; invoking it here makes the
    // headless/zero-window station contract explicit before readiness opens.
    try {
      kernelService = await AppRuntime.runPromise(KernelService);
      kernelService.start();
      stationControl = await startStationControlServer({
        home: termControlHome,
        appVersion: app.getVersion(),
        stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        run: (effect) => AppRuntime.runPromise(effect),
        localHandoffAuthority:
          makeOwnerLocalStationControlHandoffAuthority(),
        readiness: () => ({
          database: true,
          workControl: workControlReadiness.ready(),
          simulation: true,
        }),
      });
      const [stationApi, work] = await Promise.all([
        AppRuntime.runPromise(StationApiService),
        AppRuntime.runPromise(WorkRepository),
      ]);
      stationRemoteReportPump = startStationRemoteReportPump({
        api: stationApi,
        stations,
        work,
        control: stationControl,
      });
      if (shutdownAdmissionClosed) {
        stationRemoteReportPumpShutdown ??= stationRemoteReportPump.close();
        stationControl.beginShutdown();
      }
    } catch (error) {
      console.error("[station-control] failed to start:", error);
      exitAfterDetach(1, "station-control-startup-failure");
      return;
    }
    // Local term control UDS — Remote stations expose this for CC SSH forward.
    try {
      await termPlane.start({ controlHome: termControlHome });
    } catch (error) {
      console.error("[term] control socket failed to start:", error);
    }
    powerMonitor.on("resume", () => {
      void (async () => {
        await coordinator.wakeMonitoring();
        if (productRuntimeSuspended) return;
        void AppRuntime.runPromise(
          Effect.flatMap(HerdrPlane, (plane) => plane.warm),
        ).catch(() => {
          console.error("[herdr] resume warm failed");
        });
        try {
          browserComposition?.registry.reapAfterResume();
        } catch {
          console.error("[browser-automation] resume reap failed");
        }
      })().catch(() => {
        console.error("[license] resume recheck failed");
      });
    });
    powerMonitor.on("unlock-screen", () => {
      void coordinator.wakeMonitoring().catch(() => {
        console.error("[license] unlock recheck failed");
      });
    });
    if (process.platform === "darwin") {
      licenseClockChangeSubscription ??=
        systemPreferences.subscribeLocalNotification(
          "NSSystemClockDidChangeNotification",
          () => {
            void coordinator.wakeMonitoring().catch(() => {
              console.error("[license] clock-change recheck failed");
            });
          },
        );
    }

    // Browser authority stays private until cold profile recovery completes.
    // The activation callback is the only place browser IPC, agent IPC, or
    // the local control socket can become reachable.
    try {
      if (headless) await browserCompositionHost.ensureHeadlessHost();
      browserComposition = await startBrowserComposition(
        async (composition) => {
          const readCanvasFromCanvases = async (name: string) => {
            try {
              return await AppRuntime.runPromise(
                Effect.flatMap(CanvasesService, (canvases) =>
                  Effect.map(canvases.read(name), (result) => result.doc),
                ),
              );
            } catch {
              return undefined;
            }
          };
          const listCanvasDocuments = async () => {
            try {
              return await AppRuntime.runPromise(
                Effect.flatMap(CanvasesService, (canvases) =>
                  Effect.map(canvases.liveDocuments(), (rows) =>
                    rows.map((r) => ({ name: r.canvasName, doc: r.doc })),
                  ),
                ),
              );
            } catch {
              return [];
            }
          };
          const stationAdmission =
            await prepareDefaultBrowserStationAdmissionAuthority();
          const edgeGrant = makeEdgeGrantService({
            capabilities: composition.registry,
            resolvePageTarget: resolveBrowserPageTarget,
            listCanvasDocuments,
            station: () => composition.sessions.stationIdentity(),
            admitBrowserHost: (hostId) => composition.sessions.admitAutomationHost(hostId),
            admitStation: stationAdmission.admit,
            // Edge-delete (I10): same destroy path as capability terminate, but
            // keyed by (owner, page-ref) so sibling edges stay live.
            sessions: {
              destroyOwnerTargetSessions: (owner, ref, reason) =>
                composition.sessions.destroyOwnerTargetSessions(owner, ref, reason),
            },
          });
          let canvasUnsubscribe: (() => void) | undefined;
          let admissionCleanupRan = false;
          const stationUnsubscribe = stationAdmission.subscribe(() => {
            edgeGrant.clear();
          });
          unsubscribeCanvasEdgeGrants = () => {
            if (admissionCleanupRan) return;
            admissionCleanupRan = true;
            stationUnsubscribe();
            stationAdmission.close();
            canvasUnsubscribe?.();
            edgeGrant.clear();
          };
          const acquiredCanvasUnsubscribe = await AppRuntime.runPromise(
            Effect.flatMap(CanvasesService, (canvases) =>
              Effect.sync(() =>
                canvases.subscribeChanges((name, detail) => {
                  edgeGrant.invalidateCanvas(name, detail);
                }),
              ),
            ),
          );
          if (admissionCleanupRan) acquiredCanvasUnsubscribe();
          else canvasUnsubscribe = acquiredCanvasUnsubscribe;

          browserControl = await startBrowserControlServer({
            sessions: composition.sessions,
            capabilities: composition.registry,
            resolvePageTarget: resolveBrowserPageTarget,
            version: app.getVersion(),
            home: browserControlHome,
            edgeGrant,
            listCanvasDocuments,
          });
          const productPath = makeElectronBrowserReadinessProductPath({
            compositionHost: browserCompositionHost,
            viewAdapter: browserViewAttachmentTarget.adapter,
          });
          uninstallBrowserReadinessProbe?.();
          uninstallBrowserReadinessProbe = installBrowserProductPathProbe(
            makeBrowserProductPathProbe({
              station: () => {
                const identity = composition.sessions.stationIdentity();
                const host = identity === undefined ? undefined : findHostById(identity.hostId);
                const hostId = identity?.hostId ?? "";
                return {
                  role: identity?.role ?? "",
                  hostId,
                  browserCapabilityDeclared: host !== undefined && hostHasCapability(host, "browser"),
                  controlReady: browserControl !== undefined,
                  controlHostId: browserControl === undefined ? "" : hostId,
                  registeredRemoteHostId: host?.kind === "remote" ? host.id : "",
                  sandboxReady: !app.commandLine.hasSwitch("no-sandbox") && !app.commandLine.hasSwitch("disable-setuid-sandbox"),
                  displayReady: browserCompositionHost.current() !== undefined,
                };
              },
              productPath,
            }),
          );
          composition.bindControlShutdown(browserControl);
          registerBrowserIpcHandlers(composition.sessions);
        },
        {
          state: await AppRuntime.runPromise(StateEngine),
          viewAdapter: browserViewAttachmentTarget.adapter,
          primaryCredentialHealth: () => electronSecurityPolicyHealthy({
            policyPath: app.isPackaged
              ? packagedElectronSecurityPolicyPath(process.resourcesPath)
              : developmentElectronSecurityPolicyPath(import.meta.url),
            electronVersion: process.versions.electron,
            observationPath: app.isPackaged ? packagedElectronObservationPath(process.resourcesPath) : undefined,
            observationHighWaterPath: app.isPackaged ? packagedElectronObservationHighWaterPath(process.resourcesPath) : undefined,
          }),
        },
      );
      if (shutdownAdmissionClosed) {
        browserShutdown ??= browserComposition?.drainOnQuit(shutdownReason);
        return;
      }
    } catch {
      browserComposition = undefined;
      unsubscribeCanvasEdgeGrants?.();
      unsubscribeCanvasEdgeGrants = undefined;
      try {
        browserControl?.close();
      } catch {
        // Startup is already failing closed; socket cleanup stays best-effort.
      }
      browserControl = undefined;
      try {
        workControl?.close();
      } catch {
        // best-effort
      }
      workControl = undefined;
      console.error(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
      exitAfterDetach(1, "browser-composition-startup-failure");
      return;
    }

    productRuntimeStarted = true;
    operatorFleetReady = true;
    await coordinator.startMonitoring();
    if (!productRuntimeSuspended) {
      nodeRefOwnerReady = true;
      activatePendingNodeRef();
    }
    rendererWindowAdmissionReady = true;
    if (!headless) createWindow();
  })
    .catch(async (error) => {
      console.error("[startup] initialization failed:", error);
      // GUI: native dialog with data-safe next step. Headless: log only.
      // Schema-too-new is handled earlier; this covers StateEngine open and
      // other pre-window product startup failures.
      try {
        await runStartupStateFailureDialog({ error, headless });
      } catch (dialogError) {
        console.error("[startup] failure dialog failed:", dialogError);
      }
      exitAfterDetach(1, "startup-failure");
    });
}

// WINDOW CLOSE ≠ QUIT on macOS: last window close leaves the app running —
// kernel, region watchers/timers, and control sockets stay live with zero
// windows. Dock icon remains; activate recreates the window.
// Non-darwin still quits when all windows close (platform convention).
app.on("window-all-closed", () => {
  quitWhenNoOperatorWindow();
});

const quitWhenNoOperatorWindow = (): void => {
  if (
    process.platform !== "darwin" &&
    currentTrustedMainWindow() === undefined &&
    !signalRendererDestroyInProgress &&
    !rendererRecoveryDestroyInProgress &&
    !signalQuitState.rendererQuiesced() &&
    !quitPreparationArbiter.committed()
  ) app.quit();
};

const beginShutdownAdmission = (reason: string): void => {
  shutdownReason = reason;
  if (shutdownAdmissionClosed) return;
  shutdownAdmissionClosed = true;
  operatorFleetReady = false;
  // Close kernel scheduling at the same synchronous, one-way admission cut.
  // No product teardown may strand work claimed by a later kernel cycle.
  kernelService?.suspend();
  licenseCoordinator?.stopMonitoring();
  if (licenseClockChangeSubscription !== undefined) {
    systemPreferences.unsubscribeLocalNotification(
      licenseClockChangeSubscription,
    );
    licenseClockChangeSubscription = undefined;
  }
  nodeRefOwnerReady = false;
  pendingNodeRefUri = undefined;
  activeNodeRefDelivery = undefined;
  disconnectNodeRefIngress();
  disconnectNodeRefIngress = () => undefined;
  unsubscribeCanvasEdgeGrants?.();
  unsubscribeCanvasEdgeGrants = undefined;

  // Browser product lock: quit detaches owned browser views and closes
  // automation/control admission only through the aggregate composition drain.
  browserShutdown ??= browserComposition?.drainOnQuit(reason);
  hermesShutdown ??= hermesPlaneService?.shutdown.drainOnQuit();
  adapterShutdown ??= terminateAdapterChildrenOnQuit();
  beginBoxProcessShutdown();
  beginStationFleetPropagationShutdown();

  operatorControl?.beginShutdown();
  workControl?.beginShutdown();
  stationRemoteReportPumpShutdown ??= stationRemoteReportPump?.close();
  stationControl?.beginShutdown();
  hostOperationsShutdown.beginShutdown();
  termPlane.beginShutdown(reason);
  herdrPlaneService?.beginShutdown();
  appProcessPlane.beginShutdown();
};

const ensureMainAuthoringPrecommit = (): number => {
  if (mainAuthoringPrecommitEpoch !== undefined) return mainAuthoringPrecommitEpoch;
  const precommit = mainAuthoringGate.beginPrecommit();
  mainAuthoringPrecommitEpoch = precommit.epoch;
  return precommit.epoch;
};

const recoverMainAuthoringPrecommit = (): void => {
  const epoch = mainAuthoringPrecommitEpoch;
  if (epoch === undefined) return;
  mainAuthoringPrecommitEpoch = undefined;
  try {
    mainAuthoringGate.recover(epoch);
  } catch {
    // Recovery is best-effort only after a failed quit attempt. The caller
    // still uses quiesced/committed state to decide whether authoring may reopen.
  }
};

const commitMainAuthoringOnQuit = async (): Promise<void> => {
  // Activation-only and revoked renderers never own a live authoring surface.
  // Waiting for a canvas flush there would strand quit on an IPC channel that
  // was intentionally never opened (or has already been revoked).
  if (!productRuntimeStarted || productRuntimeSuspended) return;
  const epoch = ensureMainAuthoringPrecommit();
  const preDrain = await mainAuthoringGate.drain(epoch);
  if (!preDrain.clean) {
    throw new Error(
      `main authoring pre-drain retained ${preDrain.activeLabels.join(", ") || "unknown work"}`,
    );
  }
  const mainWindow = trustedMainWindow;
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    await requestCanvasQuiesceAndFlush(mainWindow, epoch);
  }
  const postDrain = await mainAuthoringGate.drain(epoch);
  if (!postDrain.clean) {
    throw new Error(
      `main authoring post-drain retained ${postDrain.activeLabels.join(", ") || "final write authority"}`,
    );
  }
  mainAuthoringGate.commit(epoch);
};

let runtimeDetachedForQuit = false;

const detachRuntimeOnQuit = (reason: string): void => {
  if (runtimeDetachedForQuit) return;
  if (quitPreparationArbiter.signalPrecommit()) {
    throw new Error("runtime detach blocked before signal durability commit");
  }
  runtimeDetachedForQuit = true;
  licenseCoordinator?.stopMonitoring();
  unregisterLicenseIpc?.();
  unregisterLicenseIpc = undefined;
  // Canvas control cannot reopen. Cut it only after the renderer/document
  // durability boundary is irreversible, never during a recoverable precommit.
  canvasControl?.beginShutdown();
  beginShutdownAdmission(reason);
  nodeRefOwnerReady = false;
  pendingNodeRefUri = undefined;
  activeNodeRefDelivery = undefined;
  disconnectNodeRefIngress();
  disconnectNodeRefIngress = () => undefined;
};

let runtimeDispose: Promise<void> | undefined;
let runtimeDisposed = false;

const requireCleanBrowserShutdown = async (reason: string): Promise<void> => {
  const receipt = await (browserShutdown ??= browserComposition?.drainOnQuit(reason));
  if (receipt !== undefined) {
    if (!receipt.clean) {
      browserShutdown = undefined;
      throw new Error(
        `browser shutdown retained automation state${receipt.timedOut ? " (deadline)" : ""}`,
      );
    }
    browserControl = undefined;
    uninstallBrowserReadinessProbe?.();
    uninstallBrowserReadinessProbe = undefined;
    browserComposition = undefined;
    unsubscribeCanvasEdgeGrants?.();
    unsubscribeCanvasEdgeGrants = undefined;
  }
  await browserCompositionHost.shutdown();
};

const requireCleanWorkControlShutdown = async (): Promise<void> => {
  if (workControl === undefined && workControlShutdown === undefined) return;
  const receipt = await (workControlShutdown ??= workControl?.drainOnQuit());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    workControlShutdown = undefined;
    throw new Error(
      `work control shutdown retained ${receipt.retainedLabels.join(", ") || "transport state"}`,
    );
  }
  workControl = undefined;
};

const requireCleanOperatorControlShutdown = async (): Promise<void> => {
  if (operatorControl === undefined && operatorControlShutdown === undefined) {
    return;
  }
  const receipt = await (operatorControlShutdown ??= operatorControl?.close());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    operatorControlShutdown = undefined;
    throw new Error(
      `operator control shutdown retained ${receipt.retainedLabels.join(", ") || "transport state"}`,
    );
  }
  operatorControl = undefined;
};

const requireCleanStationControlShutdown = async (): Promise<void> => {
  if (stationControl === undefined && stationControlShutdown === undefined) {
    return;
  }
  const receipt = await (stationControlShutdown ??= stationControl?.close());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    stationControlShutdown = undefined;
    throw new Error(
      `station control shutdown retained ${
        [
          receipt.pendingDispatches > 0
            ? `${receipt.pendingDispatches} dispatch(es)`
            : "",
          receipt.openSockets > 0
            ? `${receipt.openSockets} socket(s)`
            : "",
          receipt.listenerRetained ? "listener" : "",
          receipt.socketPathRetained ? "socket path" : "",
        ].filter(Boolean).join(", ") || "transport state"
      }`,
    );
  }
  stationControl = undefined;
};

const requireCleanStationRemoteReportPumpShutdown = async (): Promise<void> => {
  if (
    stationRemoteReportPump === undefined &&
    stationRemoteReportPumpShutdown === undefined
  ) {
    return;
  }
  await (stationRemoteReportPumpShutdown ??= stationRemoteReportPump?.close());
  stationRemoteReportPump = undefined;
};

const requireCleanStationFleetPropagationShutdown =
  async (): Promise<void> => {
    if (
      stationFleetPropagationService === undefined &&
      stationFleetPropagationShutdown === undefined
    ) {
      return;
    }
    beginStationFleetPropagationShutdown();
    await stationFleetPropagationShutdown;
    stationFleetPropagationService = undefined;
  };

const requireCleanCanvasControlShutdown = async (): Promise<void> => {
  if (canvasControl === undefined && canvasControlShutdown === undefined) {
    return;
  }
  const receipt = await (canvasControlShutdown ??= canvasControl?.close());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    canvasControlShutdown = undefined;
    throw new Error(
      `canvas control shutdown retained ${
        receipt.retainedLabels.join(", ") || "transport state"
      }`,
    );
  }
  canvasControl = undefined;
};

const requireCleanHostOperationsShutdown = async (): Promise<void> => {
  const receipt = await (hostOperationsDrain ??= hostOperationsShutdown.drainOnQuit());
  if (!receipt.clean) {
    hostOperationsDrain = undefined;
    throw new Error(
      `host operations shutdown retained ${receipt.retainedLabels.join(", ") || "active work"}`,
    );
  }
};

const formatTermPlaneRetention = (
  receipt: Awaited<ReturnType<typeof termPlane.drainOnQuit>>,
): string =>
  [
    ...receipt.retainedLabels,
    ...receipt.diagnostics,
    ...(receipt.control !== undefined && !receipt.control.clean
      ? receipt.control.retainedLabels.map((label) => `control:${label}`)
      : []),
  ]
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
    .join("; ");

const requireCleanTermPlaneShutdown = async (reason: string): Promise<void> => {
  const receipt = await (termPlaneShutdown ??= termPlane.drainOnQuit(reason));
  if (receipt.clean) return;
  // Bounded unclean receipts are observations, not permanent facts. Clear so
  // a later Cmd+Q / signal can re-drain after stragglers exit or path races end.
  termPlaneShutdown = undefined;
  const detail = formatTermPlaneRetention(receipt) || "unknown resource";
  // Control UDS / remote-router dirt must not trap the operator. Only
  // host-owned local PTY generations may block exit (machine safety).
  if (!termPlaneBlocksAppExit(receipt)) {
    console.error(
      `[term] quit continues with non-host terminal retention (${reason}): ${detail}`,
    );
    return;
  }
  throw new Error(`terminal plane shutdown retained ${detail}`);
};

const requireCleanHerdrShutdown = async (): Promise<void> => {
  if (herdrPlaneService === undefined && herdrShutdown === undefined) return;
  const receipt = await (herdrShutdown ??= herdrPlaneService?.drainOnQuit());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    herdrShutdown = undefined;
    throw new Error(
      `herdr shutdown retained ${receipt.retained} component resource(s)`,
    );
  }
};

const requireCleanHermesShutdown = async (): Promise<void> => {
  if (hermesPlaneService === undefined && hermesShutdown === undefined) return;
  const receipt = await (hermesShutdown ??= hermesPlaneService?.shutdown.drainOnQuit());
  if (receipt === undefined) return;
  if (!receipt.clean) {
    hermesShutdown = undefined;
    throw new Error(
      `hermes shutdown retained ${receipt.teardowns.length} teardown receipt(s)`,
    );
  }
};

const requireCleanAdapterShutdown = async (): Promise<void> => {
  const receipt = await (adapterShutdown ??= terminateAdapterChildrenOnQuit());
  if (!receipt.settled) {
    adapterShutdown = undefined;
    throw new Error(`adapter shutdown retained ${receipt.pending} operation(s)`);
  }
};

const requireCleanAppProcessShutdown = async (): Promise<void> => {
  const receipt = await (appProcessShutdown ??= appProcessPlane.drainOnQuit());
  if (!receipt.clean) {
    appProcessShutdown = undefined;
    const retained = receipt.stragglers
      .map((rec) =>
        `${rec.source}:${rec.purpose}@${rec.generation}${rec.pid === undefined ? "" : ` pid=${rec.pid}`}`
      )
      .join(", ");
    throw new Error(
      `app process shutdown retained ${receipt.stragglers.length} child generation(s): ${retained}`,
    );
  }
};

const drainRuntimeOnQuit = async (reason: string): Promise<void> => {
  await requireCleanOperatorControlShutdown();
  await requireCleanTermPlaneShutdown(reason);
  await requireCleanCanvasControlShutdown();
  await requireCleanStationRemoteReportPumpShutdown();
  await requireCleanStationFleetPropagationShutdown();
  await requireCleanStationControlShutdown();
  await requireCleanWorkControlShutdown();
  await requireCleanHostOperationsShutdown();
  await requireCleanBrowserShutdown(reason);
  await requireCleanHermesShutdown();
  await requireCleanHerdrShutdown();
  await requireCleanAdapterShutdown();
  await requireCleanAppProcessShutdown();
};

const disposeRuntime = (): Promise<void> => {
  // Soft dispose for ordinary quit: log failures but still resolve so the
  // native quit sequence can continue after best-effort teardown.
  runtimeDispose ??= drainRuntimeOnQuit(shutdownReason)
    .then(() => AppRuntime.dispose())
    .finally(releaseDemoRuntimeIsolation)
    .catch((error) => {
      console.error("[runtime] dispose failed:", error);
    });
  return runtimeDispose;
};

/**
 * Fail-closed dispose for update preflight. SQLite must be released before
 * the candidate opens the canonical state path — swallow is not allowed.
 */
const disposeRuntimeFailClosed = (reason: string): Promise<void> => {
  if (runtimeDisposed) return Promise.resolve();
  const work = drainRuntimeOnQuit(reason)
    .then(() => AppRuntime.dispose())
    .finally(releaseDemoRuntimeIsolation);
  // Share the singleton so a later soft dispose does not re-enter.
  runtimeDispose ??= work.catch((error) => {
    console.error(`[runtime] dispose failed (${reason}):`, error);
    throw error;
  });
  return work;
};

/** An app exit is authorized only after every owned local child reports exit. */
const requireCleanLocalTerminalShutdown = async (reason: string): Promise<void> => {
  beginShutdownAdmission(reason);
  await requireCleanTermPlaneShutdown(reason);
};

// Electron app.exit() bypasses before-quit and will-quit. Every direct exit
// therefore routes through the same authority/process teardown explicitly.
const exitAfterDetach = (exitCode: number, reason: string): void => {
  void requireCleanLocalTerminalShutdown(reason)
    .then(() => {
      detachRuntimeOnQuit(reason);
      return disposeRuntime();
    })
    .then(() => {
      runtimeDisposed = true;
      app.exit(exitCode);
    })
    .catch((error) => {
      quitConfirmed = false;
      skipQuitConfirm = false;
      recreateWindowIfEmpty();
      console.error(`[term] direct exit blocked (${reason}):`, error);
    });
};

let quitPreparation: Promise<void> | undefined;

const beginSignalCanvasQuiesceAndFlush = async (generation: number): Promise<void> => {
  // Authorization belongs to this signal attempt, never to an earlier normal
  // quit. A second signal after the app remained open must prove current
  // renderer state durable again.
  await commitMainAuthoringOnQuit();
  if (!signalQuitState.isCurrent(generation)) {
    throw new Error("signal shutdown attempt superseded");
  }
};

/** Destroy the already-gated renderer synchronously after its final ACK. */
const destroyQuiescedRenderer = (): void => {
  const mainWindow = trustedMainWindow;
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    signalQuiescedWindows.add(mainWindow);
    signalRendererDestroyInProgress = true;
    try {
      try {
        // destroy() is synchronous and bypasses the renderer unload path. The
        // WeakSet bypass above also prevents the ordinary close-flush handler
        // from starting a second, no-longer-final flush.
        mainWindow.destroy();
      } catch (error) {
        if (!mainWindow.isDestroyed()) throw error;
      }
      if (!mainWindow.isDestroyed()) {
        signalQuiescedWindows.delete(mainWindow);
        throw new Error("trusted renderer did not quiesce synchronously");
      }
    } finally {
      signalRendererDestroyInProgress = false;
    }
  }
};

/** Stop trusted renderer authoring synchronously after its signal final ACK. */
const quiesceSignalRenderer = (generation: number): void => {
  if (!signalQuitState.isCurrent(generation)) {
    throw new Error("signal shutdown attempt superseded");
  }
  destroyQuiescedRenderer();
  // Headless and already-windowless stations have no authoring renderer.
  signalQuitState.markRendererQuiesced(generation);
};

const collectLiveWorkSnapshot = () =>
  assessLiveWork({
    attachedHerdrStreamCount: herdrActiveControlCount(),
    localTerminalSessionCount: termPlane.router.runningCount(),
  });

/** Cancel left the process with no UI — give the operator a surface back. */
const recreateWindowIfEmpty = (): void => {
  if (headless || runtimeDisposed) return;
  if (currentTrustedMainWindow() === undefined) createWindow();
};

const invalidateQuitConfirm = (): void => {
  quitConfirmGeneration += 1;
  quitConfirmPending = false;
};

app.on("before-quit", (event) => {
  if (runtimeDisposed) return;
  event.preventDefault();
  // A signal owns the global quit sequence until its terminal + renderer
  // durability boundaries commit. Do not consume its intent or start a
  // competing normal continuation during either async precommit interval.
  if (quitPreparationArbiter.signalPrecommit()) return;
  // Flush/dispose already running — do not re-enter. Confirm dialog does NOT
  // own quitPreparation, so a signal can still force through while a dialog is open.
  if (quitPreparation !== undefined) return;

  // Sacred order: terminal clean, final renderer gate+drain, synchronous
  // commit/destroy, runtime detach, then dispose.
  const beginQuitPreparation = (durableSignalGeneration?: number): void => {
    if (runtimeDisposed || quitPreparation !== undefined) return;
    const preparationGeneration = quitPreparationArbiter.beginNormal();
    if (preparationGeneration === undefined) return;
    const canvasAlreadyDurable =
      durableSignalGeneration !== undefined &&
      signalQuitState.reusableDurabilityGeneration() === durableSignalGeneration;
    quitPreparation = runNormalQuitPreparation(
      quitPreparationArbiter,
      preparationGeneration,
      {
        terminalClean: () => requireCleanLocalTerminalShutdown("before-quit"),
        finalRendererQuiesce: async () => {
          if (canvasAlreadyDurable) return;
          await commitMainAuthoringOnQuit();
        },
        destroyRenderer: destroyQuiescedRenderer,
        detachRuntime: () => {
          detachRuntimeOnQuit("before-quit");
        },
        disposeRuntime,
      },
    )
      .then((mayFinish) => {
        if (!mayFinish) return;
        runtimeDisposed = true;
        closeWindowsWithoutCanvasFlush = true;
        app.quit();
      })
      .catch((error) => {
        if (quitPreparationArbiter.normalCommitted(preparationGeneration)) {
          // Renderer admission is closed and runtime teardown may already be
          // partial. Never resurrect a writable UI over that committed state;
          // a later signal joins this proof and supplies the bounded fallback.
          console.error("[quit] committed normal teardown stalled:", error);
          return;
        }
        if (error instanceof CanvasQuiesceAndFlushError && error.quiesced) {
          quitPreparationArbiter.observeRendererGateQuiesced();
        }
        quitPreparationArbiter.recoverNormal(preparationGeneration);
        if (quitPreparationArbiter.signalPrecommit()) return;
        // A committed signal may have entered this normal continuation through
        // app.quit(). Preserve its durable generation and bounded fallback.
        if (signalQuitState.forceExitAllowed()) {
          console.error("[quit] committed signal teardown stalled; fallback retained:", error);
          return;
        }
        quitPreparation = undefined;
        quitConfirmed = false;
        // Never leave skip sticky after a failed prep — next Cmd+Q must be honest.
        skipQuitConfirm = false;
        if (quitPreparationArbiter.rendererGateQuiesced()) {
          // The renderer latch is process-lifetime and cannot honestly reopen.
          // Retain the surface for a retry (or a later signal takeover), but
          // never represent this as restored authoring or recreate a new gate.
          console.error("[canvas] quiesced canvas drain must retry before normal quit:", error);
          return;
        }
        recoverMainAuthoringPrecommit();
        recreateWindowIfEmpty();
        console.error("[canvas] quit blocked:", error);
      });
  };

  // Signal / headless / already-confirmed: no dialog; same flush→detach path.
  // skipQuitConfirm is consumed once so a failed signal quit cannot permanently
  // silence the honest affordance on a later Cmd+Q.
  if (skipQuitConfirm || headless || quitConfirmed) {
    const durableSignalGeneration = skipQuitConfirm
      ? signalQuitState.reusableDurabilityGeneration()
      : undefined;
    invalidateQuitConfirm();
    skipQuitConfirm = false;
    quitConfirmed = true;
    beginQuitPreparation(durableSignalGeneration);
    return;
  }

  // Second Cmd+Q while the confirm is open: swallow (still preventDefault).
  if (quitConfirmPending) return;

  const live = collectLiveWorkSnapshot();
  if (!hasLiveWork(live)) {
    quitConfirmed = true;
    beginQuitPreparation();
    return;
  }

  // Honest quit: one confirm naming what pauses vs what survives (herdr never killed).
  // Dialog does not set quitPreparation — signals must be able to supersede it.
  const prompt = buildQuitConfirmPrompt(live);
  const parent = trustedMainWindow;
  const dialogOptions = {
    type: prompt.type,
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons] as string[],
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId,
    noLink: prompt.noLink,
  };
  const generation = quitConfirmGeneration;
  quitConfirmPending = true;
  const box =
    parent !== undefined && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, dialogOptions)
      : dialog.showMessageBox(dialogOptions);

  void box
    .then((result) => {
      if (generation !== quitConfirmGeneration) return;
      quitConfirmPending = false;
      if (result.response !== QUIT_CONFIRM_ACCEPT_INDEX) {
        quitConfirmed = false;
        // non-darwin last-window quit → dialog cancel must not leave a UI zombie.
        recreateWindowIfEmpty();
        return;
      }
      quitConfirmed = true;
      beginQuitPreparation();
    })
    .catch((error) => {
      if (generation !== quitConfirmGeneration) return;
      quitConfirmPending = false;
      quitConfirmed = false;
      skipQuitConfirm = false;
      console.error("[quit] confirm dialog failed:", error);
    });
});

app.on("will-quit", () => {
  detachRuntimeOnQuit("will-quit");
});

// Registered SIGTERM/SIGINT listeners suppress Node's default process exit.
// Detach authority first, request Electron's normal quit sequence, and retain
// a bounded hard-exit fallback if another listener prevents that sequence.
installProcessSignalTermination({
  app,
  cleanup: async (signal) => {
    const signalClaim = quitPreparationArbiter.claimSignal();
    if (signalClaim === "joined-normal") {
      // Normal quit already committed renderer destruction + runtime detach
      // synchronously. Preserve its in-flight dispose promise; resolving this
      // cleanup adds only the signal's bounded native-loop fallback.
      return;
    }
    let generation: number;
    try {
      generation = signalQuitState.begin();
    } catch (error) {
      quitPreparationArbiter.recoverSignal();
      throw error;
    }
    // Existing normal continuations retain an invalidated arbiter epoch, but
    // the shared slot must be free for the committed signal's later app.quit.
    quitPreparation = undefined;
    // Signals are forced exits — never the honest-quit dialog. Invalidate any
    // open confirm so accept after cancel race cannot fight the force path.
    invalidateQuitConfirm();
    try {
      await requireCleanLocalTerminalShutdown(signal);
      signalQuitState.markTerminalClean(generation);
      // This is the final canvas boundary for the signal attempt. The
      // renderer closes authoring and drains admitted writes before its ack;
      // main then destroys that already-quiesced surface synchronously.
      await beginSignalCanvasQuiesceAndFlush(generation);
      signalQuitState.markCanvasDurable(generation);
      quiesceSignalRenderer(generation);
      signalQuitState.authorizeForceExit(generation);
      quitPreparationArbiter.commitSignal();
      skipQuitConfirm = true;
      detachRuntimeOnQuit(signal);
      signalQuitState.markRuntimeDetached(generation);
    } catch (error) {
      if (
        error instanceof CanvasQuiesceAndFlushError &&
        error.quiesced &&
        signalQuitState.isCurrent(generation) &&
        signalQuitState.snapshot().phase === "terminal-clean"
      ) {
        signalQuitState.markRendererGateQuiesced(generation);
      }
      const disposition = signalQuitState.fail(generation);
      if (disposition === "recover") {
        recoverMainAuthoringPrecommit();
        quitPreparationArbiter.recoverSignal();
        skipQuitConfirm = false;
        quitConfirmed = false;
        recreateWindowIfEmpty();
        console.error(`[quit] signal attempt blocked (${signal}):`, error);
        throw error;
      }
      if (disposition === "retry") {
        quitPreparationArbiter.recoverSignal();
        skipQuitConfirm = false;
        quitConfirmed = false;
        console.error(`[quit] quiesced canvas drain must retry (${signal}):`, error);
        throw error;
      }
      if (disposition === "stale") {
        if (quitPreparationArbiter.signalPrecommit()) {
          quitPreparationArbiter.recoverSignal();
        }
        throw error;
      }
      if (quitPreparationArbiter.signalPrecommit()) {
        quitPreparationArbiter.commitSignal();
      }
      skipQuitConfirm = true;
      // Quiescence made the document final. Resolve cleanup so the installer
      // arms its referenced fallback even if runtime detachment threw midway.
      console.error(`[quit] committed signal teardown stalled (${signal}):`, error);
    }
  },
  // app.exit bypasses before-quit. A signal may force the native loop only
  // after the renderer has acknowledged a durable canvas flush. Runtime
  // disposal may itself hang; once the document is safe, the bounded fallback
  // can still terminate that native/service teardown stall.
  allowForceExit: () =>
    signalQuitState.forceExitAllowed() || quitPreparationArbiter.committed(),
});
