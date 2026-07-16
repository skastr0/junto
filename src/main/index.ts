import { execFile } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { resolvedSpawnEnv } from "./vellum/adapters/exec";
import { AppRuntime } from "./runtime";
import { registerIpcHandlers } from "./ipc";
import { herdrStreams } from "./vellum/herdr/stream";
import { browserSessions } from "./vellum/browser/ipc";
import { startBrowserControlServer, type BrowserControlServer } from "./vellum/browser/control";

// Dev-only: expose the Chrome DevTools Protocol so agents can drive the app
// end to end (screenshot, click, evaluate) over CDP. Never in packaged builds.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}

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
      app.exit(0);
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  registerCrashRecovery(mainWindow);

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
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
  // Hand off: release the lock so the kickstarted instance can take it.
  app.releaseSingleInstanceLock();
  const kick = await launchctl(["kickstart", target]);
  if (kick.ok) {
    app.exit(0);
    return false;
  }
  // Kickstart failed (odd job state) — reclaim the lock and run unsupervised
  // rather than leaving the operator with nothing; say so loudly.
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
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });

  app.whenReady().then(async () => {
    if (!(await ensureSupervised())) return;

    // Warm the resolved spawn environment (login-shell PATH + static floor) so
    // process.env.PATH is fixed before any adapter/service spawns a CLI. Never
    // rejects; adapters also await it lazily, so this is belt-and-suspenders.
    void resolvedSpawnEnv();

    registerIpcHandlers();

    // Agent control plane (unix socket + token). App-hosted: exists exactly as
    // long as the runtime that owns the warm sessions does.
    try {
      browserControl = startBrowserControlServer({
        sessions: browserSessions,
        version: app.getVersion(),
      });
    } catch (error) {
      console.error("[browser-control] failed to start:", error);
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Herdr product lock: quit / relaunch / launchd unload MUST detach control only.
// Never pane close, tab close, or session stop. The fleet keeps running.
let browserControl: BrowserControlServer | undefined;

const detachHerdrOnQuit = (reason: string) => {
  try {
    herdrStreams.detachAllOnQuit(reason);
  } catch (error) {
    console.error(`[herdr] detach on quit failed (${reason}):`, error);
  }
  // Browser product lock: quit detaches WebContentsViews only — warm sessions
  // are dropped with the process but profile partitions (cookies) are never
  // wiped and no session is explicitly destroyed.
  try {
    browserSessions.detachAllOnQuit(reason);
  } catch (error) {
    console.error(`[browser] detach on quit failed (${reason}):`, error);
  }
};

app.on("before-quit", () => {
  detachHerdrOnQuit("before-quit");
  // Close the control socket so the CLI reports runtime_down instead of hanging.
  try {
    browserControl?.close();
  } catch (error) {
    console.error("[browser-control] close on quit failed:", error);
  }
  void AppRuntime.dispose();
});

app.on("will-quit", () => {
  detachHerdrOnQuit("will-quit");
});

// launchd bootout / kill send SIGTERM before exit; release control without murder.
process.on("SIGTERM", () => {
  detachHerdrOnQuit("SIGTERM");
});
process.on("SIGINT", () => {
  detachHerdrOnQuit("SIGINT");
});
