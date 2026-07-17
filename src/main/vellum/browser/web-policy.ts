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
  BROWSER_DNS_POLICY_TIMEOUT_MS,
  BROWSER_MAX_PENDING_DNS_HOSTS,
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
} from "@shared/browser-limits";

type NetworkDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "resolve"; readonly hostname: string }
  | { readonly kind: "deny" };

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

  const target = classifyBrowserTarget(browserUrl);
  if (!target.allowed) return { kind: "deny" };
  const literalScope = classifyIpAddress(stripIpv6Brackets(target.hostname));
  return literalScope === "public"
    ? { kind: "allow" }
    : literalScope === "non_public"
      ? { kind: "deny" }
      : { kind: "resolve", hostname: target.hostname };
};

interface PartitionPolicyState {
  readonly session: Session;
  readonly pendingResolutions: Map<string, Promise<boolean>>;
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

const withDnsDeadline = async (lookup: Promise<boolean>): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), BROWSER_DNS_POLICY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const resolvePublicHostname = async (
  state: PartitionPolicyState,
  hostname: string,
): Promise<boolean> => {
  const existing = state.pendingResolutions.get(hostname);
  if (existing !== undefined) return withDnsDeadline(existing);
  if (state.pendingResolutions.size >= BROWSER_MAX_PENDING_DNS_HOSTS) return false;

  const lookup = state.session
    .resolveHost(hostname, { cacheUsage: "allowed", secureDnsPolicy: "allow" })
    .then(
      ({ endpoints }) =>
        endpoints.length > 0 &&
        endpoints.every((endpoint) => classifyIpAddress(endpoint.address) === "public"),
      () => false,
    );
  state.pendingResolutions.set(hostname, lookup);
  void lookup.finally(() => {
    if (state.pendingResolutions.get(hostname) === lookup) {
      state.pendingResolutions.delete(hostname);
    }
  });
  return withDnsDeadline(lookup);
};

const installPartitionPolicy = (session: Session): void => {
  if (partitionPolicies.has(session)) return;

  let state: PartitionPolicyState;
  const onBeforeRequest: PartitionPolicyState["onBeforeRequest"] = (
    details,
    callback,
  ) => {
    const decision = networkDecision(details.url, details.resourceType);
    if (decision.kind !== "resolve") {
      callback({ cancel: decision.kind === "deny" });
      return;
    }
    void resolvePublicHostname(state, decision.hostname).then(
      (allowed) => callback({ cancel: !allowed }),
      () => callback({ cancel: true }),
    );
  };
  state = {
    session,
    pendingResolutions: new Map<string, Promise<boolean>>(),
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

export const hardenBrowserPartition = (session: Session): void => {
  installPartitionPolicy(session);
};

/**
 * Install the hostile-web policy before the first load. Partition handlers stay
 * hardened for the app-run lifetime because service workers can outlive every
 * view; the release callback removes only this WebContents' local listeners and
 * must run after that WebContents is destroyed.
 */
export interface BrowserWebPolicyEvents {
  readonly onBlockedTopLevelNavigation?: (reason: BrowserTargetRejection) => void;
}

export const installBrowserWebPolicy = (
  webContents: WebContents,
  events: BrowserWebPolicyEvents = {},
): (() => void) => {
  hardenBrowserPartition(webContents.session);
  managedBrowserContents.add(webContents);
  const prevent = (event: Event): void => event.preventDefault();
  const denyFrameNavigation = (
    event: Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ): void => {
    const decision = classifyBrowserTarget(event.url);
    if (decision.allowed) return;
    event.preventDefault();
    if (event.isMainFrame) events.onBlockedTopLevelNavigation?.(decision.reason);
  };
  const denyRedirect = (
    event: Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
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
  webContents.setWebRTCIPHandlingPolicy("default_public_interface_only");
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
