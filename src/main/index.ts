import "./junto/preview-home";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  protocol,
  session,
  shell,
  type IpcMainEvent,
} from "electron";
import { classifyBrowserTarget } from "@shared/browser-policy";
import {
  IPC_CHANNELS,
  type CanvasFlushResult,
  type CanvasQuiesceAndFlushResult,
  type MenuYield,
  type NodeRefOpenedDelivery,
} from "@shared/ipc";
import { overlayManifest } from "@shared/overlay";
import { PRODUCT_NAME } from "@shared/product-name";
import { keyboardSettings, type Settings } from "@shared/settings";
import { DARK_RUNTIME } from "@shared/theme";
import type { PreambleEvent } from "@shared/preamble";
import type { AgentSignal } from "@shared/agent-signals";
import {
  resolveJuntoHome,
  shouldPinUnpackagedElectronUserData,
  unpackagedElectronUserDataPath,
} from "@shared/junto-home";
import {
  resolvedSpawnEnv,
  terminateAdapterChildrenOnQuit,
} from "./junto/adapters/exec";
import { appMenuTemplate } from "./junto/app-menu";
import { appProcessBlocksAppExit, appProcessPlane, describeAppProcessStraggler } from "./junto/app-process-plane";
import { AppRuntime } from "./runtime";
import { core } from "./core-process/main-client";
import { startChildren, takeChildStopFailures, type Children } from "./core-process/children";
import { subscribe as subscribeCore } from "./core-process/push";
import { AGENT_SIGNAL_CHANGED, CANVAS_CHANGED, COMPANION_DEVICES, SETTINGS_CHANGED, WORK_PREAMBLE, type CanvasChangedPush } from "./core-process/channels";
import { coreBrowserProfileStore, coreTouchedOriginStore } from "./core-process/main-side/browser";
import { raisedHands } from "./junto/signals/raised-hands";
import { armMainThreadBudget } from "./junto/observability/main-thread-budget";
import {
  installMachineLog,
  installObservabilityConsoleHook,
  recordRendererConsole,
  recordSystemLog,
} from "./junto/observability/logger";
import { startSqlTimingLog } from "./junto/observability/sql-timing-log";
import { releaseDemoRuntimeIsolation } from "./junto/demo/runtime-isolation";
import { registerBrowserIpcHandlers, registerIpcHandlers } from "./ipc";
import { resolveControlHome } from "./junto/control-home";
import { registerDemoIpcHandlers } from "./junto/demo/ipc";
import { registerNotificationIpc } from "./junto/notifications/ipc";
import type { NotificationPlane } from "./junto/notifications/plane";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  startBrowserComposition,
  type BrowserComposition,
} from "./junto/browser/composition";
import { makeBrowserCompositionHost } from "./junto/browser/composition-host";
import { makeElectronBrowserViewAttachmentTarget } from "./junto/browser/view-adapter";
import { applyInterfaceScale, followInterfaceScale, refitInterfaceScale } from "./junto/interface-scale";
import {
  BROWSER_ENABLED,
  LIVE_OVERSEER_ENABLED,
} from "@shared/features";
import { configureTerminalRouterLayeredRunner, sshTransportRouterRunner } from "./junto/term/router";
import { resolveBrowserPageTarget } from "./junto/browser/ipc";
import { startBrowserControlServer, type BrowserControlServer } from "./junto/browser/control";
import {
  captureTrustedWindowPng,
} from "./junto/overseer/composition";
import { registerOverseerLiveIpc } from "./junto/overseer/live/ipc";
import { makeEdgeGrantService } from "./junto/browser/edge-grant";
import { evaluateSchemaCompatibility } from "./junto/state/schema-version-probe";
import { runStartupStateFailureDialog } from "./junto/state/startup-state-failure-dialog";
import { ensureSchemaCompatibleOrRecover } from "./junto/update/startup-schema-recovery";
import { installBrowserEgressProxyAuth } from "./junto/browser/partition-network";
import { isManagedBrowserWebContents } from "./junto/browser/web-policy";
import {
  canonicalNodeRefUri,
  latestNodeRefUri,
  makeNodeRefIngress,
} from "./junto/node-ref-ingress";
import type { NodeRefKey } from "@shared/node-ref";
import {
  createQuitPreparationArbiter,
  createSignalQuitState,
  installProcessSignalTermination,
  runNormalQuitPreparation,
} from "./junto/process-signal-termination";
import { createQuitPhaseLog } from "./junto/quit-phase-log";
import { quitMarkerPath, requestLockAfterQuittingHolder, writeQuitMarker } from "./junto/quit-marker";
import { readProcessStartKey } from "./junto/process-identity";
import { readUnsharedProcessStartKey } from "./junto/process-epoch";
import {
  isTrustedMainWebContents,
  setTrustedMainWebContents,
} from "./junto/trusted-main-webcontents";
import { createTrustedRendererNavigation } from "./junto/trusted-renderer-navigation";
import { createRendererSurfaceReadiness } from "./junto/renderer-surface-readiness";
import {
  createRendererSurfaceRecovery,
  resolveRendererSurfaceTimeoutMs,
} from "./junto/renderer-surface-recovery";
import {
  buildQuitConfirmPrompt,
  hasLiveWork,
  probeLiveWork,
  QUIT_CONFIRM_ACCEPT_INDEX,
  type LiveWorkSnapshot,
} from "./junto/quit-live-work";
import { mainAuthoringGate } from "./junto/main-authoring-gate";
import {
  installTrustedRendererPermissionPolicy,
  installTrustedRendererProtocol,
  registerTrustedRendererScheme,
} from "./junto/trusted-renderer-protocol";
import {
  CONTENT_PROTOCOL_SCHEME_REGISTRATION,
  installContentProtocol,
} from "./junto/content/protocol";
import { remoteVideos } from "./junto/preview/remote-video";
import { FILE_PROTOCOL_SCHEME_REGISTRATION, installFileProtocol } from "./junto/files/protocol";
import { makeFilesDraftsSettle } from "./junto/files/drafts-settle";
import { coreFileBytes, registerFilesIpc } from "./junto/files/ipc";
import {
  resolveTrustedRendererOrigin,
  type TrustedRendererOrigin,
} from "@shared/trusted-renderer-origin";
import { loadStationSupervisor } from "./junto/supervision/select";
import { installUpdateHostHooks } from "./junto/update";
import { hostOperationsShutdown } from "./junto/hosts/shutdown";
import {
  operatorControlEnabledFromInitialArgv,
} from "./junto/operator-control";
import {
  companionService,
} from "./junto/companion/service";
import { broadcastCompanionDevices, electronCompanionClipboard, registerCompanionIpc } from "./junto/companion/ipc";
import { coreOverseerLive } from "./core-process/main-side/overseer-live";
import { companionNotePreamble } from "./junto/companion/wiring";
import { askOnEveryCore, askOnLaterCores } from "./core-process/every-core";
import { startCoreProcessForMain } from "./core-process/main-boot";
import { overseerPagesOn, type OverseerPages } from "./junto/overseer/pages";
import { runningBuildIdentity } from "./junto/build-identity";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import { findPackagedSandboxDisablingSwitch } from "./junto/packaged-sandbox-policy";
import {
  applyE2eMacOsFocusIsolation,
  e2eFocusIsolationActive,
  e2eMainWindowOptions,
  e2ePresentationFromEnv,
} from "./junto/e2e-presentation";

