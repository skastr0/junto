import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { isAllowedBrowserUrl } from "@shared/browser";
import {
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_EVAL_RESULT_NODES,
  isUtf8WithinLimit,
} from "@shared/browser-limits";
import type { BrowserSurfaceBounds } from "@shared/ipc";
import type { BrowserViewAdapter, BrowserViewHandle } from "./sessions";
import type {
  BrowserCompositionHostWindow,
  BrowserCompositionViewBinder,
} from "./composition-host";
import {
  ensureManagedBrowserPartitionNetwork,
  releaseManagedBrowserPartitionNetwork,
} from "./partition-network";
import {
  canonicalBrowserOrigin,
  hardenBrowserPartition,
  installBrowserWebPolicy,
  isAllowedByBrowserExactOrigin,
  isAllowedByBrowserTestOnlyExactOriginGrant,
  makeBrowserTestOnlyExactOriginGrant,
  type BrowserTestOnlyExactOriginGrant,
} from "./web-policy";

const { session } = electron;
type ElectronWebContentsViewConstructor = typeof electron.WebContentsView;

const requireWebContentsView = (): ElectronWebContentsViewConstructor => {
  const candidate: unknown = Reflect.get(electron, "WebContentsView");
  if (typeof candidate !== "function") {
    throw new Error("Electron WebContentsView is unavailable");
  }
  return candidate as ElectronWebContentsViewConstructor;
};

// The only file that touches Electron for browser sessions. Views are parented
// through an explicit composition host (native layer, above the renderer) —
// never under an xyflow node; the renderer only measures the DOM rect and
// sends it over browserSetBounds. Kept thin on purpose: all decisions
// (eviction, state, url policy) live in sessions.ts / shared/browser.ts.

interface AttachedElectronView {
  readonly view: electron.WebContentsView;
  readonly isAttached: () => boolean;
  readonly attachTo: (host: ElectronBrowserWindow) => void;
  readonly detachFromHost: () => void;
}

export interface ElectronBrowserViewAttachmentTarget extends BrowserCompositionViewBinder {
  readonly adapter: BrowserViewAdapter;
}

const normalizeUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

const isAbortedLoadError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const errno = "errno" in error ? error.errno : undefined;
  const message = "message" in error ? error.message : undefined;
  return (
    code === -3 ||
    errno === -3 ||
    code === "ERR_ABORTED" ||
    (typeof message === "string" && message.includes("ERR_ABORTED"))
  );
};

const loadErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "load failed";

export const BROWSER_AUTOMATION_WORLD_ID = 10_001;

