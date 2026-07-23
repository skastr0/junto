/**
 * Main-process ownership of the native parent for untrusted browser views.
 *
 * This module deliberately has no Electron import. The application supplies
 * construction of the one hidden BrowserWindow it owns, and the view adapter
 * supplies the detach/rebind operations. Keeping both seams explicit makes a
 * headless station a first-class Chromium host without turning an arbitrary
 * renderer window into ambient authority.
 */

export interface BrowserCompositionHostWindow {
  readonly isDestroyed: () => boolean;
  readonly destroy: () => void;
}

export interface HiddenCompositionHostWindowOptions {
  readonly show: false;
  readonly focusable: false;
  readonly skipTaskbar: true;
  readonly webPreferences: Readonly<{
    readonly sandbox: true;
    readonly nodeIntegration: false;
    readonly contextIsolation: true;
  }>;
}

/**
 * This is intentionally a BrowserWindow constructor input, not renderer
 * configuration. In particular it has no preload and this module has no URL
 * loading surface: the hidden window exists only to parent WebContentsViews.
 */
export const HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS: HiddenCompositionHostWindowOptions =
  Object.freeze({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: Object.freeze({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    }),
  });

export interface BrowserCompositionViewBinder {
  /** Remove every native child before the parent host changes or is destroyed. */
  readonly detach: () => void | Promise<void>;
  /** Reparent retained views to the selected native host. */
  readonly rebind: (host: BrowserCompositionHostWindow) => void | Promise<void>;
}

export interface BrowserCompositionHost {
  /** The one native parent currently selected for browser views, if any. */
  readonly current: () => BrowserCompositionHostWindow | undefined;
  /** Construct and select the singleton hidden host for a headless station. */
  readonly ensureHeadlessHost: () => Promise<BrowserCompositionHostWindow>;
  /** Select the current visible Command Center window as the view parent. */
  readonly bindVisibleWindow: (window: BrowserCompositionHostWindow) => Promise<void>;
  /** Drop a closing visible window only when it is still the selected parent. */
  readonly releaseVisibleWindow: (window: BrowserCompositionHostWindow) => Promise<void>;
  /** Idempotently detach views, then destroy only the hidden window we own. */
  readonly shutdown: () => Promise<void>;
}

export interface BrowserCompositionHostDependencies {
  readonly createHiddenWindow: (
    options: HiddenCompositionHostWindowOptions,
  ) => BrowserCompositionHostWindow;
  readonly views: BrowserCompositionViewBinder;
}

type ActiveHost = Readonly<{
  readonly kind: "hidden" | "visible";
  readonly window: BrowserCompositionHostWindow;
}>;

const usable = (window: BrowserCompositionHostWindow): boolean => !window.isDestroyed();

/**
 * Serialize host changes. A close/recreate signal may arrive while a browser
 * session is opening; that race gets one deterministic detach -> rebind
 * sequence instead of a global BrowserWindow lookup.
 */
export const makeBrowserCompositionHost = (
  dependencies: BrowserCompositionHostDependencies,
): BrowserCompositionHost => {
  let active: ActiveHost | undefined;
  let transitions: Promise<void> = Promise.resolve();
  let shutdownFlight: Promise<void> | undefined;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transitions.then(operation, operation);
    transitions = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const destroyOwnedHidden = (candidate: ActiveHost | undefined): void => {
    if (candidate?.kind !== "hidden" || !usable(candidate.window)) return;
    candidate.window.destroy();
  };

  const select = async (next: ActiveHost): Promise<void> => {
    const previous = active;
    if (previous?.window === next.window && previous.kind === next.kind) return;

    await dependencies.views.detach();
    active = next;
    await dependencies.views.rebind(next.window);
    destroyOwnedHidden(previous);
  };

  const ensureHeadlessHost = (): Promise<BrowserCompositionHostWindow> =>
    enqueue(async () => {
      if (active?.kind === "hidden" && usable(active.window)) return active.window;
      if (active?.kind === "visible" && usable(active.window)) {
        throw new Error("cannot create a headless composition host while a visible host is bound");
      }

      const window = dependencies.createHiddenWindow(HIDDEN_COMPOSITION_HOST_WINDOW_OPTIONS);
      if (!usable(window)) throw new Error("hidden composition host was destroyed during creation");
      await select({ kind: "hidden", window });
      return window;
    });

  const bindVisibleWindow = (window: BrowserCompositionHostWindow): Promise<void> =>
    enqueue(async () => {
      if (!usable(window)) throw new Error("cannot bind a destroyed visible composition host");
      await select({ kind: "visible", window });
    });

  const releaseVisibleWindow = (window: BrowserCompositionHostWindow): Promise<void> =>
    enqueue(async () => {
      if (active?.kind !== "visible" || active.window !== window) return;
      await dependencies.views.detach();
      active = undefined;
    });

  const shutdown = (): Promise<void> => {
    if (shutdownFlight !== undefined) return shutdownFlight;
    shutdownFlight = enqueue(async () => {
      const previous = active;
      try {
        await dependencies.views.detach();
      } finally {
        active = undefined;
        destroyOwnedHidden(previous);
      }
    });
    return shutdownFlight;
  };

  return Object.freeze({
    current: () => (active !== undefined && usable(active.window) ? active.window : undefined),
    ensureHeadlessHost,
    bindVisibleWindow,
    releaseVisibleWindow,
    shutdown,
  });
};
