import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { resolvedSpawnEnv } from "./vellum/adapters/exec";
import { AppRuntime } from "./runtime";
import { registerIpcHandlers } from "./ipc";

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

  app.whenReady().then(() => {
    // Warm the resolved spawn environment (login-shell PATH + static floor) so
    // process.env.PATH is fixed before any adapter/service spawns a CLI. Never
    // rejects; adapters also await it lazily, so this is belt-and-suspenders.
    void resolvedSpawnEnv();

    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void AppRuntime.dispose();
});
