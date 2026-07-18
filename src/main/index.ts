import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
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
  type IpcMainEvent,
} from "electron";
import { Effect } from "effect";
import { classifyBrowserTarget } from "@shared/browser-policy";
import { IPC_CHANNELS, type NodeRefOpenedDelivery } from "@shared/ipc";
import {
  resolvedSpawnEnv,
  terminateAdapterChildrenOnQuit,
} from "./vellum/adapters/exec";
import { AppRuntime, chatService } from "./runtime";
import { registerBrowserIpcHandlers, registerIpcHandlers } from "./ipc";
import { CanvasesService } from "./vellum/canvases";
import { buildBrowserAutomationNativePrompt } from "./vellum/browser/agent-confirmation";
import type { BrowserAutomationConfirmation } from "./vellum/browser/agent-authority";
import { registerBrowserAgentIpc } from "./vellum/browser/agent-ipc";
import {
  BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE,
  startBrowserComposition,
  type BrowserComposition,
} from "./vellum/browser/composition";
import { warmAllHosts } from "./vellum/herdr/masters";
import { startAllMirrors, stopAllMirrors } from "./vellum/herdr/mirrors";
import { herdrService } from "./vellum/herdr/service";
import { herdrStreams } from "./vellum/herdr/stream";
import { resolveBrowserPageTarget } from "./vellum/browser/ipc";
import { startBrowserControlServer, type BrowserControlServer } from "./vellum/browser/control";
import { isManagedBrowserWebContents } from "./vellum/browser/web-policy";
import {
  acknowledgeNodeRefRelay,
  claimLatestNodeRefRelay,
  makeNodeRefIngress,
  publishNodeRefOpenUrl,
  type NodeRefRelayRecord,
} from "./vellum/node-ref-ingress";
import { resolveNodeRef } from "./vellum/node-ref-resolver";
import { installProcessSignalTermination } from "./vellum/process-signal-termination";
import {
  installTrustedRendererPermissionPolicy,
  installTrustedRendererProtocol,
  registerTrustedRendererScheme,
  TRUSTED_RENDERER_URL,
} from "./vellum/trusted-renderer-protocol";

registerTrustedRendererScheme(protocol);

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

const nodeRefRelayDirectory = (): string =>
  join(app.getPath("userData"), "runtime", "open-url");

let nodeRefOwnerReady = false;
let nodeRefDrainRequested = false;
let nodeRefDrainRunning: Promise<void> | undefined;
let nodeRefRelayWatcher: FSWatcher | undefined;
let activeNodeRefRelay: NodeRefRelayRecord | undefined;
let activeNodeRefNeedsRetry = false;
let nodeRefPublicationTail: Promise<void> = Promise.resolve();

const reportNodeRefResult = (result: Awaited<ReturnType<typeof nodeRefIngress.accept>>): void => {
  if (!result.ok && result.code !== "superseded") {
    console.error(`[node-ref] locator rejected (${result.code})`);
  }
};

const flushNodeRefPublications = async (): Promise<void> => {
  for (;;) {
    const observed = nodeRefPublicationTail;
    await observed;
    if (observed === nodeRefPublicationTail) return;
  }
};

const acknowledgeActiveNodeRef = async (record: NodeRefRelayRecord): Promise<void> => {
  if (activeNodeRefRelay?.id !== record.id) return;
  try {
    const removed = await acknowledgeNodeRefRelay(nodeRefRelayDirectory(), record.id);
    if (!removed || activeNodeRefRelay?.id !== record.id) return;
    activeNodeRefRelay = undefined;
    activeNodeRefNeedsRetry = false;
  } catch {
    console.error("[node-ref] durable delivery acknowledgement failed");
  }
};

const activateNodeRefRelay = async (record: NodeRefRelayRecord): Promise<void> => {
  const result = await nodeRefIngress.accept(record.uri);
  if (activeNodeRefRelay?.id !== record.id) return;
  if (result.ok) {
    activeNodeRefNeedsRetry = false;
    return;
  }
  if (result.code === "superseded") return;
  reportNodeRefResult(result);
  if (result.code === "invalid") {
    await acknowledgeActiveNodeRef(record);
    return;
  }
  // A canvas read can recover without changing the durable locator. Missing
  // or concurrently edited documents therefore retry on the next owner wake
  // and expire under the relay TTL instead of being silently lost.
  activeNodeRefNeedsRetry = true;
};