// TerminalRouter SSH dials need a runner; bind this process's once, so
// term/router never imports the Electron runtime graph itself.
// AppRuntime is the sole warm ManagedRuntime for main (see runtime.ts):
// boot once → runPromise/runFork with shared Context → dispose on quit.
// Main's router dials on the SSH transport alone: no database, no core service in main.
configureTerminalRouterLayeredRunner(sshTransportRouterRunner());

// A launcher (or wrapper script) can hand this process inherited proxy
// switches, and Chromium re-applies them over Session proxy preferences on
// every NetworkContext creation (ApplyProxyModeFromCommandLine). An inherited
// --no-proxy-server or --proxy-server would therefore restamp a managed
// browser partition to DIRECT, or to an uncontrolled proxy, right after
// preparePartition's session.setProxy() pinned the owned CONNECT proxy.
// Remove the switches from the live command line before any Session can
// exist, and never re-add no-proxy-server here: trusted/default traffic is
// pinned DIRECT after ready instead.
app.commandLine.removeSwitch("no-proxy-server");
app.commandLine.removeSwitch("proxy-server");
app.commandLine.removeSwitch("proxy-bypass-list");
app.commandLine.removeSwitch("proxy-pac-url");
app.commandLine.removeSwitch("proxy-auto-detect");

// Junto is a visual app: the renderer accessibility tree is off. Any macOS
// client that queries the window (password managers, window tools) turns it
// on, and then every pan frame re-serializes the whole canvas (PERF_LEDGER:
// pan main thread 1197 -> 2405 ms per 6 s, 14% of wheel events dropped).
// app.setAccessibilitySupportEnabled(false) does not stick against such a
// client; the switch does. Operator decision, 2026-10-17.
app.commandLine.appendSwitch("disable-renderer-accessibility");

// No back-forward cache: a restore commits with no network round trip, the
// fastest path past a refused start's stop (remote-security). Merged with any
// features already disabled.
{
  const disabled = app.commandLine.getSwitchValue("disable-features").split(",").filter((name) => name !== "");
  if (!disabled.includes("BackForwardCache")) {
    app.commandLine.appendSwitch("disable-features", [...disabled, "BackForwardCache"].join(","));
  }
}

// Managed browser partitions use an app-owned CONNECT proxy. Do not install
// process-wide proxy-server / no-proxy-server switches: they restamp Session
// prefs on NetworkContext create and would either force DIRECT or inherit a
// fleet system proxy. Trusted/default traffic is pinned DIRECT after ready.
// Defense in depth for every renderer, including future windows whose local
// preferences might otherwise drift. This must run before app readiness.
app.enableSandbox();
// Official `bun run dev` sets JUNTO_HOME (~/.junto-dev). Pin Electron
// userData under that home *before* requestSingleInstanceLock so the
// Chromium singleton does not fight the packaged production install.
// Never override --user-data-dir (e2e/probes) or packaged installs.
if (
  shouldPinUnpackagedElectronUserData({
    packaged: app.isPackaged,
    juntoHomeEnv: process.env.JUNTO_HOME,
    hasUserDataDirSwitch: app.commandLine.hasSwitch("user-data-dir"),
  })
) {
  const isolatedUserData = unpackagedElectronUserDataPath(resolveJuntoHome());
  app.setPath("userData", isolatedUserData);
  // Dock / menu bar: still PRODUCT_NAME first for brand lint; "Dev" marks the
  // unpackaged process so it is visually distinct from production.
  app.setName(`${PRODUCT_NAME} Dev`);
}
// Preview is an explicit isolated launch, with visible identity in Dock and title.
const isPreview = process.env.JUNTO_PREVIEW === "1";
if (isPreview) {
  app.setPath("userData", unpackagedElectronUserDataPath(resolveJuntoHome()));
  app.setName(`${PRODUCT_NAME} PREVIEW`);
}
registerTrustedRendererScheme(protocol, [CONTENT_PROTOCOL_SCHEME_REGISTRATION, FILE_PROTOCOL_SCHEME_REGISTRATION]);

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
installBrowserEgressProxyAuth(app);

const nodeRefIngress = makeNodeRefIngress((ref) => core.call("model.resolveNodeRef", { ref }));

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
const headless = process.argv.includes("--junto-headless");
// Freeze this privileged ingress decision from the original process argv.
// A later second-instance event cannot enable it in the running singleton.
const operatorControlEnabledAtLaunch =
  operatorControlEnabledFromInitialArgv(process.argv);