const runBoundedEvalInPage = async (
  source: string,
  maxBytes: number,
  maxDepth: number,
  maxNodes: number,
): Promise<unknown> => {
  // This dedicated isolated world is pristine on first use. Lock every
  // intrinsic used below before evaluating agent source so one operation
  // cannot poison the serializer used by this or a later operation.
  const globalObject = globalThis;
  const objectConstructor = Object;
  const arrayConstructor = Array;
  const functionConstructor = Function;
  const numberConstructor = Number;
  const promiseConstructor = Promise;
  const stringConstructor = String;
  const textEncoderConstructor = TextEncoder;
  const weakSetConstructor = WeakSet;
  const jsonObject = JSON;
  const reflectObject = Reflect;
  const indirectEval = eval;

  const defineProperty = objectConstructor.defineProperty;
  const freeze = objectConstructor.freeze;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  const getPrototypeOf = objectConstructor.getPrototypeOf;
  const arrayIsArray = arrayConstructor.isArray;
  const numberIsFinite = numberConstructor.isFinite;
  const numberIsInteger = numberConstructor.isInteger;
  const reflectOwnKeys = reflectObject.ownKeys;
  const hasOwnProperty = objectConstructor.prototype.hasOwnProperty;
  const hasOwn = (value: object, key: PropertyKey): boolean =>
    hasOwnProperty.call(value, key);
  const charCodeAt = stringConstructor.prototype.charCodeAt;
  const fromCharCode = stringConstructor.fromCharCode;

  const encoder = new textEncoderConstructor();
  const encode = encoder.encode.bind(encoder);
  const parts: string[] = [];
  const pushPart = parts.push.bind(parts);
  const joinParts = parts.join.bind(parts);
  const seen = new weakSetConstructor<object>();
  const seenHas = seen.has.bind(seen);
  const seenAdd = seen.add.bind(seen);
  const seenDelete = seen.delete.bind(seen);
  const tooLarge = freeze({ kind: "result_too_large" });
  const unsupported = freeze({ kind: "unsupported_result" });

  try {
    const lockedGlobals: ReadonlyArray<readonly [string, unknown]> = [
      ["Array", arrayConstructor],
      ["Function", functionConstructor],
      ["JSON", jsonObject],
      ["Number", numberConstructor],
      ["Object", objectConstructor],
      ["Promise", promiseConstructor],
      ["Reflect", reflectObject],
      ["String", stringConstructor],
      ["TextEncoder", textEncoderConstructor],
      ["WeakSet", weakSetConstructor],
      ["eval", indirectEval],
      ["globalThis", globalObject],
    ];
    for (const [name, value] of lockedGlobals) {
      const descriptor = getOwnPropertyDescriptor(globalObject, name);
      defineProperty(globalObject, name, {
        value,
        writable: false,
        configurable: false,
        enumerable: descriptor?.enumerable ?? false,
      });
    }
    for (const prototype of [
      objectConstructor.prototype,
      arrayConstructor.prototype,
      functionConstructor.prototype,
      numberConstructor.prototype,
      promiseConstructor.prototype,
      stringConstructor.prototype,
      textEncoderConstructor.prototype,
      weakSetConstructor.prototype,
    ]) {
      freeze(prototype);
    }
    for (const value of [
      objectConstructor,
      arrayConstructor,
      functionConstructor,
      numberConstructor,
      promiseConstructor,
      stringConstructor,
      textEncoderConstructor,
      weakSetConstructor,
      jsonObject,
      reflectObject,
      indirectEval,
    ]) {
      freeze(value);
    }
  } catch {
    return {
      __juntoEval: 1,
      status: "unsupported_result",
      message: "isolated serializer intrinsics unavailable",
    };
  }

  // Calling through an alias makes this indirect eval: automation runs in the
  // isolated world's global scope, not inside this wrapper's lexical scope.
  // Await preserves expression completion values and promise completion.
  const result = await indirectEval(source);
  let byteCount = 0;
  let nodeCount = 0;

  const append = (part: string): void => {
    const partBytes = encode(part).byteLength;
    if (partBytes > maxBytes - byteCount) throw tooLarge;
    byteCount += partBytes;
    pushPart(part);
  };

  const appendHexEscape = (code: number): void => {
    const hex = code.toString(16).padStart(4, "0");
    append(`\\u${hex}`);
  };

  const appendString = (value: string): void => {
    append('"');
    for (let index = 0; index < value.length; index += 1) {
      const code = charCodeAt.call(value, index);
      if (code === 0x22) append('\\"');
      else if (code === 0x5c) append("\\\\");
      else if (code === 0x08) append("\\b");
      else if (code === 0x09) append("\\t");
      else if (code === 0x0a) append("\\n");
      else if (code === 0x0c) append("\\f");
      else if (code === 0x0d) append("\\r");
      else if (code < 0x20) appendHexEscape(code);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = index + 1 < value.length ? charCodeAt.call(value, index + 1) : -1;
        if (next >= 0xdc00 && next <= 0xdfff) {
          append(fromCharCode(code, next));
          index += 1;
        } else {
          appendHexEscape(code);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        appendHexEscape(code);
      } else {
        append(fromCharCode(code));
      }
    }
    append('"');
  };

  const dataDescriptorValue = (value: object, key: PropertyKey): unknown => {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !hasOwn(descriptor, "value") ||
      hasOwn(descriptor, "get") ||
      hasOwn(descriptor, "set")
    ) {
      throw unsupported;
    }
    return descriptor.value;
  };

  const serialize = (value: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > maxNodes) throw tooLarge;

    if (value === null) {
      append("null");
      return;
    }
    if (typeof value === "string") {
      appendString(value);
      return;
    }
    if (typeof value === "boolean") {
      append(value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      if (!numberIsFinite(value)) throw unsupported;
      append(jsonObject.stringify(value));
      return;
    }
    if (typeof value !== "object") throw unsupported;
    if (depth >= maxDepth) throw tooLarge;
    if (seenHas(value)) throw unsupported;
    seenAdd(value);

    try {
      if (arrayIsArray(value)) {
        if (getPrototypeOf(value) !== arrayConstructor.prototype) throw unsupported;
        const length = dataDescriptorValue(value, "length");
        if (
          typeof length !== "number" ||
          !numberIsInteger(length) ||
          length < 0 ||
          length > maxNodes - nodeCount
        ) {
          throw tooLarge;
        }
        const keys = reflectOwnKeys(value);
        if (keys.length !== length + 1) throw unsupported;
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string") throw unsupported;
          const index = numberConstructor(key);
          if (
            !numberIsInteger(index) ||
            index < 0 ||
            index >= length ||
            stringConstructor(index) !== key
          ) {
            throw unsupported;
          }
        }

        append("[");
        for (let index = 0; index < length; index += 1) {
          if (index > 0) append(",");
          const descriptor = getOwnPropertyDescriptor(value, stringConstructor(index));
          if (descriptor?.enumerable !== true) throw unsupported;
          serialize(dataDescriptorValue(value, stringConstructor(index)), depth + 1);
        }
        append("]");
        return;
      }

      const prototype = getPrototypeOf(value);
      if (prototype !== objectConstructor.prototype && prototype !== null) throw unsupported;
      const keys = reflectOwnKeys(value);
      if (keys.length > maxNodes - nodeCount) throw tooLarge;
      append("{");
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (typeof key !== "string") throw unsupported;
        const descriptor = getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable !== true) throw unsupported;
        if (index > 0) append(",");
        appendString(key);
        append(":");
        serialize(dataDescriptorValue(value, key), depth + 1);
      }
      append("}");
    } finally {
      seenDelete(value);
    }
  };

  try {
    serialize(result, 0);
    return { __juntoEval: 1, status: "ok", json: joinParts("") };
  } catch (error) {
    if (error === tooLarge) {
      return {
        __juntoEval: 1,
        status: "result_too_large",
        message: "eval result exceeds a hard serialization limit",
      };
    }
    return {
      __juntoEval: 1,
      status: "unsupported_result",
      message: "eval result is not finite plain JSON",
    };
  }
};

