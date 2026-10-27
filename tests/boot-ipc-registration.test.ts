/**
 * Main's boot-time IPC registration, against an `ipcMain` that behaves like
 * Electron's: an EventEmitter whose `on` needs its `this`, and a `handle`
 * that refuses a second handler for one channel. A registrar that throws
 * here throws in `app.whenReady`, before the first window (3776924fc called
 * `ipcMain.on` unbound, fixed in 7fa6cb0c7). A real launch is
 * `e2e/scenarios/free-startup.spec.ts`, which `bun run verify` runs; this is
 * the commit-time stand-in for main. The preload's is
 * `tests/preload-bundle.test.ts`.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: ReadonlyArray<unknown>) => unknown;

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, handler);
  }

  handleOnce(channel: string, handler: Handler): void {
    this.handle(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

const electron = vi.hoisted(() => ({ ipcMain: undefined as unknown }));

// Anything main touches on Electron besides ipcMain, at import or while
// registering, answers with itself.
const inert: unknown = new Proxy(function inert() {}, {
  get: (_target, key) =>
    key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : inert,
  apply: () => inert,
  construct: () => inert as object,
});

// Electron's main-process exports.
const ELECTRON_MAIN = [
  "app", "autoUpdater", "BaseWindow", "BrowserView", "BrowserWindow", "clipboard",
  "contentTracing", "crashReporter", "desktopCapturer", "dialog", "globalShortcut",
  "inAppPurchase", "ImageView", "Menu", "MenuItem", "MessageChannelMain",
  "nativeImage", "nativeTheme", "net", "netLog", "Notification", "powerMonitor",
  "powerSaveBlocker", "protocol", "pushNotifications", "safeStorage", "screen",
  "session", "ShareMenu", "shell", "systemPreferences", "TouchBar", "Tray",
  "utilityProcess", "View", "webContents", "WebContentsView", "webFrameMain",
] as const;

vi.mock("electron", () => {
  electron.ipcMain = new FakeIpcMain();
  const module = Object.fromEntries(ELECTRON_MAIN.map((name) => [name, inert]));
  return { ...module, ipcMain: electron.ipcMain, default: { ...module, ipcMain: electron.ipcMain } };
});

// Vitest has no `?nodeWorker` import: the worker module would run on this
// thread and refuse. The host is not called while registering.
vi.mock("../src/main/junto/files/index-worker-host", () => ({ workerRootIndex: () => inert }));

// Some registrars start work on the app runtime; what it does is not under test.
vi.mock("../src/main/runtime", () => ({
  AppRuntime: { runPromise: async () => undefined, runFork: () => undefined },
}));

beforeEach(() => {
  vi.resetModules();
});

describe("main boot IPC registration", () => {
  it("registers every boot-time channel on a real-shaped ipcMain without throwing", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const { registerDemoIpcHandlers } = await import("../src/main/junto/demo/ipc");
    const { registerCompanionIpc } = await import("../src/main/junto/companion/ipc");
    const { registerNotificationIpc } = await import("../src/main/junto/notifications/ipc");
    const { registerFilesIpc } = await import("../src/main/junto/files/ipc");

    // In src/main/index.ts boot order.
    registerIpcHandlers();
    registerDemoIpcHandlers();
    registerCompanionIpc();
    registerNotificationIpc({ window: () => undefined, enabled: false });
    registerFilesIpc();

    const ipcMain = electron.ipcMain as FakeIpcMain;
    expect(ipcMain.handlers.size).toBeGreaterThan(50);
    expect(ipcMain.eventNames().length).toBeGreaterThan(0);
  }, 60_000);

  it("is strict the way Electron is: ipcMain.on unbound throws, as in 3776924fc", () => {
    const ipcMain = new FakeIpcMain();
    const on = ipcMain.on;
    expect(() => on("junto:test", () => undefined)).toThrow(TypeError);
    ipcMain.handle("junto:test", () => undefined);
    expect(() => ipcMain.handle("junto:test", () => undefined)).toThrow(/second handler/);
  });
});
