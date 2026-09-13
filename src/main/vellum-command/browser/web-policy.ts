import type {
  BrowserWindow,
  Event,
  OnBeforeRequestListenerDetails,
  Session,
  WebContents,
} from "electron";
import {
  classifyBrowserTarget,
  classifyIpAddress,
  type BrowserTargetRejection,
} from "@shared/browser-policy";
import {
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
} from "@shared/browser-limits";

type NetworkDecision = { readonly kind: "allow" } | { readonly kind: "deny" };

const exactOriginGrant = Symbol("vellum.browser.test-only-exact-origin");

/**
 * Opaque, test-only network capability. The production adapter never creates
 * one. Construction accepts only the canonical origin emitted by a loopback
 * listener bound on an ephemeral non-privileged port; no environment variable
 * or renderer/control input is consulted.
 */
export interface BrowserTestOnlyExactOriginGrant {
  readonly [exactOriginGrant]: string;
}

export const makeBrowserTestOnlyExactOriginGrant = (
  candidate: string,
): BrowserTestOnlyExactOriginGrant => {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("test browser origin must be a canonical loopback HTTP origin");
  }
  const port = Number(parsed.port);
  if (
    candidate !== parsed.origin ||
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535
  ) {
    throw new TypeError("test browser origin must be canonical http://127.0.0.1:<ephemeral-port>");
  }
  return Object.freeze({ [exactOriginGrant]: parsed.origin });
};

export const browserTestOnlyExactOrigin = (
  grant: BrowserTestOnlyExactOriginGrant,
): string => grant[exactOriginGrant];

export const isAllowedByBrowserTestOnlyExactOriginGrant = (
  url: string,
  grant: BrowserTestOnlyExactOriginGrant,
): boolean => {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin === grant[exactOriginGrant]
    );
  } catch {
    return false;
  }
};

export type BrowserTopLevelNavigationGuard = (url: string) => boolean;
export type BrowserTopLevelNavigationRejection =
  | BrowserTargetRejection
  | "origin_mismatch";

export const canonicalBrowserOrigin = (candidate: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError("browser origin must be a canonical HTTP(S) origin");
  }
  if (
    candidate !== parsed.origin ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("browser origin must be a canonical HTTP(S) origin");
  }
  return parsed.origin;
};

export const isAllowedByBrowserExactOrigin = (
  url: string,
  exactOrigin: string,
): boolean => {
  if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin === exactOrigin
    );
  } catch {
    return false;
  }
};

const FRAME_RESOURCE_TYPES = new Set<OnBeforeRequestListenerDetails["resourceType"]>([
  "mainFrame",
  "subFrame",
]);

const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

const networkDecision = (
  url: string,
  resourceType: OnBeforeRequestListenerDetails["resourceType"],
  testOnlyGrant?: BrowserTestOnlyExactOriginGrant,
): NetworkDecision => {
  if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) return { kind: "deny" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "deny" };
  }

  const isFrame = FRAME_RESOURCE_TYPES.has(resourceType);
  if (!isFrame && (parsed.protocol === "blob:" || parsed.protocol === "data:")) {
    return { kind: "allow" };
  }

  const browserUrl =
    parsed.protocol === "ws:"
      ? `http:${url.slice(url.indexOf(":") + 1)}`
      : parsed.protocol === "wss:"
        ? `https:${url.slice(url.indexOf(":") + 1)}`
        : url;
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    (!isFrame && parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
  ) {
    return { kind: "deny" };
  }

  if (
    testOnlyGrant !== undefined &&
    isAllowedByBrowserTestOnlyExactOriginGrant(browserUrl, testOnlyGrant)
  ) {
    return { kind: "allow" };
  }

  const target = classifyBrowserTarget(browserUrl);
  if (!target.allowed) return { kind: "deny" };
  const literalScope = classifyIpAddress(stripIpv6Brackets(target.hostname));
  return literalScope === "non_public" ? { kind: "deny" } : { kind: "allow" };
};

interface PartitionPolicyState {
  readonly session: Session;
  readonly onBeforeRequest: (
    details: OnBeforeRequestListenerDetails,
    callback: (response: { readonly cancel?: boolean }) => void,
  ) => void;
  readonly onWillDownload: (event: Event) => void;
  readonly onFileSystemAccessRestricted: (
    event: Event,
    details: Electron.FileSystemAccessRestrictedDetails,
    callback: (action: "allow" | "deny" | "tryAgain") => void,
  ) => void;
  readonly onSelectHidDevice: (
    event: Event,
    details: Electron.SelectHidDeviceDetails,
    callback: (deviceId?: string | null) => void,
  ) => void;
  readonly onSelectSerialPort: (
    event: Event,
    ports: Electron.SerialPort[],
    webContents: WebContents,
    callback: (portId: string) => void,
  ) => void;
  readonly onSelectUsbDevice: (
    event: Event,
    details: Electron.SelectUsbDeviceDetails,
    callback: (deviceId?: string) => void,
  ) => void;
}

const partitionPolicies = new WeakMap<Session, PartitionPolicyState>();
const managedBrowserContents = new WeakSet<WebContents>();

export const isManagedBrowserWebContents = (webContents: WebContents): boolean =>
  managedBrowserContents.has(webContents);