// Playwright E2E needs a real authoring renderer (not --junto-headless), but
// must never steal macOS focus or plant Dock icons. JUNTO_E2E_SHOW=1 opts out
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
/** Desktop notifications; registered with the product IPC, follows each main window. */
let notificationPlane: NotificationPlane | undefined;
/** The Command Center is a trusted renderer identity, never "the first window". */
const currentTrustedMainWindow = (): BrowserWindow | undefined => {
  const candidate = trustedMainWindow;
  if (candidate === undefined) return undefined;
  if (!candidate.isDestroyed()) return candidate;
  trustedMainWindow = undefined;
  return undefined;
};
const sendAgentSignal = (signal: AgentSignal): void => {
  const window = currentTrustedMainWindow();
  if (
    window === undefined ||
    window.webContents.isDestroyed() ||
    !isTrustedMainWebContents(window.webContents)
  ) return;
  window.webContents.send(IPC_CHANNELS.agentSignal, signal);
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
/** With the core in its own process: main's handle on it, and the browser it asks main to drive. */
let coreChildren: Children | undefined;
let coreProcessPages: OverseerPages | undefined;
let unregisterOverseerLiveIpc: (() => void) | undefined;
let rendererWindowAdmissionReady = false;
let productRuntimeStarted = false;
let operatorFleetReady = false;
let shutdownAdmissionClosed = false;
let shutdownReason = "app_quit";
let browserShutdown: Promise<Awaited<ReturnType<BrowserComposition["drainOnQuit"]>>> | undefined;
let hostOperationsDrain:
  | Promise<Awaited<ReturnType<typeof hostOperationsShutdown.drainOnQuit>>>
  | undefined;
let adapterShutdown:
  | Promise<Awaited<ReturnType<typeof terminateAdapterChildrenOnQuit>>>
  | undefined;
let appProcessShutdown:
  | Promise<Awaited<ReturnType<typeof appProcessPlane.drainOnQuit>>>
  | undefined;
let unsubscribeCanvasEdgeGrants: (() => void) | undefined;
const signalQuitState = createSignalQuitState();
const quitPreparationArbiter = createQuitPreparationArbiter();
const signalQuiescedWindows = new WeakSet<BrowserWindow>();
let signalRendererDestroyInProgress = false;
let closeWindowsWithoutCanvasFlush = false;
// Set once the macOS menu bar exists: rebuilds it for the agent switcher being up or down.
let showAppMenuFor: ((switcherUp: boolean) => void) | undefined;
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
/**
 * Who asked for the quit, for the `[quit]` log only; it never gates the
 * sequence. In-app callers name themselves through quitFor, and each
 * before-quit consumes the name. A before-quit nobody named came from the
 * menu, Cmd+Q, the Dock, an Apple Event or a logout.
 */
let quitRequestSource: string | undefined;
const quitFor = (source: string): void => {
  quitRequestSource ??= source;
  app.quit();
};
const takeQuitRequestSource = (): string => {
  const source = quitRequestSource ??
    `menu, Cmd+Q, the Dock, an Apple Event or a logout (${
      BrowserWindow.getFocusedWindow() === null ? "no Junto window focused" : "a Junto window focused"
    })`;
  quitRequestSource = undefined;
  return source;
};

const CANVAS_FLUSH_TIMEOUT_MS = 10_000;
/** Bound on awaiting already-admitted main-process authoring during quit. */
const QUIT_DRAIN_TIMEOUT_MS = 5_000;

class CanvasFlushError extends Error {
  constructor(message: string, readonly saveFailed: boolean) {
    super(message);
    this.name = "CanvasFlushError";
  }
}

const pendingCanvasFlushes = new Map<
  number,
  {
    readonly requestId: string;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: CanvasFlushError) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * `saveFailed` is the one distinction that decides quit: the renderer answered
 * that its data is still alive but the write did not land. Every other failure
 * (timeout, dead renderer, destroyed window) means the data is unreachable, so
 * blocking would only end in SIGKILL.
 */
class CanvasQuiesceAndFlushError extends Error {
  constructor(
    message: string,
    readonly quiesced: boolean,
    readonly saveFailed = false,
  ) {
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
  let reject!: (error: CanvasFlushError) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => {
    const pending = pendingCanvasFlushes.get(webContentsId);
    if (pending?.requestId !== requestId) return;
    pendingCanvasFlushes.delete(webContentsId);
    reject(new CanvasFlushError("renderer canvas flush timed out", false));
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
  else {
    pending.reject(
      new CanvasFlushError("renderer rejected close because canvas save failed", true),
    );
  }
});

const filesDraftsSettle = makeFilesDraftsSettle();

/** Unsaved Files drafts settle before a quit or a close: false is the operator's Cancel. */
const requestFilesDraftsSettle = (mainWindow: BrowserWindow | undefined): Promise<boolean> => {
  if (mainWindow === undefined || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.resolve(true);
  }
  const contents = mainWindow.webContents;
  return filesDraftsSettle.request({
    id: contents.id,
    send: (request) => contents.send(IPC_CHANNELS.filesDraftsSettleRequested, request),
  });
};

ipcMain.on(IPC_CHANNELS.filesDraftsSettleStarted, (event, payload: unknown) => {
  if (isTrustedMainWebContents(event.sender)) filesDraftsSettle.started(event.sender.id, payload);
});

ipcMain.on(IPC_CHANNELS.filesDraftsSettleComplete, (event, payload: unknown) => {
  if (isTrustedMainWebContents(event.sender)) filesDraftsSettle.complete(event.sender.id, payload);
});

const requestCanvasQuiesceAndFlush = (mainWindow: BrowserWindow): Promise<void> => {
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
  try {
    mainWindow.webContents.send(IPC_CHANNELS.canvasQuiesceAndFlushRequested, { requestId });
  } catch (error) {
    clearTimeout(timer);
    pendingCanvasQuiesceAndFlushes.delete(webContentsId);
    reject(new CanvasQuiesceAndFlushError(
      error instanceof Error ? error.message : String(error),
      false,
    ));
  }
  return promise;
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
    result.ok
      ? "renderer completed canvas flush without closing authoring admission"
      : "renderer rejected quit because canvas save failed",
    quiesced,
    !result.ok,
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
  testHarness: process.env.JUNTO_E2E === "1",
  override: process.env.JUNTO_E2E_RENDERER_SURFACE_TIMEOUT_MS,
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
  // Observability: feed renderer console into the process log ring (always).
  // Dev builds also mirror warn/error to main stdout for headless terminal logs.
  // Electron 43 deprecates the positional console-message signature; use the
  // Event<WebContentsConsoleMessageEventParams> fields instead.
  mainWindow.webContents.on("console-message", (event) => {
    recordRendererConsole({
      level: event.level,
      message: event.message,
      sourceId: event.sourceId,
      lineNumber: event.lineNumber,
    });
    // Dev stdout only — process.stdout avoids the main console ring hook.
    if (app.isPackaged) return;
    if (event.level !== "error" && event.level !== "warning") return;
    const severity = event.level === "error" ? "error" : "warn";
    process.stdout.write(
      `[renderer:${severity}] ${event.message} (${event.sourceId}:${event.lineNumber})\n`,
    );
  });

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
    title: isPreview ? `${PRODUCT_NAME} PREVIEW` : app.isPackaged ? PRODUCT_NAME : `${PRODUCT_NAME} Dev`,
    backgroundColor: DARK_RUNTIME.ground,

    // `hiddenInset` and traffic-light geometry are a macOS presentation
    // contract. Linux window managers receive Electron's native chrome.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    // E2E: off-screen, non-focusable — Playwright still attaches; operator
    // focus and Dock stay undisturbed (see e2e-presentation.ts).
    ...e2eMainWindowOptions(e2ePresentation),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A hidden Linux/Xvfb window otherwise falls to roughly one frame per
      // second. E2E still renders the real UI; it just must not be background
      // throttled while Playwright drives it.
      ...(e2eIsolateFocus ? { backgroundThrottling: false } : {}),
    },
  });
  if (isPreview) mainWindow.on("page-title-updated", (event) => event.preventDefault());
  if (BROWSER_ENABLED && productRuntimeStarted) {
    void browserCompositionHost.bindVisibleWindow(mainWindow).catch(() => {
      if (!mainWindow.isDestroyed()) mainWindow.destroy();
      exitAfterDetach(1, "browser-composition-host-bind-failure");
    });
  }
  trustedMainWindow = mainWindow;
  notificationPlane?.attach(mainWindow);
  // The interface size (Settings, Appearance) is this window's zoom factor:
  // applied now, on every change, and again after each load. A narrow window
  // holds a large size back, so it is fitted again when the width changes.
  const mainContents = mainWindow.webContents;
  const interfaceScaleTarget = {
    isDestroyed: () => mainWindow.isDestroyed() || mainContents.isDestroyed(),
    setZoomFactor: (factor: number) => mainContents.setZoomFactor(factor),
    contentWidth: () => mainWindow.getContentSize()[0] ?? 0,
  };
  const stopInterfaceScale = followInterfaceScale(interfaceScaleTarget);
  mainContents.on("did-finish-load", () => applyInterfaceScale(interfaceScaleTarget));
  mainWindow.on("resize", () => refitInterfaceScale(interfaceScaleTarget));
  // BrowserWindow's `closed` event fires after its native object and
  // WebContents have been destroyed. Capture the routing identity while it is
  // live; dereferencing mainWindow.webContents inside `closed` throws.
  const mainWebContentsId = mainWindow.webContents.id;

  let closeAfterCanvasFlush = false;
  let closeFlush: Promise<void> | undefined;
  mainWindow.on("close", (event) => {
    if (
      !productRuntimeStarted ||
      closeWindowsWithoutCanvasFlush ||
      closeAfterCanvasFlush ||
      signalQuiescedWindows.has(mainWindow)
    ) return;
    event.preventDefault();
    if (quitPreparationArbiter.signalPrecommit()) return;
    const proceedWithClose = (): void => {
      // The window can already be gone by the time the flush settles — the
      // `closed` listener rejects any pending flush, and that rejection lands
      // in the fail-open branch below. Calling into a destroyed BrowserWindow
      // throws, and here that throw would surface as an unhandled rejection.
      if (mainWindow.isDestroyed()) return;
      // A signal may claim global quit while this ordinary flush is in
      // flight. Its renderer handshake now owns the only close authority.
      if (quitPreparationArbiter.signalPrecommit()) return;
      closeAfterCanvasFlush = true;
      mainWindow.close();
    };
    const flushThenClose = (): Promise<void> =>
      requestCanvasFlush(mainWindow)
        .then(proceedWithClose)
        .catch((error: unknown) => {
          // Only an explicit save failure keeps live data hostage; block that
          // close so the operator can see it. Anything else means the renderer
          // is unreachable, and holding the window open changes nothing.
          if (error instanceof CanvasFlushError && error.saveFailed) {
            console.error("[canvas] window close blocked:", error);
            return;
          }
          console.error(
            `[canvas] window close flush unproven: ${
              error instanceof Error ? error.message : String(error)
            } — closing anyway`,
          );
          proceedWithClose();
        });
    // Unsaved Files drafts first: the operator's Cancel keeps the window.
    closeFlush ??= requestFilesDraftsSettle(mainWindow)
      .then((leave) => (leave ? flushThenClose() : undefined))
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
    orElse: (phase) => {
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
  // Cmd+W with nothing open in front. `close()` runs the close handler above,
  // so canvas edits are flushed first; a page calling window.close() itself
  // would skip it.
  const closeFromKeyboard = (event: IpcMainEvent): void => {
    if (
      event.sender !== mainWindow.webContents ||
      mainWindow.isDestroyed() ||
      !rendererOrigin.allows(event.sender.getURL())
    ) return;
    mainWindow.close();
  };
  ipcMain.on(IPC_CHANNELS.windowClose, closeFromKeyboard);
  // The page asks the menu bar to give up chords: all of them while a chord
  // is being recorded in Settings (it must be recorded, not run), or Cmd+H
  // while the agent switcher is up. The menu takes them back whenever the
  // window loses focus or its page loads again, so a page that goes away
  // cannot leave Cmd+Q dead.
  const applyMenuYield = (yielding: MenuYield): void => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.setIgnoreMenuShortcuts(yielding === "all");
    showAppMenuFor?.(yielding === "switcher");
  };
  const yieldMenuKeys = (event: IpcMainEvent, yielding: unknown): void => {
    if (
      event.sender !== mainWindow.webContents ||
      mainWindow.isDestroyed() ||
      !rendererOrigin.allows(event.sender.getURL())
    ) return;
    applyMenuYield(yielding === "all" || yielding === "switcher" ? yielding : "none");
  };
  ipcMain.on(IPC_CHANNELS.menuYield, yieldMenuKeys);
  const restoreMenuKeys = (): void => applyMenuYield("none");
  mainWindow.on("blur", restoreMenuKeys);
  mainWindow.webContents.on("did-start-loading", restoreMenuKeys);

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
  mainWindow.webContents.on("render-process-gone", () => filesDraftsSettle.gone(mainWebContentsId));
  // The live overseer runs in the core; a lost renderer still ends its session,
  // asked for by name (core-process/main-side/overseer-live.ts).
  const endLostLiveMedia = (): void => {
    const service = coreOverseerLive(core);
    void service.liveSnapshot().then((snapshot) => snapshot.sessionId !== null
      ? service.liveEnd(snapshot.sessionId) : undefined).catch(() => undefined);
  };
  mainWindow.webContents.on("render-process-gone", endLostLiveMedia);
  mainWindow.webContents.on("destroyed", endLostLiveMedia);
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
    stopInterfaceScale();
    if (productRuntimeStarted) {
      void browserCompositionHost.releaseVisibleWindow(mainWindow).catch(() => {
        exitAfterDetach(1, "browser-composition-host-release-failure");
      });
    }
    filesDraftsSettle.gone(mainWebContentsId);
    const pending = pendingCanvasFlushes.get(mainWebContentsId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pendingCanvasFlushes.delete(mainWebContentsId);
      pending.reject(
        new CanvasFlushError("renderer closed before canvas flush completed", false),
      );
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
    ipcMain.removeListener(IPC_CHANNELS.windowClose, closeFromKeyboard);
    ipcMain.removeListener(IPC_CHANNELS.menuYield, yieldMenuKeys);
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
    title: "Junto recovery",
    backgroundColor: DARK_RUNTIME.ground,
    ...e2eMainWindowOptions(e2ePresentation),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(e2eIsolateFocus ? { backgroundThrottling: false } : {}),
    },
  });
  rendererFailureWindow = failureWindow;
  failureWindow.on("close", (event) => {
    // Keep a visible recovery surface while owned-runtime shutdown is unable
    // to prove clean. app.exit after a clean drain bypasses this event.
    if (runtimeDisposed) return;
    event.preventDefault();
    quitFor("renderer failure window closed");
  });
  failureWindow.on("closed", () => {
    if (rendererFailureWindow === failureWindow) rendererFailureWindow = undefined;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Junto recovery</title><style>html{color-scheme:dark;background:${DARK_RUNTIME.ground};color:${DARK_RUNTIME.ink};font:15px system-ui}body{max-width:52ch;margin:72px auto;padding:0 28px}h1{font-size:22px}p{line-height:1.55;color:${DARK_RUNTIME["ink-2"]}}</style><h1>Junto could not render its workspace.</h1><p>A trusted workspace could not be restored safely. Quit and reopen Junto; your canvas documents and local sessions were not deleted.</p>`;
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
  try {
    const machine = (await core.call("settings.read", {})).machine;
    if (!machine.supervisedPreferred) return true;
  } catch { return true; }
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
    quitFor("supervisor handoff failed and another instance holds the lock");
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
const packagedSandboxDisablingSwitch = findPackagedSandboxDisablingSwitch({
  packaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
});
// A Junto still in its native quit teardown holds the lock for a few seconds;
// a relaunch waits for it only while its quit marker names a live process,
// then asks once (a request retried after a refusal never reaches ready).
const gotSingleInstanceLock =
  packagedSandboxDisablingSwitch === undefined &&
  requestLockAfterQuittingHolder({
    markerPath: quitMarkerPath(resolveJuntoHome()),
    requestLock: () => app.requestSingleInstanceLock(),
    startKeyOf: readUnsharedProcessStartKey,
  });
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
  quitFor("another instance holds the lock");
} else {
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

  app.on("activate", () => {
    retryActiveNodeRef();
    if (!headless && currentTrustedMainWindow() === undefined) createWindow();
  });

  void app.whenReady().then(async () => {
    // One log path: main console + Effect logger (layer already on AppRuntime)
    // into the ring and this machine's log file under ~/.junto/logs.
    installMachineLog({ home: resolveJuntoHome(), process: "app", echo: true });
    installObservabilityConsoleHook();
    // The 4ms invariant, asserted at the source. Dev runs are armed; a
    // packaged app stays silent unless JUNTO_BUDGET says otherwise.
    armMainThreadBudget({ enabled: !app.isPackaged });
    // With the budget armed, the top statements by main-thread time land in
    // ~/.junto/logs/sql-timing.json every minute and on exit.
    startSqlTimingLog({ home: resolveJuntoHome() });
    recordSystemLog(
      `${PRODUCT_NAME} ready - ${app.isPackaged ? "packaged" : "dev"} - ${app.getVersion() || "0.0.0"} - ${overlayManifest.name}`,
    );
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
    // Junto's own menu bar. Off macOS there is no Cmd, and the keys there are
    // not designed yet: the platform default stays.
    if (process.platform === "darwin") {
      // The menu shows and claims the chords the operator chose in Settings,
      // so it is rebuilt whenever those change.
      let shown: string | undefined;
      let menuSettings: Settings | undefined;
      let switcherUp = false;
      const showAppMenu = (): void => {
        const overrides = keyboardSettings(menuSettings).overrides;
        const key = JSON.stringify([overrides, switcherUp]);
        if (key === shown) return;
        shown = key;
        Menu.setApplicationMenu(
          Menu.buildFromTemplate(
            appMenuTemplate({
              productName: PRODUCT_NAME,
              packaged: app.isPackaged,
              overrides,
              switcherUp,
              hideApp: () => app.hide(),
              sendKey: ({ keyCode, modifiers }) => {
                const contents = BrowserWindow.getFocusedWindow()?.webContents;
                if (!contents || contents.isDestroyed()) return;
                contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [...modifiers] });
                contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [...modifiers] });
              },
            }),
          ),
        );
      };
      const showAppMenuWith = (settings: Settings | undefined): void => {
        menuSettings = settings;
        showAppMenu();
      };
      showAppMenuFor = (up) => {
        switcherUp = up;
        showAppMenu();
      };
      showAppMenuWith(undefined);
      // The settings as they stand and every change after arrive in order on one push channel.
      subscribeCore(SETTINGS_CHANGED, (next) => showAppMenuWith(next as Settings));
      askOnEveryCore("settings.watch", () => core.call("settings.watch", {}));
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
      // Pin Chromium's default download dir under app-owned state before the
      // session's first materialized use — profile init resolves
      // NSSearchPathForDirectoriesInDomains and would bill ~/Downloads to
      // Junto before any window exists.
      const downloadsDir = join(app.getPath("userData"), "downloads");
      mkdirSync(downloadsDir, { recursive: true });
      session.defaultSession.setDownloadPath(downloadsDir);
      if (app.isPackaged) {
        await installTrustedRendererProtocol(
          session.defaultSession.protocol,
          join(import.meta.dirname, "../renderer"),
        );
      }
      installTrustedRendererPermissionPolicy(
        session.defaultSession,
        () => trustedMainWindow,
        trustedRendererOrigin,
      );
      await app.setProxy({ mode: "direct" });
      await session.defaultSession.setProxy({ mode: "direct" });
    } catch (error) {
      console.error("[window] trusted renderer protocol setup failed", error);
      exitAfterDetach(1, "trusted-renderer-startup-failure");
      return;
    }

    // Resolve the spawn environment before any adapter/service spawn: the
    // operator's login-shell environment, PATH merged over inherited PATH,
    // operator tool directories, and the static floor.
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

    // Control sockets must never land under the real operator home when E2E /
    // headless probes sandbox via HOME or --user-data-dir. Electron's
    // app.getPath("home") ignores HOME; resolveControlHome is the isolation gate.
    const controlHomeInput = {
      envHome: process.env.HOME,
      electronHome: app.getPath("home"),
      userData: app.getPath("userData"),
      e2e: process.env.JUNTO_E2E === "1",
      headless,
      packaged: app.isPackaged,
    } as const;
    const termControlHome = resolveControlHome({
      ...controlHomeInput,
      explicitHome: process.env.JUNTO_HOME,
    });
    const browserControlHome = resolveControlHome({
      ...controlHomeInput,
      explicitHome: process.env.JUNTO_BROWSER_HOME ?? process.env.JUNTO_HOME,
    });

    const captureApplicationPage = captureTrustedWindowPng(async () => {
      const window = currentTrustedMainWindow();
      if (
        window === undefined ||
        window.isDestroyed() ||
        window.webContents.isDestroyed()
      ) {
        return undefined;
      }
      const image = await window.webContents.capturePage();
      return new Uint8Array(image.toPNG());
    });
    const showPreamble = (event: PreambleEvent): void => {
      companionNotePreamble(event);
      const window = currentTrustedMainWindow();
      if (
        window === undefined ||
        window.webContents.isDestroyed() ||
        !isTrustedMainWebContents(window.webContents)
      ) return;
      window.webContents.send(IPC_CHANNELS.preamble, event);
    };
    const showAgentSignal = (signal: AgentSignal): void => {
      raisedHands.note(signal);
      sendAgentSignal(signal);
    };
    // A core in its own process sends these on the push stream; in this
    // process the hooks below call them, and nothing is published.
    subscribeCore(WORK_PREAMBLE, (event) => showPreamble(event as PreambleEvent));
    subscribeCore(AGENT_SIGNAL_CHANGED, (signal) => showAgentSignal(signal as AgentSignal));
    subscribeCore(COMPANION_DEVICES, (devices) => broadcastCompanionDevices(devices as ReadonlyArray<CompanionDeviceRecord>));

    // The core, its sockets, the link, the overseer and the phone companion
    // all run in the core process; main builds none of them. Both children are
    // one Effect scope: acquiring it starts the terminal process, then the core,
    // and closing it stops them in reverse, so quit cannot reorder them.
    const boot = {
      home: termControlHome,
      build: runningBuildIdentity(),
      bundlesRoot: process.env.JUNTO_MACHINE_BUNDLES ??
        (app.isPackaged ? join(process.resourcesPath, "machines") : join(app.getAppPath(), "dist", "machines")),
      operatorCommands: operatorControlEnabledAtLaunch,
      app: { version: app.getVersion(), packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() },
    };
    coreChildren = await startChildren((terminals) => startCoreProcessForMain({
      boot,
      pages: () => coreProcessPages,
      captureApplicationPage,
      clipboard: electronCompanionClipboard,
      clipboardFormats: () => clipboard.availableFormats(),
      terminals,
    }));
    if (LIVE_OVERSEER_ENABLED) unregisterOverseerLiveIpc = registerOverseerLiveIpc(coreOverseerLive(core));

    // UpdateService host hooks: release SQLite before quitAndInstall, and
    // relaunch without Squirrel install when finalize fails after quiesce.
    // After successful quiesce we mark runtimeDisposed + skipQuitConfirm so
    // electron-updater quitAndInstall is not blocked by before-quit re-commit.
    installUpdateHostHooks({
      quiesceForInstall: async () => {
        await flushCanvasOnQuit();
        detachRuntimeOnQuit("update-install");
        await disposeRuntimeFailClosed("update-install");
        runtimeDisposed = true;
        skipQuitConfirm = true;
      },
      relaunchWithoutInstall: () => {
        // app.exit bypasses before-quit; keep the same path on install failure.
        skipQuitConfirm = true;
        runtimeDisposed = true;
        app.relaunch();
        app.exit(0);
      },
      relaunchInstalled: (executablePath) => {
        // SQLite and owned product processes are already closed. Electron waits
        // for this process to exit before starting this exact admitted release.
        skipQuitConfirm = true;
        runtimeDisposed = true;
        app.relaunch({ execPath: executablePath, args: [] });
        app.exit(0);
      },
    });
    registerIpcHandlers();
    registerDemoIpcHandlers();
    // Settings reads the phones from wherever the companion runs.
    registerCompanionIpc();
    notificationPlane ??= registerNotificationIpc({
      window: currentTrustedMainWindow,
      // No banners, badge, or bounce from an isolated harness run; a visible
      // run (JUNTO_E2E_SHOW=1) is someone watching, and may see them.
      enabled: !e2eIsolateFocus,
    });
    const notifyWindow = currentTrustedMainWindow();
    if (notifyWindow !== undefined) notificationPlane.attach(notifyWindow);
    if (shutdownAdmissionClosed) return;

    // Content stream protocol: renderer media loads ContentRefs without Base64.
    // Handler resolves through ContentService (manifest + path); never opens DB
    // from the renderer and never exposes host paths in the URL.
    try {
      installContentProtocol(session.defaultSession.protocol, async (ref) => {
        return core.call("content.openForRead", { ref });
      }, (request) => remoteVideos.handle(request));
    } catch (error) {
      console.error("[content-protocol] failed to install:", error);
      exitAfterDetach(1, "content-protocol-startup-failure");
      return;
    }

    // Files node bytes (junto-file://<node>/<relpath>): served only for a node
    // a window opened, inside its root after realpath (src/main/junto/files/).
    try {
      // The Files service, its router and its index worker run in the core;
      // main serves the channels, the shell, and these bytes in chunks.
      registerFilesIpc();
      installFileProtocol(session.defaultSession.protocol, coreFileBytes());
    } catch (error) {
      console.error("[files-protocol] failed to install:", error);
      exitAfterDetach(1, "files-protocol-startup-failure");
      return;
    }

    // Hands already raised before this boot: agent → relay announce wires
    // watch them. Signal writes from here on are noted as they happen.
    askOnEveryCore("signals.raisedHands", () => core.call("signals.raisedHands", {}).then(raisedHands.hydrate));
    powerMonitor.on("resume", () => {
      if (shutdownAdmissionClosed) return;
      try {
        browserComposition?.registry.reapAfterResume();
      } catch (cause) {
        console.error("[browser-automation] resume reap failed", cause);
      }
    });

    // Browser authority stays private until cold profile recovery completes.
    // The activation callback is the only place browser IPC, agent IPC, or
    // the local control socket can become reachable.
    if (BROWSER_ENABLED) try {
      if (headless) await browserCompositionHost.ensureHeadlessHost();
      browserComposition = await startBrowserComposition(
        async (composition) => {
          const listCanvasModels = async () => {
            try {
              return await core.call("model.canvases", {});
            } catch (cause) {
              // No canvases means no edge grant: the read fails closed, and says why.
              console.error("[browser-automation] canvases could not be listed; edge grants refuse until they can", cause);
              return [];
            }
          };
          const edgeGrant = makeEdgeGrantService({
            capabilities: composition.registry,
            resolvePageTarget: resolveBrowserPageTarget,
            listCanvasModels,
            machineName: () => composition.sessions.machineName(),
            editsCanvas: (canvasName) => core.call("model.editsCanvas", { canvasName }),
            // Edge-delete (I10): same destroy path as capability terminate, but
            // keyed by (owner, page-ref) so sibling edges stay live.
            sessions: {
              destroyOwnerTargetSessions: (owner, ref, reason) =>
                composition.sessions.destroyOwnerTargetSessions(owner, ref, reason),
            },
          });
          let canvasUnsubscribe: (() => void) | undefined;
          let admissionCleanupRan = false;
          unsubscribeCanvasEdgeGrants = () => {
            if (admissionCleanupRan) return;
            admissionCleanupRan = true;
            canvasUnsubscribe?.();
            edgeGrant.clear();
          };
          // Every canvas change and removal arrives in order on one push channel.
          const stopCanvasChanged = subscribeCore(CANVAS_CHANGED, (payload) => {
            const { canvas, next } = payload as CanvasChangedPush;
            edgeGrant.invalidateCanvas(canvas, { next });
          });
          // A change while no core ran never reached the grants: a new core starts them over.
          const stopCoreRestarted = subscribeCore(IPC_CHANNELS.coreRestarted, () => edgeGrant.clear());
          const acquiredCanvasUnsubscribe = (): void => {
            stopCanvasChanged();
            stopCoreRestarted();
          };
          await core.call("model.watchCanvases", {});
          askOnLaterCores("model.watchCanvases", () => core.call("model.watchCanvases", {}));
          if (admissionCleanupRan) acquiredCanvasUnsubscribe();
          else canvasUnsubscribe = acquiredCanvasUnsubscribe;

          browserControl = await startBrowserControlServer({
            sessions: composition.sessions,
            capabilities: composition.registry,
            resolvePageTarget: resolveBrowserPageTarget,
            version: app.getVersion(),
            home: browserControlHome,
            edgeGrant,
            listCanvasModels,
            // The work socket's pause source, read in the core on every request; never cached here.
            canvasPlaying: (canvasName) => core.call("pause.playing", { canvas: canvasName }),
            // A seat's box comment, posted as the seat the grant names.
            postPageBoxComment: (input) =>
              // The core checks and posts; the shot is Electron's, so main takes it between.
              mainAuthoringGate.run("control.browser.box-comment", async () => {
                const { signal, ...request } = input;
                const checked = await core.call("pageBox.check", request);
                if (!checked.ok) return checked;
                const shot = await composition.sessions.captureBoxForOwner(input.owner, input.sessionId, input.rect, signal);
                if (!shot.ok) return shot;
                return core.call("pageBox.post", { request, shot: shot.data });
              }),
          });
          composition.bindControlShutdown(browserControl);
          registerBrowserIpcHandlers(composition.sessions);
          coreProcessPages = overseerPagesOn(composition.sessions);
        },
        {
          profileStore: coreBrowserProfileStore(core),
          touchedOrigins: coreTouchedOriginStore(core),
          viewAdapter: browserViewAttachmentTarget.adapter,
        },
      );
      if (shutdownAdmissionClosed) {
        browserShutdown ??= browserComposition?.drainOnQuit(shutdownReason);
        return;
      }
    } catch (startupError) {
      console.error("[browser-automation] composition failed to start", startupError);
      browserComposition = undefined;
      unsubscribeCanvasEdgeGrants?.();
      unsubscribeCanvasEdgeGrants = undefined;
      try {
        browserControl?.close();
      } catch (cause) {
        // Startup is already failing closed; the exit below still runs.
        console.error("[browser-automation] control socket did not close", cause);
      }
      browserControl = undefined;
      console.error(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
      // Not a silent exit: the startup chain's own catch names the failure in
      // the startup dialog, and quits only after the operator has seen it.
      throw startupError;
    }

    productRuntimeStarted = true;
    operatorFleetReady = true;
    nodeRefOwnerReady = true;
    activatePendingNodeRef();
    rendererWindowAdmissionReady = true;
    if (process.platform === "linux" && app.isPackaged) {
      void import("./junto/update/linux-install").then(({ markLinuxDesktopInstallReady }) =>
        markLinuxDesktopInstallReady({ executablePath: process.execPath }),
      ).catch((cause: unknown) => {
        // A package run outside the managed install lands here every launch; updates stay off.
        console.warn("[update] the Linux desktop install could not be marked ready; updates stay off", cause);
      });
    }
    if (!headless) createWindow();
  })
    .catch(async (error) => {
      console.error("[startup] initialization failed:", error);
      // GUI: native dialog with data-safe next step. Headless: log only.
      // Schema-too-new is handled earlier; this covers StateEngine open and
      // other pre-window product startup failures.
      try {
        // An isolated harness run must not put a dialog on the operator's
        // screen either; it logs and quits like headless.
        await runStartupStateFailureDialog({
          error,
          headless: headless || e2eIsolateFocus,
        });
      } catch (dialogError) {
        console.error("[startup] failure dialog failed:", dialogError);
      }
      exitAfterDetach(1, "startup-failure");
    });
}

// WINDOW CLOSE ≠ QUIT on macOS: last window close leaves the app running —
// kernel, automations, and control sockets stay live with zero
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
  ) quitFor("last window closed");
};

const beginShutdownAdmission = (reason: string): void => {
  shutdownReason = reason;
  if (shutdownAdmissionClosed) return;
  shutdownAdmissionClosed = true;
  operatorFleetReady = false;
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
  adapterShutdown ??= terminateAdapterChildrenOnQuit();

  // A phone's idle long poll must not hold operator control open over quit.
  companionService()?.changes.close();
  unregisterOverseerLiveIpc?.();
  unregisterOverseerLiveIpc = undefined;
  hostOperationsShutdown.beginShutdown();
  appProcessPlane.beginShutdown();
};

/** Logged per-phase quit timing; observation only, never a gate. */
const quitPhases = createQuitPhaseLog();

const logUnfinishedDrain = (
  stage: string,
  report: Awaited<ReturnType<typeof mainAuthoringGate.drain>>,
): void => {
  if (!report.timedOut) return;
  console.error(
    `[quit] ${stage} authoring drain unfinished: ${
      report.remaining.join(", ") || "unknown work"
    } — quitting anyway`,
  );
};

/**
 * The honest quit boundary.
 *
 * Only one failure blocks: the renderer answering that the save itself failed.
 * That data is still alive in the renderer, so discarding it would be sloppy,
 * and the attempt is retryable — beginFinalFlush is idempotent and nothing here
 * poisons a second try. Every other outcome (timeout, dead renderer, destroyed
 * window, IPC send failure) leaves the data unreachable regardless: log one
 * line and let the process exit, because blocking ends in SIGKILL instead.
 */
const flushCanvasOnQuit = async (): Promise<void> => {
  // Failed or incomplete startup never owns a live authoring surface.
  // Waiting for its canvas flush would strand quit on unopened product IPC.
  if (!productRuntimeStarted) return;
  mainAuthoringGate.beginFinalFlush();
  logUnfinishedDrain(
    "pre-flush",
    await quitPhases.time("pre-flush authoring drain", () =>
      mainAuthoringGate.drain(QUIT_DRAIN_TIMEOUT_MS)),
  );
  const mainWindow = trustedMainWindow;
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    try {
      await quitPhases.time("renderer canvas quiesce+flush", () =>
        requestCanvasQuiesceAndFlush(mainWindow));
    } catch (error) {
      if (error instanceof CanvasQuiesceAndFlushError && error.saveFailed) throw error;
      console.error(
        `[quit] canvas flush unproven: ${
          error instanceof Error ? error.message : String(error)
        } — quitting anyway`,
      );
    }
  }
  mainAuthoringGate.close();
  logUnfinishedDrain(
    "post-flush",
    await quitPhases.time("post-flush authoring drain", () =>
      mainAuthoringGate.drain(QUIT_DRAIN_TIMEOUT_MS)),
  );
};

let runtimeDetachedForQuit = false;

const detachRuntimeOnQuit = (reason: string): void => {
  if (runtimeDetachedForQuit) return;
  if (quitPreparationArbiter.signalPrecommit()) {
    throw new Error("runtime detach blocked before signal durability commit");
  }
  runtimeDetachedForQuit = true;
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
    browserComposition = undefined;
    unsubscribeCanvasEdgeGrants?.();
    unsubscribeCanvasEdgeGrants = undefined;
  }
  if (BROWSER_ENABLED) await browserCompositionHost.shutdown();
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

const requireCleanChildrenShutdown = async (): Promise<void> => {
  const children = coreChildren;
  coreChildren = undefined;
  if (children === undefined) return;
  // The scope's own order: the core's finalizer (it drains, then exits) before
  // the terminal process's. A child that hung is a tagged failure, named here.
  await children.close();
  const [failure] = takeChildStopFailures();
  if (failure !== undefined) throw failure;
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
    const retained = receipt.stragglers.map(describeAppProcessStraggler).join("; ");
    if (!appProcessBlocksAppExit(receipt.stragglers)) {
      console.error(`[process] quit continues with unsignalable read-only retention: ${retained}`);
      return;
    }
    throw new Error(
      `app process shutdown retained ${receipt.stragglers.length} child generation(s): ${retained}`,
    );
  }
};

const drainRuntimeOnQuit = async (reason: string): Promise<void> => {
  const { lap } = quitPhases;
  quitPhases.mark("runtime dispose begins");
  await requireCleanHostOperationsShutdown();
  lap("dispose: host operations");
  await requireCleanBrowserShutdown(reason);
  lap("dispose: browser");
  await requireCleanAdapterShutdown();
  lap("dispose: adapters");
  await requireCleanAppProcessShutdown();
  lap("dispose: app processes");
  // Closing the children's scope runs the core's finalizer first (it drains
  // its own sockets, plane and stores, then exits) and the terminal process's
  // last. A child that hangs fails tagged out of the finalizer and is named
  // here, not swallowed.
  await requireCleanChildrenShutdown();
  lap("dispose: child processes");
};

const disposeRuntime = (): Promise<void> => {
  // Soft dispose for ordinary quit: log failures but still resolve so the
  // native quit sequence can continue after best-effort teardown.
  // Sole AppRuntime.dispose — do not construct a second runtime after this.
  runtimeDispose ??= drainRuntimeOnQuit(shutdownReason)
    .then(() => AppRuntime.dispose())
    .then(() => quitPhases.lap("dispose: effect runtime"))
    .finally(releaseDemoRuntimeIsolation)
    .catch((error) => {
      console.error("[runtime] dispose failed:", error);
    });
  return runtimeDispose;
};

/**
 * Fail-closed dispose for update install. SQLite must be released before
 * quitAndInstall — swallow is not allowed.
 * After dispose, only host/post-dispose bare Effect.runPromise is allowed
 * (S0 permanent allowlist: update finalize). Domain Effects stay on AppRuntime
 * before this point.
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

/**
 * An app exit is authorized only after admission is cut: no new authoring,
 * seat or operator command may enter while the rest of the teardown runs. The
 * core drains its own terminal plane as it stops (junto/term/core-seats.ts),
 * and main stops the terminal process after that.
 */
const requireCleanLocalTerminalShutdown = async (reason: string): Promise<void> => {
  beginShutdownAdmission(reason);
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
  await flushCanvasOnQuit();
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

/**
 * What is still running, as the core sees it: main holds no session, so the
 * count is a core call (term.list) filtered to the statuses a quit would end.
 * A core that does not answer is unknown, never zero, and unknown warns.
 */
const collectLiveWorkSnapshot = (): Promise<LiveWorkSnapshot> =>
  probeLiveWork(() => core.call("term.list", {}));

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
  const quitSource = takeQuitRequestSource();
  quitPhases.mark(runtimeDisposed ? "before-quit (runtime disposed)" : `before-quit, asked by ${quitSource}`);
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
          await flushCanvasOnQuit();
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
        quitFor("quit preparation finished");
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
        // Only an explicit renderer save failure reaches here. Give the
        // operator their surface back; the next Cmd+Q retries the same flush.
        recreateWindowIfEmpty();
        console.error("[canvas] quit blocked by canvas save failure:", error);
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

  const confirmLiveWorkThenQuit = async (): Promise<void> => {
    const live = await collectLiveWorkSnapshot();
    // Named in the quit log either way: it is the only record of what the
    // check saw, and the proof a real seat is counted.
    quitPhases.mark(
      live.countUnknown
        ? "live work: the core did not answer how many terminals are running"
        : `live work: ${live.localTerminalSessionCount} local terminal session${live.localTerminalSessionCount === 1 ? "" : "s"}`,
    );
    if (!hasLiveWork(live)) {
      quitConfirmed = true;
      beginQuitPreparation();
      return;
    }

    // Honest quit: one confirm naming what pauses vs what stops.
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
  };

  // Unsaved Files drafts first (Save all, Discard, Cancel in the renderer);
  // like the confirm, this does not own quitPreparation, so a signal can
  // still force through, and its invalidation ends this continuation.
  const draftsGeneration = quitConfirmGeneration;
  quitConfirmPending = true;
  void requestFilesDraftsSettle(trustedMainWindow).then((leave) => {
    if (draftsGeneration !== quitConfirmGeneration) return;
    quitConfirmPending = false;
    if (!leave) {
      quitConfirmed = false;
      recreateWindowIfEmpty();
      return;
    }
    void confirmLiveWorkThenQuit().catch((error: unknown) => {
      quitConfirmPending = false;
      quitConfirmed = false;
      console.error("[quit] the live-work check failed before the prompt:", error);
    });
  });
});

app.on("will-quit", () => {
  quitPhases.mark("will-quit");
  detachRuntimeOnQuit("will-quit");
});

// The last event before the process exits; a log that ends at will-quit with
// no quit row means the native loop did not finish.
app.on("quit", (_event, exitCode) => {
  quitPhases.mark(`quit, exit code ${exitCode}`);
  // Native teardown can still hold the instance lock for seconds; name this
  // process so a relaunch waits for it rather than quitting.
  const startKey = readProcessStartKey(process.pid);
  if (startKey !== undefined) writeQuitMarker(quitMarkerPath(resolveJuntoHome()), { pid: process.pid, startKey });
});

// Registered SIGTERM/SIGINT listeners suppress Node's default process exit.
// Detach authority first, request Electron's normal quit sequence, and retain
// a bounded hard-exit fallback if another listener prevents that sequence.
const processSignalTermination = installProcessSignalTermination({
  app,
  cleanup: async (signal) => {
    quitPhases.mark(`signal ${signal}`);
    quitRequestSource ??= `signal ${signal}`;
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
  allowForceExit: () => {
    const allowed =
      signalQuitState.forceExitAllowed() || quitPreparationArbiter.committed();
    quitPhases.mark(`signal exit fallback fired (force exit ${allowed ? "allowed" : "refused"})`);
    return allowed;
  },
});
// Electron installs its native POSIX route after loading main. Restore our
// owned listeners after readiness so SIGTERM takes the bounded forced quit
// path instead of opening the ordinary live-work confirmation.
void app.whenReady().then(() => processSignalTermination.rebind());