export const buildBoundedEvalScript = (source: string): string => {
  if (!isUtf8WithinLimit(source, BROWSER_MAX_EVAL_CODE_BYTES)) {
    throw new RangeError("eval source exceeds the hard limit");
  }
  return `(${runBoundedEvalInPage.toString()})(${JSON.stringify(source)},${BROWSER_MAX_EVAL_RESULT_BYTES},${BROWSER_MAX_EVAL_RESULT_DEPTH},${BROWSER_MAX_EVAL_RESULT_NODES})`;
};

const makeElectronViewAdapter = (
  attachmentTarget?: {
    readonly register: (view: AttachedElectronView) => () => void;
    readonly current: () => ElectronBrowserWindow | undefined;
  },
  testOnlyGrant?: BrowserTestOnlyExactOriginGrant,
  testOnlyDownloadPath?: string,
): BrowserViewAdapter => async (partition, events, options) => {
  const WebContentsView = requireWebContentsView();
  const browserPartition = session.fromPartition(partition);
  // Downloads land in app-owned state, never ~/Downloads: a managed page
  // download must not bill a TCC prompt to Junto.
  const downloadPath =
    testOnlyDownloadPath ?? join(electron.app.getPath("userData"), "downloads");
  mkdirSync(downloadPath, { recursive: true });
  browserPartition.setDownloadPath(downloadPath);
  await ensureManagedBrowserPartitionNetwork(browserPartition, partition, testOnlyGrant);
  hardenBrowserPartition(browserPartition, testOnlyGrant);
  const view = new WebContentsView({
    webPreferences: {
      session: browserPartition,
      // Page content is untrusted web — fully sandboxed, no preload, no node.
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  });
  let terminationExpected = false;
  let unexpectedTerminationReported = false;
  const reportUnexpectedTermination = (): void => {
    if (terminationExpected || unexpectedTerminationReported) return;
    unexpectedTerminationReported = true;
    events.onUnexpectedTermination();
  };
  const destroyed = new Promise<void>((resolveDestroyed) => {
    view.webContents.once("destroyed", () => {
      resolveDestroyed();
      reportUnexpectedTermination();
    });
  });
  view.webContents.on("render-process-gone", reportUnexpectedTermination);

  let expectedNavigation: { readonly url: string; readonly sessionId: string } | undefined;
  let activeNavigation: { readonly url: string; readonly sessionId: string } | undefined;
  let currentSessionId: string | undefined;
  let exactTopLevelOrigin =
    options?.exactTopLevelOrigin === undefined
      ? undefined
      : canonicalBrowserOrigin(options.exactTopLevelOrigin);
  let releaseWebPolicy: (() => void) | undefined;
  let initializationFailure: Error | undefined;
  try {
    releaseWebPolicy = installBrowserWebPolicy(
      view.webContents,
      {
        onBlockedTopLevelNavigation: (reason) => {
          const active = activeNavigation;
          if (active === undefined) return;
          expectedNavigation = undefined;
          activeNavigation = undefined;
          currentSessionId = active.sessionId;
          events.onLoadFail(active.sessionId, `navigation blocked by browser policy (${reason})`);
        },
      },
      testOnlyGrant,
      exactTopLevelOrigin === undefined
        ? undefined
        : (url) =>
            exactTopLevelOrigin !== undefined &&
            isAllowedByBrowserExactOrigin(url, exactTopLevelOrigin),
    );
  } catch (error) {
    // Return a teardown-capable failed handle instead of throwing after the
    // WebContents already exists. BrowserSessionService will retain its
    // destroyed witness before requesting close, so factory cleanup cannot
    // disappear from the app shutdown receipt.
    initializationFailure = error instanceof Error
      ? error
      : new Error("browser view policy initialization failed");
  }
  if (releaseWebPolicy !== undefined) {
    view.webContents.once("destroyed", releaseWebPolicy);
  }

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

  // Physical attachment is distinct from the session's logical attachment.
  // The composition host detaches/rebinds physical parents as windows close
  // or reopen while the retained session identity stays intact.
  let attachedWindow: ElectronBrowserWindow | undefined;
  let logicallyAttached = false;
  // Renderer zeros bounds when the surface is hidden. A 0×0 attached
  // WebContentsView still presents and can run page animation/WebGL at full
  // rate; park instead of keeping that rect on the composition host.
  let parked = false;
  const callOptionalMethod = (
    target: object,
    method: string,
    ...args: ReadonlyArray<unknown>
  ): void => {
    const candidate: unknown = Reflect.get(target, method);
    if (typeof candidate !== "function") return;
    try {
      (candidate as (...params: ReadonlyArray<unknown>) => unknown).call(target, ...args);
    } catch {
      // Fail closed: missing or throwing stock Electron APIs must not crash.
    }
  };
  const applyParkPresentation = (presenting: boolean): void => {
    if (!presenting && !view.webContents.isDestroyed()) {
      callOptionalMethod(view.webContents, "setBackgroundThrottling", true);
    }
    callOptionalMethod(view, "setVisible", presenting);
  };
  const applyBounds = (bounds: BrowserSurfaceBounds): void => {
    const applied = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    if (applied.width < 1 || applied.height < 1) {
      if (!parked) {
        parked = true;
        applyParkPresentation(false);
      }
      detachFromHost();
      return;
    }
    const wasParked = parked;
    parked = false;
    if (wasParked) applyParkPresentation(true);
    const host = attachmentTarget?.current();
    if (host !== undefined) attachTo(host);
    view.setBounds(applied);
  };
  const attachTo = (host: ElectronBrowserWindow): void => {
    if (!logicallyAttached || parked || host.isDestroyed() || attachedWindow === host) return;
    if (attachedWindow !== undefined && !attachedWindow.isDestroyed()) {
      attachedWindow.contentView.removeChildView(view);
    }
    host.contentView.addChildView(view);
    attachedWindow = host;
  };
  const detachFromHost = (): void => {
    if (attachedWindow !== undefined && !attachedWindow.isDestroyed()) {
      attachedWindow.contentView.removeChildView(view);
    }
    attachedWindow = undefined;
  };
  const unregister = attachmentTarget?.register({
    view,
    isAttached: () => logicallyAttached,
    attachTo,
    detachFromHost,
  });

  const handle: BrowserViewHandle = {
    loadUrl: (url, expectedSessionId) => {
      if (initializationFailure !== undefined) throw initializationFailure;
      const pending = { url: normalizeUrl(url), sessionId: expectedSessionId };
      expectedNavigation = pending;

      const handleRejection = (error: unknown): void => {
        if (isAbortedLoadError(error)) {
          if (expectedNavigation === pending) expectedNavigation = undefined;
          return;
        }

        const isExpected = expectedNavigation === pending;
        const isActive = activeNavigation?.sessionId === pending.sessionId;
        if (!isExpected && !isActive) return;
        if (isExpected) expectedNavigation = undefined;
        if (isActive) activeNavigation = undefined;
        if (currentSessionId === pending.sessionId) currentSessionId = undefined;
        events.onLoadFail(pending.sessionId, loadErrorMessage(error));
      };

      try {
        return view.webContents.loadURL(url).catch(handleRejection);
      } catch (error) {
        handleRejection(error);
        return Promise.resolve();
      }
    },
    setTopLevelOriginGuard: (origin) => {
      if (exactTopLevelOrigin === undefined) {
        throw new Error("UI browser views cannot acquire an automation origin guard");
      }
      exactTopLevelOrigin = canonicalBrowserOrigin(origin);
    },
    attach: (bounds) => {
      logicallyAttached = true;
      applyBounds(bounds);
    },
    setBounds: (bounds: BrowserSurfaceBounds) => {
      applyBounds(bounds);
    },
    detach: () => {
      logicallyAttached = false;
      detachFromHost();
    },
    stopLoading: () => {
      if (!view.webContents.isDestroyed()) view.webContents.stop();
    },
    destroy: () => {
      // Runtime teardown only — the persist: partition (cookies) is on disk.
      if (terminationExpected) return;
      terminationExpected = true;
      unregister?.();
      detachFromHost();
      void releaseManagedBrowserPartitionNetwork(partition);
      try {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      } catch (error) {
        // Keep loss events suppressed during the close attempt, but allow the
        // session teardown tombstone to retry if Electron refused the close
        // before the WebContents was actually destroyed.
        if (!view.webContents.isDestroyed()) terminationExpected = false;
        throw error;
      }
    },
    whenDestroyed: () => destroyed,
    // Hardened automation runs in a dedicated isolated world. DOM and Web APIs
    // remain available, but page main-world JavaScript globals intentionally do
    // not. userGesture=false grants no synthetic-gesture privileges.
    executeJavaScript: (code) =>
      view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_AUTOMATION_WORLD_ID,
        [{ code: buildBoundedEvalScript(code) }],
        false,
      ),
    capturePagePng: async () => {
      const image = await view.webContents.capturePage();
      return new Uint8Array(image.toPNG());
    },
  };
  return handle;
};