const installPartitionPolicy = (
  session: Session,
  testOnlyGrant?: BrowserTestOnlyExactOriginGrant,
): void => {
  if (partitionPolicies.has(session)) return;

  let state: PartitionPolicyState;
  const onBeforeRequest: PartitionPolicyState["onBeforeRequest"] = (
    details,
    callback,
  ) => {
    const decision = networkDecision(details.url, details.resourceType, testOnlyGrant);
    callback({ cancel: decision.kind === "deny" });
  };
  state = {
    session,
    onBeforeRequest,
    onWillDownload: (event: Event): void => event.preventDefault(),
    onFileSystemAccessRestricted: (
      event: Event,
      _details: Electron.FileSystemAccessRestrictedDetails,
      callback: (action: "allow" | "deny" | "tryAgain") => void,
    ): void => {
      event.preventDefault();
      callback("deny");
    },
    onSelectHidDevice: (
      event: Event,
      _details: Electron.SelectHidDeviceDetails,
      callback: (deviceId?: string | null) => void,
    ): void => {
      event.preventDefault();
      callback();
    },
    onSelectSerialPort: (
      event: Event,
      _ports: Electron.SerialPort[],
      _webContents: WebContents,
      callback: (portId: string) => void,
    ): void => {
      event.preventDefault();
      callback("");
    },
    onSelectUsbDevice: (
      event: Event,
      _details: Electron.SelectUsbDeviceDetails,
      callback: (deviceId?: string) => void,
    ): void => {
      event.preventDefault();
      callback();
    },
  };

  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}), {
    useSystemPicker: false,
  });
  session.webRequest.onBeforeRequest(state.onBeforeRequest);
  session.on("will-download", state.onWillDownload);
  session.on("file-system-access-restricted", state.onFileSystemAccessRestricted);
  session.on("select-hid-device", state.onSelectHidDevice);
  session.on("select-serial-port", state.onSelectSerialPort);
  session.on("select-usb-device", state.onSelectUsbDevice);
  partitionPolicies.set(session, state);
};

export const hardenBrowserPartition = (
  session: Session,
  testOnlyGrant?: BrowserTestOnlyExactOriginGrant,
): void => {
  installPartitionPolicy(session, testOnlyGrant);
};

/**
 * Install the hostile-web policy before the first load. Partition handlers stay
 * hardened for the app-run lifetime because service workers can outlive every
 * view; the release callback removes only this WebContents' local listeners and
 * must run after that WebContents is destroyed.
 */
export interface BrowserWebPolicyEvents {
  readonly onBlockedTopLevelNavigation?: (
    reason: BrowserTopLevelNavigationRejection,
  ) => void;
}

export const installBrowserWebPolicy = (
  webContents: WebContents,
  events: BrowserWebPolicyEvents = {},
  testOnlyGrant?: BrowserTestOnlyExactOriginGrant,
  topLevelNavigationGuard?: BrowserTopLevelNavigationGuard,
): (() => void) => {
  hardenBrowserPartition(webContents.session, testOnlyGrant);
  managedBrowserContents.add(webContents);
  const prevent = (event: Event): void => event.preventDefault();
  const topLevelNavigationAllowed = (url: string): boolean => {
    if (topLevelNavigationGuard === undefined) return true;
    try {
      return topLevelNavigationGuard(url);
    } catch {
      return false;
    }
  };
  const denyFrameNavigation = (
    event: Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ): void => {
    if (
      event.isMainFrame &&
      !topLevelNavigationAllowed(event.url)
    ) {
      event.preventDefault();
      events.onBlockedTopLevelNavigation?.("origin_mismatch");
      return;
    }
    if (
      testOnlyGrant !== undefined &&
      isAllowedByBrowserTestOnlyExactOriginGrant(event.url, testOnlyGrant)
    ) {
      return;
    }
    const decision = classifyBrowserTarget(event.url);
    if (decision.allowed) return;
    event.preventDefault();
    if (event.isMainFrame) events.onBlockedTopLevelNavigation?.(decision.reason);
  };
  const denyRedirect = (
    event: Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
    if (
      event.isMainFrame &&
      !topLevelNavigationAllowed(event.url)
    ) {
      event.preventDefault();
      events.onBlockedTopLevelNavigation?.("origin_mismatch");
      return;
    }
    if (
      testOnlyGrant !== undefined &&
      isAllowedByBrowserTestOnlyExactOriginGrant(event.url, testOnlyGrant)
    ) {
      return;
    }
    const decision = classifyBrowserTarget(event.url);
    if (decision.allowed) return;
    event.preventDefault();
    if (event.isMainFrame) events.onBlockedTopLevelNavigation?.(decision.reason);
  };
  const closeUnexpectedChild = (window: BrowserWindow): void => window.destroy();
  const denyBluetooth = (
    event: Event,
    _devices: Electron.BluetoothDevice[],
    callback: (deviceId: string) => void,
  ): void => {
    event.preventDefault();
    callback("");
  };

  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  webContents.on("will-attach-webview", prevent);
  webContents.on("will-frame-navigate", denyFrameNavigation);
  webContents.on("will-redirect", denyRedirect);
  webContents.on("content-bounds-updated", prevent);
  webContents.on("will-prevent-unload", prevent);
  webContents.on("did-create-window", closeUnexpectedChild);
  webContents.on("select-bluetooth-device", denyBluetooth);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    webContents.off("will-attach-webview", prevent);
    webContents.off("will-frame-navigate", denyFrameNavigation);
    webContents.off("will-redirect", denyRedirect);
    webContents.off("content-bounds-updated", prevent);
    webContents.off("will-prevent-unload", prevent);
    webContents.off("did-create-window", closeUnexpectedChild);
    webContents.off("select-bluetooth-device", denyBluetooth);
    managedBrowserContents.delete(webContents);
  };
};