const startNodeRefRelayWatcher = (): void => {
  if (nodeRefRelayWatcher !== undefined) return;
  try {
    const watcher = watch(nodeRefRelayDirectory(), { persistent: false }, () => {
      requestNodeRefDrain();
    });
    watcher.on("error", () => {
      if (nodeRefRelayWatcher === watcher) nodeRefRelayWatcher = undefined;
      watcher.close();
      console.error("[node-ref] durable relay watcher stopped");
    });
    nodeRefRelayWatcher = watcher;
    // The watch is now armed; one final scan closes the scan-before-watch
    // startup race. Subsequent record renames wake the serialized drain.
    nodeRefDrainRequested = true;
  } catch {
    console.error("[node-ref] durable relay watcher unavailable");
  }
};

const drainNodeRefRelays = async (): Promise<void> => {
  do {
    nodeRefDrainRequested = false;
    let newest: NodeRefRelayRecord | undefined;
    try {
      newest = await claimLatestNodeRefRelay(nodeRefRelayDirectory());
      startNodeRefRelayWatcher();
    } catch {
      console.error("[node-ref] durable relay drain failed");
      return;
    }
    if (newest === undefined) continue;
    if (activeNodeRefRelay?.id !== newest.id) {
      activeNodeRefRelay = newest;
      activeNodeRefNeedsRetry = false;
      await activateNodeRefRelay(newest);
    } else if (activeNodeRefNeedsRetry) {
      await activateNodeRefRelay(newest);
    }
  } while (nodeRefDrainRequested);
};

function requestNodeRefDrain(): void {
  nodeRefDrainRequested = true;
  if (!nodeRefOwnerReady || nodeRefDrainRunning !== undefined) return;
  const run = drainNodeRefRelays().catch(() => {
    console.error("[node-ref] durable relay activation failed");
  });
  nodeRefDrainRunning = run.finally(() => {
    nodeRefDrainRunning = undefined;
    if (nodeRefDrainRequested) requestNodeRefDrain();
  });
  void nodeRefDrainRunning;
}

const queueNodeRefPublication = (
  event: { readonly preventDefault: () => void },
  uri: string,
): void => {
  const publication = publishNodeRefOpenUrl(event, uri, nodeRefRelayDirectory());
  nodeRefPublicationTail = Promise.allSettled([nodeRefPublicationTail, publication]).then(
    () => undefined,
  );
  void publication.then(
    (result) => {
      if (result.kind === "invalid") {
        console.error(`[node-ref] locator rejected (${result.code})`);
        return;
      }
      requestNodeRefDrain();
    },
    () => console.error("[node-ref] durable locator publication failed"),
  );
};

// macOS may emit this before ready. Prevent native handling synchronously,
// then durably publish canonical syntax before any launchd handoff.
app.on("open-url", (event, uri) => {
  queueNodeRefPublication(event, uri);
});

// Explicit headless mode keeps the runtime, watchers, kernel, and local UDS
// services alive without creating a renderer. It replaces the former dev CDP
// listener: headless qualification must never require a network control port.
const headless = process.argv.includes("--vellum-headless");

let trustedMainWindow: BrowserWindow | undefined;
let browserComposition: BrowserComposition | undefined;
let browserControl: BrowserControlServer | undefined;

// Bounded renderer crash recovery. A renderer that dies (GPU reset, OOM kill,
// Chromium crash) is first reloaded in place — that recovers the common
// transient crash without losing the main process (Effect runtime, snapshot
// refresh loop). If deaths keep coming we escalate to a full app relaunch, but
// at most MAX_RECOVERIES within RECOVERY_WINDOW_MS so a hard crash loop gives
// up LOUDLY instead of spinning the CPU forever. Unattended-station-critical:
// these handlers run in packaged builds too, not just dev.
const RECOVERY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_RECOVERIES = 3;
let recoveryWindowStart = Date.now();
let reloadCount = 0;
let relaunchCount = 0;

