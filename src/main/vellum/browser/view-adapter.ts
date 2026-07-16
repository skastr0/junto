import { BrowserWindow, WebContentsView } from "electron";
import type { BrowserSurfaceBounds } from "@shared/ipc";
import type { BrowserViewAdapter, BrowserViewHandle } from "./sessions";

// The only file that touches Electron for browser sessions. Views are parented
// under the main BrowserWindow.contentView (native layer, above the renderer)
// — never under an xyflow node; the renderer only measures the DOM rect and
// sends it over browserSetBounds. Kept thin on purpose: all decisions
// (eviction, state, url policy) live in sessions.ts / shared/browser.ts.

const mainWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0];

export const electronViewAdapter: BrowserViewAdapter = (partition, events) => {
  const view = new WebContentsView({
    webPreferences: {
      partition,
      // Page content is untrusted web — fully sandboxed, no preload, no node.
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  view.webContents.on("did-start-loading", () => events.onLoadStart());
  view.webContents.on("did-finish-load", () =>
    events.onLoadOk(view.webContents.getTitle() || undefined),
  );
  view.webContents.on("did-fail-load", (_e, code, description) => {
    // -3 (ABORTED) fires on in-page redirects/cancelled provisional loads;
    // it is not a user-visible failure.
    if (code !== -3) events.onLoadFail(`${description || "load failed"} (${code})`);
  });

  const handle: BrowserViewHandle = {
    loadUrl: (url) => {
      void view.webContents.loadURL(url);
    },
    attach: (bounds) => {
      const win = mainWindow();
      if (!win || win.isDestroyed()) return;
      win.contentView.addChildView(view);
      handle.setBounds(bounds);
    },
    setBounds: (bounds: BrowserSurfaceBounds) => {
      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    },
    detach: () => {
      const win = mainWindow();
      if (!win || win.isDestroyed()) return;
      win.contentView.removeChildView(view);
    },
    destroy: () => {
      // Runtime teardown only — the persist: partition (cookies) is on disk.
      view.webContents.close();
    },
    // Control-plane seams (unix-socket HttpApi). userGesture=false: agent code
    // gets no synthetic-gesture privileges in the untrusted page.
    executeJavaScript: (code) => view.webContents.executeJavaScript(code, false),
    capturePagePng: async () => {
      const image = await view.webContents.capturePage();
      return new Uint8Array(image.toPNG());
    },
  };
  return handle;
};
