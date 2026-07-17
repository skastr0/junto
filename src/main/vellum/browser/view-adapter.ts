import { BrowserWindow, WebContentsView } from "electron";
import type { BrowserSurfaceBounds } from "@shared/ipc";
import type { BrowserViewAdapter, BrowserViewHandle } from "./sessions";

// The only file that touches Electron for browser sessions. Views are parented
// under the main BrowserWindow.contentView (native layer, above the renderer)
// — never under an xyflow node; the renderer only measures the DOM rect and
// sends it over browserSetBounds. Kept thin on purpose: all decisions
// (eviction, state, url policy) live in sessions.ts / shared/browser.ts.

const mainWindow = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0];

const normalizeUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

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

  let expectedNavigation: { readonly url: string; readonly sessionId: string } | undefined;
  let activeNavigation: { readonly url: string; readonly sessionId: string } | undefined;
  let currentSessionId: string | undefined;

  view.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    const previousNavigation = activeNavigation;
    const expected = expectedNavigation;
    expectedNavigation = undefined;
    const normalizedUrl = normalizeUrl(details.url);
    const expectedSessionId = expected?.url === normalizedUrl ? expected.sessionId : undefined;
    const sessionId = events.onNavigationStart({
      url: normalizedUrl,
      isSameDocument: details.isSameDocument,
      ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
    });
    currentSessionId = sessionId;
    if (!details.isSameDocument && sessionId !== undefined) {
      if (previousNavigation !== undefined) {
        activeNavigation = undefined;
        currentSessionId = undefined;
        events.onNavigationAmbiguous(sessionId);
        return;
      }
      activeNavigation = { url: normalizedUrl, sessionId };
    }
  });
  view.webContents.on("did-redirect-navigation", (details) => {
    if (!details.isMainFrame || activeNavigation === undefined) return;
    const url = normalizeUrl(details.url);
    activeNavigation = { ...activeNavigation, url };
    events.onNavigationUrl(activeNavigation.sessionId, url);
  });
  view.webContents.on("did-navigate", (_event, url) => {
    if (activeNavigation === undefined) return;
    const normalizedUrl = normalizeUrl(url);
    activeNavigation = { ...activeNavigation, url: normalizedUrl };
    events.onNavigationUrl(activeNavigation.sessionId, normalizedUrl);
  });
  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame || currentSessionId === undefined) return;
    events.onNavigationUrl(currentSessionId, normalizeUrl(url));
  });
  view.webContents.on("did-finish-load", () => {
    const active = activeNavigation;
    if (active === undefined || normalizeUrl(view.webContents.getURL()) !== active.url) return;
    activeNavigation = undefined;
    events.onLoadOk(active.sessionId, view.webContents.getTitle() || undefined);
  });
  view.webContents.on("did-fail-load", (_e, code, description, validatedUrl, isMainFrame) => {
    // -3 (ABORTED) fires on in-page redirects/cancelled provisional loads;
    // it is not a user-visible failure.
    if (code === -3 || !isMainFrame) return;
    const active = activeNavigation;
    if (active === undefined || active.url !== normalizeUrl(validatedUrl)) return;
    activeNavigation = undefined;
    events.onLoadFail(active.sessionId, `${description || "load failed"} (${code})`);
  });

  // The window this view is actually parented under — tracked locally because
  // sessions.ts's `attached` boolean can go stale across a window close/reopen
  // (mac red-button close + Dock reopen creates a NEW BrowserWindow; nothing
  // resets `attached`). setBounds self-heals against that staleness by
  // re-parenting whenever the live window differs from the one last attached
  // to, so a setBounds call is always enough to make the surface visible
  // again regardless of what the caller's bookkeeping believes.
  let attachedWindow: BrowserWindow | undefined;

  const handle: BrowserViewHandle = {
    loadUrl: (url, expectedSessionId) => {
      expectedNavigation = { url: normalizeUrl(url), sessionId: expectedSessionId };
      void view.webContents.loadURL(url);
    },
    attach: (bounds) => {
      const win = mainWindow();
      if (!win || win.isDestroyed()) return;
      win.contentView.addChildView(view);
      attachedWindow = win;
      handle.setBounds(bounds);
    },
    setBounds: (bounds: BrowserSurfaceBounds) => {
      const win = mainWindow();
      if (win && !win.isDestroyed() && win !== attachedWindow) {
        win.contentView.addChildView(view);
        attachedWindow = win;
      }
      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    },
    detach: () => {
      if (attachedWindow && !attachedWindow.isDestroyed()) {
        attachedWindow.contentView.removeChildView(view);
      }
      attachedWindow = undefined;
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