const registerCrashRecovery = (mainWindow: BrowserWindow) => {
  // Dev observability: forward the renderer console to main stdout so headless
  // failures are visible in the terminal log. Noise-only — stays dev-gated.
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.log(`[renderer:${level === 3 ? "error" : "warn"}] ${message} (${sourceId}:${line})`);
      }
    });
  }

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:gone] ${details.reason} (exitCode ${details.exitCode})`);
    if (details.reason === "clean-exit" || mainWindow.isDestroyed()) return;

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
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: "Vellum",
    backgroundColor: "#0c0b0a",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  trustedMainWindow = mainWindow;

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
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  let disconnectNodeRefSink = (): void => undefined;
  const disconnect = (): void => {
    disconnectNodeRefSink();
    disconnectNodeRefSink = () => undefined;
  };
  const acknowledgeDelivery = (event: IpcMainEvent, deliveryId: unknown): void => {
    const record = activeNodeRefRelay;
    if (
      event.sender !== mainWindow.webContents ||
      typeof deliveryId !== "string" ||
      record?.id !== deliveryId
    ) {
      return;
    }
    void acknowledgeActiveNodeRef(record).then(requestNodeRefDrain).catch(() => {
      console.error("[node-ref] delivery acknowledgement callback failed");
    });
  };
  ipcMain.on(IPC_CHANNELS.nodeRefOpenedAck, acknowledgeDelivery);
  mainWindow.webContents.on("did-start-loading", () => {
    disconnect();
    const record = activeNodeRefRelay;
    if (record !== undefined) {
      void activateNodeRefRelay(record).catch(() => {
        console.error("[node-ref] renderer reload activation failed");
      });
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    disconnect();
    disconnectNodeRefSink = nodeRefIngress.connect((target) => {
      if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        throw new Error("renderer unavailable");
      }
      const record = activeNodeRefRelay;
      if (record === undefined || record.uri !== target.ref) {
        throw new Error("durable delivery unavailable");
      }
      const payload: NodeRefOpenedDelivery = {
        ...target,
        deliveryId: record.id,
      };
      mainWindow.webContents.send(IPC_CHANNELS.nodeRefOpened, payload);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  });
  mainWindow.on("closed", () => {
    if (trustedMainWindow === mainWindow) trustedMainWindow = undefined;
    disconnect();
    ipcMain.removeListener(IPC_CHANNELS.nodeRefOpenedAck, acknowledgeDelivery);
  });

  registerCrashRecovery(mainWindow);

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => {
      console.error("[window] renderer URL load failed");
    });
  } else {
    void mainWindow.loadURL(TRUSTED_RENDERER_URL).catch(() => {
      console.error("[window] trusted renderer load failed");
      if (!mainWindow.isDestroyed()) mainWindow.destroy();
      exitAfterDetach(1, "renderer-load-failure");
    });
  }

  return mainWindow;
};

const confirmBrowserAutomation = async (
  request: BrowserAutomationConfirmation,
): Promise<boolean> => {
  const mainWindow = trustedMainWindow;
  const prompt = buildBrowserAutomationNativePrompt(request);
  if (
    headless ||
    prompt === undefined ||
    mainWindow === undefined ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return false;
  }

  const result = await dialog.showMessageBox(mainWindow, {
    type: prompt.type,
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [...prompt.buttons],
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId,
    noLink: prompt.noLink,
  });
  return (
    result.response === 1 &&
    trustedMainWindow === mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  );
};

// Supervision handoff — the operator contract: whenever the LaunchAgent is
// installed, the running Vellum is ALWAYS the launchd-supervised instance.
// Cmd-Q stays quit for good (KeepAlive revives crashes only, never a
// deliberate quit); any manual re-open (Dock, Finder, `open`) routes itself
// through launchd via kickstart and exits, so crash supervision is never
// silently absent for the session the operator just started. Detection is by
// pid identity against `launchctl print`, never argv — immune to stale plists.
const LAUNCHD_LABEL = "skastr0.vellum";
// getuid is absent on non-POSIX platforms (where launchd cannot exist anyway);
// callers bail to standalone when no target can be formed.
const launchdTarget = (): string | undefined => {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `gui/${uid}/${LAUNCHD_LABEL}`;
};

const launchctl = (args: ReadonlyArray<string>): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile("/bin/launchctl", args as string[], (error, stdout) =>
      resolve({ ok: !error, stdout: stdout?.toString() ?? "" }),
    );
  });

// Returns true when THIS process should keep running (it is the supervised
// instance, or no LaunchAgent is installed, or the handoff failed safely).
const ensureSupervised = async (): Promise<boolean> => {
  if (!app.isPackaged) return true; // dev runs are never rerouted
  const target = launchdTarget();
  if (target === undefined) return true;
  const print = await launchctl(["print", target]);
  if (!print.ok) return true; // no LaunchAgent — standalone launch is legitimate
  const pidMatch = print.stdout.match(/\bpid = (\d+)/);
  if (pidMatch && Number(pidMatch[1]) === process.pid) return true; // we ARE supervised
  // Valid locators were published in the early event handler. A storage
  // failure drops only that locator; it never weakens launchd ownership or
  // prevents the app itself from starting.
  await flushNodeRefPublications();
  // Hand off: release the lock so the kickstarted instance can take it.
  app.releaseSingleInstanceLock();
  const kick = await launchctl(["kickstart", target]);
  if (kick.ok) {
    await flushNodeRefPublications();
    exitAfterDetach(0, "launchd-handoff");
    return false;
  }
  // Kickstart failed (odd job state) — reclaim the lock and run unsupervised
  // rather than leaving the operator with nothing. Durable relay records stay
  // intact for whichever process owns the lock.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  console.error("[launchd] kickstart failed — running unsupervised this session");
  return true;
};

// Single-instance lock — under a permanent/launchd deployment a second launch
// (Spotlight, `open`, a KeepAlive race) must NOT start a second process that
// would file-watch and clobber the same ~/.vellum/canvases document plane.
// The second process exits immediately; the first focuses its window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    requestNodeRefDrain();
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });

  void app.whenReady().then(async () => {
    if (!(await ensureSupervised())) return;

    try {
      if (app.isPackaged) {
        await installTrustedRendererProtocol(
          session.defaultSession.protocol,
          join(__dirname, "../renderer"),
        );
      }
      installTrustedRendererPermissionPolicy(
        session.defaultSession,
        () => trustedMainWindow,
        app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
      );
    } catch {
      console.error("[window] trusted renderer protocol setup failed");
      exitAfterDetach(1, "trusted-renderer-startup-failure");
      return;
    }

    nodeRefOwnerReady = true;
    requestNodeRefDrain();

    // Warm the resolved spawn environment (login-shell PATH + static floor) so
    // process.env.PATH is fixed before any adapter/service spawns a CLI. Never
    // rejects; adapters also await it lazily, so this is belt-and-suspenders.
    void resolvedSpawnEnv();

    registerIpcHandlers();

    // Warm the herdr ControlMaster sockets so the first real remote op rides
    // an already-open ssh connection instead of paying a fresh handshake.
    // Best-effort (masters.ts swallows failures) — never blocks startup.
    void warmAllHosts();
    powerMonitor.on("resume", () => {
      void warmAllHosts();
      try {
        browserComposition?.automation.reapAfterResume();
      } catch {
        console.error("[browser-automation] resume reap failed");
      }
    });

    // Per-host herdr state mirrors: snapshot + events.subscribe so list reads
    // answer instantly from local state. Best-effort; reads fall back to exec
    // whenever a mirror is not fresh.
    startAllMirrors();

    // Browser authority stays private until cold profile recovery completes.
    // The activation callback is the only place browser IPC, agent IPC, or
    // the local control socket can become reachable.
    try {
      browserComposition = await startBrowserComposition(
        {
          chat: chatService,
          herdr: herdrService,
          readCanvas: (name) =>
            AppRuntime.runPromise(
              Effect.flatMap(CanvasesService, (canvases) =>
                Effect.map(canvases.read(name), (result) => result.doc),
              ),
            ),
          resolvePageTarget: resolveBrowserPageTarget,
          getHerdrPaneMeta: async (host, session, paneId) => {
            const result = await herdrService.getPaneMeta(host, session, paneId);
            if (!result.ok) return { ok: false, code: result.code };
            const meta = result.data;
            return {
              ok: true,
              data: {
                paneId: meta.paneId,
                ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
                ...(meta.tabId === undefined ? {} : { tabId: meta.tabId }),
                ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
              },
            };
          },
          confirm: confirmBrowserAutomation,
        },
        async (composition) => {
          browserControl = await startBrowserControlServer({
            sessions: composition.sessions,
            capabilities: composition.automation.registry,
            resolvePageTarget: resolveBrowserPageTarget,
            version: app.getVersion(),
          });
          registerBrowserAgentIpc(ipcMain, composition.automation.runtime, (event) => {
            const mainWindow = trustedMainWindow;
            return (
              mainWindow !== undefined &&
              !mainWindow.isDestroyed() &&
              !mainWindow.webContents.isDestroyed() &&
              event.sender === mainWindow.webContents
            );
          });
          registerBrowserIpcHandlers(composition.sessions);
        },
      );
    } catch {
      browserComposition = undefined;
      try {
        browserControl?.close();
      } catch {
        // Startup is already failing closed; socket cleanup stays best-effort.
      }
      browserControl = undefined;
      console.error(BROWSER_COMPOSITION_STARTUP_FAILURE_MESSAGE);
      exitAfterDetach(1, "browser-composition-startup-failure");
      return;
    }

    if (!headless) createWindow();

    app.on("activate", () => {
      requestNodeRefDrain();
      if (!headless && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
    .catch(() => {
      console.error("[startup] initialization failed");
      exitAfterDetach(1, "startup-failure");
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const detachHerdrOnQuit = (reason: string) => {
  try {
    herdrStreams.detachAllOnQuit(reason);
  } catch (error) {
    console.error(`[herdr] detach on quit failed (${reason}):`, error);
  }
  // Mirrors close their events connections / ssh forwards; the herdr fleet
  // itself is untouched (read-only observers). Idempotent across signals.
  try {
    stopAllMirrors();
  } catch (error) {
    console.error(`[herdr] mirror stop on quit failed (${reason}):`, error);
  }
  // Browser product lock: quit detaches WebContentsViews only — warm sessions
  // are dropped with the process but profile partitions (cookies) are never
  // wiped and no session is explicitly destroyed.
  try {
    browserComposition?.sessions.detachAllOnQuit(reason);
  } catch (error) {
    console.error(`[browser] detach on quit failed (${reason}):`, error);
  }
};

let runtimeDetachedForQuit = false;

const detachRuntimeOnQuit = (reason: string): void => {
  if (runtimeDetachedForQuit) return;
  runtimeDetachedForQuit = true;

  // Stop the read-only adapter plane first. Its one-shot CLI groups are
  // Vellum-owned and must never outlive the app; Herdr sessions use a separate
  // explicitly detached server plane and remain untouched below.
  terminateAdapterChildrenOnQuit();

  // Revoke authority before closing the socket or detaching browser views.
  // Registry termination destroys only automation-owner WebContentsViews;
  // profile partitions and unrelated renderer-owned views remain intact.
  try {
    browserComposition?.automation.close();
  } catch (error) {
    console.error(`[browser-automation] close on quit failed (${reason}):`, error);
  }

  try {
    browserControl?.close();
  } catch (error) {
    console.error(`[browser-control] close on quit failed (${reason}):`, error);
  }
  browserControl = undefined;

  // Herdr product lock: quit / relaunch / launchd unload detaches control only.
  // Never pane close, tab close, or session stop. The fleet keeps running.
  detachHerdrOnQuit(reason);
  browserComposition = undefined;
};

// Electron app.exit() bypasses before-quit and will-quit. Every direct exit
// therefore routes through the same authority/process teardown explicitly.
const exitAfterDetach = (exitCode: number, reason: string): void => {
  detachRuntimeOnQuit(reason);
  app.exit(exitCode);
};

app.on("before-quit", () => {
  nodeRefRelayWatcher?.close();
  nodeRefRelayWatcher = undefined;
  detachRuntimeOnQuit("before-quit");
  void AppRuntime.dispose();
});

app.on("will-quit", () => {
  detachRuntimeOnQuit("will-quit");
});

// Registered SIGTERM/SIGINT listeners suppress Node's default process exit.
// Detach authority first, request Electron's normal quit sequence, and retain
// a bounded hard-exit fallback if another listener prevents that sequence.
installProcessSignalTermination({
  app,
  cleanup: (signal) => detachRuntimeOnQuit(signal),
});