export const electronViewAdapter: BrowserViewAdapter = makeElectronViewAdapter();

/**
 * Produces the only adapter allowed to parent browser views in production.
 * The composition host injects the native parent; no global BrowserWindow
 * discovery is available to a session handle.
 */
export const makeElectronBrowserViewAttachmentTarget = (): ElectronBrowserViewAttachmentTarget => {
  let currentHost: ElectronBrowserWindow | undefined;
  const views = new Set<AttachedElectronView>();
  const attachmentTarget = {
    register: (view: AttachedElectronView): (() => void) => {
      views.add(view);
      return () => views.delete(view);
    },
    current: (): ElectronBrowserWindow | undefined =>
      currentHost !== undefined && !currentHost.isDestroyed() ? currentHost : undefined,
  };
  const adapter = makeElectronViewAdapter(attachmentTarget);
  const toElectronWindow = (host: BrowserCompositionHostWindow): ElectronBrowserWindow => {
    const candidate = host as ElectronBrowserWindow;
    if (typeof candidate.contentView?.addChildView !== "function") {
      throw new TypeError("composition host does not expose an Electron content view");
    }
    return candidate;
  };
  return Object.freeze({
    adapter,
    detach: (): void => {
      for (const view of views) view.detachFromHost();
      currentHost = undefined;
    },
    rebind: (host: BrowserCompositionHostWindow): void => {
      const next = toElectronWindow(host);
      currentHost = next;
      for (const view of views) {
        if (view.isAttached()) view.attachTo(next);
      }
    },
  });
};

/**
 * Dedicated Electron qualification seam. It is deliberately not wired into
 * the app entrypoint: only the test main calls it, with the exact origin of a
 * listener it just bound and an isolated download directory under probe temp.
 */
export const makeBrowserTestOnlyElectronHarness = (
  exactOrigin: string,
  downloadPath: string,
): {
  readonly adapter: BrowserViewAdapter;
  readonly targetAdmission: (url: string) => boolean;
} => {
  if (!isAbsolute(downloadPath)) {
    throw new TypeError("test browser download path must be absolute");
  }
  const grant = makeBrowserTestOnlyExactOriginGrant(exactOrigin);
  return {
    adapter: makeElectronViewAdapter(undefined, grant, downloadPath),
    targetAdmission: (url) =>
      isAllowedBrowserUrl(url) || isAllowedByBrowserTestOnlyExactOriginGrant(url, grant),
  };
};
