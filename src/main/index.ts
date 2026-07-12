import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { AppRuntime } from "./runtime";
import { registerIpcHandlers } from "./ipc";

// Dev-only: expose the Chrome DevTools Protocol so agents can drive the app
// end to end (screenshot, click, evaluate) over CDP. Never in packaged builds.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}

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

  // Dev observability: forward the renderer console + crash/hang signals to the
  // main process stdout so failures are visible in the terminal log. Open
  // devtools with Cmd+Opt+I as usual; this only makes headless failures loud.
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer:${level === 3 ? "error" : "warn"}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.log(`[renderer:gone] ${details.reason} (exitCode ${details.exitCode})`);
    });
    mainWindow.webContents.on("unresponsive", () => console.log("[renderer:unresponsive]"));
    mainWindow.webContents.on("preload-error", (_event, path, error) => {
      console.log(`[preload:error] ${path}: ${error.message}`);
    });
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
};

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void AppRuntime.dispose();
});
