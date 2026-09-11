import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OnBeforeRequestListenerDetails,
  Session,
  WebContents,
} from "electron";
import {
  canonicalBrowserOrigin,
  installBrowserWebPolicy,
  isAllowedByBrowserExactOrigin,
  isAllowedByBrowserTestOnlyExactOriginGrant,
  isManagedBrowserWebContents,
  makeBrowserTestOnlyExactOriginGrant,
} from "../src/main/vellum-command/browser/web-policy";

type Listener = (...args: ReadonlyArray<unknown>) => void;
type BeforeRequest = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: { readonly cancel?: boolean }) => void,
) => void;

const event = () => ({ preventDefault: vi.fn() });

class FakeSession {
  readonly listeners = new Map<string, Listener[]>();
  readonly webRequest = {
    handler: null as BeforeRequest | null,
    calls: [] as ReadonlyArray<BeforeRequest | null>,
    onBeforeRequest: (handler: BeforeRequest | null): void => {
      this.webRequest.handler = handler;
      this.webRequest.calls = [...this.webRequest.calls, handler];
    },
  };
  permissionCheck: ((...args: ReadonlyArray<unknown>) => boolean) | null = null;
  permissionRequest:
    | ((webContents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void)
    | null = null;
  devicePermission: ((...args: ReadonlyArray<unknown>) => boolean) | null = null;
  displayMedia:
    | ((request: unknown, callback: (streams: Record<string, never>) => void) => void)
    | null = null;

  setPermissionCheckHandler(handler: FakeSession["permissionCheck"]): void {
    this.permissionCheck = handler;
  }
  setPermissionRequestHandler(handler: FakeSession["permissionRequest"]): void {
    this.permissionRequest = handler;
  }
  setDevicePermissionHandler(handler: FakeSession["devicePermission"]): void {
    this.devicePermission = handler;
  }
  setDisplayMediaRequestHandler(handler: FakeSession["displayMedia"]): void {
    this.displayMedia = handler;
  }
  on(name: string, listener: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return this;
  }
  off(name: string, listener: Listener): this {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }
  emit(name: string, ...args: ReadonlyArray<unknown>): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args);
  }
}

class FakeWebContents {
  readonly listeners = new Map<string, Listener[]>();
  windowOpenHandler: ((details: unknown) => { readonly action: string }) | undefined;
  webRtcPolicy: string | undefined;

  constructor(readonly session: FakeSession) {}

  setWindowOpenHandler(handler: (details: unknown) => { readonly action: string }): void {
    this.windowOpenHandler = handler;
  }
  setWebRTCIPHandlingPolicy(policy: string): void {
    this.webRtcPolicy = policy;
  }
  on(name: string, listener: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return this;
  }
  off(name: string, listener: Listener): this {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }
  emit(name: string, ...args: ReadonlyArray<unknown>): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args);
  }
}

const install = (
  session = new FakeSession(),
  events: Parameters<typeof installBrowserWebPolicy>[1] = {},
  testOnlyGrant?: Parameters<typeof installBrowserWebPolicy>[2],
  topLevelNavigationGuard?: Parameters<typeof installBrowserWebPolicy>[3],
) => {
  const contents = new FakeWebContents(session);
  const release = installBrowserWebPolicy(
    contents as unknown as WebContents,
    events,
    testOnlyGrant,
    topLevelNavigationGuard,
  );
  return { session, contents, release };
};

const request = (
  session: FakeSession,
  url: string,
  resourceType: OnBeforeRequestListenerDetails["resourceType"] = "mainFrame",
): boolean => {
  const handler = session.webRequest.handler;
  if (handler === null) throw new Error("request policy missing");
  let cancelled = false;
  handler(
    { url, resourceType } as OnBeforeRequestListenerDetails,
    ({ cancel }) => {
      cancelled = cancel === true;
    },
  );
  return cancelled;
};

afterEach(() => vi.useRealTimers());

describe("browser partition policy", () => {
  it("constructs only a canonical exact loopback-origin test capability", () => {
    const grant = makeBrowserTestOnlyExactOriginGrant("http://127.0.0.1:49152");
    expect(
      isAllowedByBrowserTestOnlyExactOriginGrant(
        "http://127.0.0.1:49152/fixture?nonce=one",
        grant,
      ),
    ).toBe(true);
    for (const url of [
      "http://127.0.0.1:49153/",
      "http://127.0.0.2:49152/",
      "http://user@127.0.0.1:49152/",
      "https://127.0.0.1:49152/",
    ]) {
      expect(isAllowedByBrowserTestOnlyExactOriginGrant(url, grant)).toBe(false);
    }

    for (const origin of [
      "http://127.0.0.1:49152/",
      "http://127.0.0.1:49152/path",
      "http://127.0.0.1:49152?query=one",
      "http://localhost:49152",
      "https://127.0.0.1:49152",
      "http://user@127.0.0.1:49152",
      "http://127.0.0.1:80",
    ]) {
      expect(() => makeBrowserTestOnlyExactOriginGrant(origin)).toThrow(TypeError);
    }

    const { session } = install(new FakeSession(), {}, grant);
    expect(request(session, "http://127.0.0.1:49152/fixture")).toBe(false);
    expect(request(session, "http://127.0.0.1:49153/private-sentinel")).toBe(true);
  });

  it("denies every ambient permission and unmanaged popup by default", () => {
    const { session, contents } = install();
    expect(session.permissionCheck?.()).toBe(false);
    expect(session.devicePermission?.()).toBe(false);
    const permissionResult = vi.fn();
    session.permissionRequest?.(contents, "media", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
    const displayResult = vi.fn();
    session.displayMedia?.({}, displayResult);
    expect(displayResult).toHaveBeenCalledWith({});
    expect(contents.windowOpenHandler?.({})).toEqual({ action: "deny" });
    expect(contents.webRtcPolicy).toBe("disable_non_proxied_udp");
  });

  it("admits syntactic public targets and denies literal private ones", () => {
    const { session } = install();
    expect(request(session, "https://1.1.1.1/")).toBe(false);
    expect(request(session, "https://example.com/")).toBe(false);
    expect(request(session, "wss://example.com/socket", "webSocket")).toBe(false);

    expect(request(session, "http://127.0.0.1/")).toBe(true);
    expect(request(session, "http://169.254.169.254/")).toBe(true);
    expect(request(session, "https://user:secret@example.com/")).toBe(true);
    expect(request(session, "file:///etc/passwd")).toBe(true);
    expect(request(session, "custom://escape", "other")).toBe(true);
    expect(request(session, "blob:https://example.com/id", "mainFrame")).toBe(true);
    expect(request(session, "blob:https://example.com/id", "image")).toBe(false);
  });

  it("cancels downloads and every device selection surface", () => {
    const { session, contents } = install();
    const download = event();
    session.emit("will-download", download);
    expect(download.preventDefault).toHaveBeenCalledOnce();

    const fileSystem = event();
    const fileSystemResult = vi.fn();
    session.emit("file-system-access-restricted", fileSystem, {}, fileSystemResult);
    expect(fileSystem.preventDefault).toHaveBeenCalledOnce();
    expect(fileSystemResult).toHaveBeenCalledWith("deny");

    const hid = event();
    const hidResult = vi.fn();
    session.emit("select-hid-device", hid, {}, hidResult);
    expect(hid.preventDefault).toHaveBeenCalledOnce();
    expect(hidResult).toHaveBeenCalledWith();

    const serial = event();
    const serialResult = vi.fn();
    session.emit("select-serial-port", serial, [], contents, serialResult);
    expect(serial.preventDefault).toHaveBeenCalledOnce();
    expect(serialResult).toHaveBeenCalledWith("");

    const usb = event();
    const usbResult = vi.fn();
    session.emit("select-usb-device", usb, {}, usbResult);
    expect(usb.preventDefault).toHaveBeenCalledOnce();
    expect(usbResult).toHaveBeenCalledWith();

    const bluetooth = event();
    const bluetoothResult = vi.fn();
    contents.emit("select-bluetooth-device", bluetooth, [], bluetoothResult);
    expect(bluetooth.preventDefault).toHaveBeenCalledOnce();
    expect(bluetoothResult).toHaveBeenCalledWith("");
  });

  it("blocks privileged frame navigation, webviews, page resize, and unload traps", () => {
    const blockedTopLevel = vi.fn();
    const { contents } = install(new FakeSession(), {
      onBlockedTopLevelNavigation: blockedTopLevel,
    });
    const publicNavigation = {
      ...event(),
      url: "https://example.com/",
      isMainFrame: true,
    };
    contents.emit("will-frame-navigate", publicNavigation);
    expect(publicNavigation.preventDefault).not.toHaveBeenCalled();

    for (const url of ["file:///etc/passwd", "http://127.0.0.1/", "custom://escape"]) {
      const navigation = { ...event(), url, isMainFrame: true };
      contents.emit("will-frame-navigate", navigation);
      expect(navigation.preventDefault).toHaveBeenCalledOnce();
    }
    expect(blockedTopLevel).toHaveBeenCalledTimes(3);

    const redirect = {
      ...event(),
      url: "http://169.254.169.254/latest/meta-data",
      isMainFrame: true,
    };
    contents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    expect(blockedTopLevel).toHaveBeenLastCalledWith("non_public_ip");

    for (const name of ["will-attach-webview", "content-bounds-updated", "will-prevent-unload"]) {
      const blocked = event();
      contents.emit(name, blocked);
      expect(blocked.preventDefault).toHaveBeenCalledOnce();
    }

    const child = { destroy: vi.fn() };
    contents.emit("did-create-window", child);
    expect(child.destroy).toHaveBeenCalledOnce();
  });

  it("pins automation top-level navigation and redirects to one exact origin", () => {
    const blockedTopLevel = vi.fn();
    const origin = canonicalBrowserOrigin("https://account.example.com");
    const { contents } = install(
      new FakeSession(),
      { onBlockedTopLevelNavigation: blockedTopLevel },
      undefined,
      (url) => isAllowedByBrowserExactOrigin(url, origin),
    );

    for (const name of ["will-frame-navigate", "will-redirect"]) {
      const sameOrigin = {
        ...event(),
        url: "https://account.example.com/next?step=1",
        isMainFrame: true,
      };
      contents.emit(name, sameOrigin);
      expect(sameOrigin.preventDefault).not.toHaveBeenCalled();

      for (const url of [
        "https://other.example.com/",
        "https://user@account.example.com/",
        "http://account.example.com/",
      ]) {
        const crossOrigin = { ...event(), url, isMainFrame: true };
        contents.emit(name, crossOrigin);
        expect(crossOrigin.preventDefault).toHaveBeenCalledOnce();
      }
    }
    expect(blockedTopLevel).toHaveBeenCalledTimes(6);
    expect(blockedTopLevel).toHaveBeenCalledWith("origin_mismatch");

    const publicSubframe = {
      ...event(),
      url: "https://cdn.example.net/frame",
      isMainFrame: false,
    };
    contents.emit("will-frame-navigate", publicSubframe);
    expect(publicSubframe.preventDefault).not.toHaveBeenCalled();
  });

  it("fails a throwing top-level guard closed and validates canonical origins", () => {
    expect(() => canonicalBrowserOrigin("https://example.com/")).toThrow(TypeError);
    expect(() => canonicalBrowserOrigin("file:///tmp/a")).toThrow(TypeError);
    expect(() => canonicalBrowserOrigin("https://example.com:443")).toThrow(TypeError);
    expect(canonicalBrowserOrigin("https://example.com")).toBe("https://example.com");

    const blockedTopLevel = vi.fn();
    const { contents } = install(
      new FakeSession(),
      { onBlockedTopLevelNavigation: blockedTopLevel },
      undefined,
      () => {
        throw new Error("guard failed");
      },
    );
    const navigation = {
      ...event(),
      url: "https://example.com/",
      isMainFrame: true,
    };
    contents.emit("will-frame-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    expect(blockedTopLevel).toHaveBeenCalledWith("origin_mismatch");
  });

  it("installs once per partition and remains hardened after every view releases", () => {
    const session = new FakeSession();
    const first = install(session);
    const second = install(session);
    expect(session.webRequest.calls).toHaveLength(1);
    expect(isManagedBrowserWebContents(first.contents as unknown as WebContents)).toBe(true);

    first.release();
    expect(session.webRequest.handler).not.toBeNull();
    expect(session.permissionCheck).not.toBeNull();
    expect(isManagedBrowserWebContents(first.contents as unknown as WebContents)).toBe(false);

    second.release();
    expect(session.webRequest.handler).not.toBeNull();
    expect(session.permissionCheck?.()).toBe(false);
    expect(session.permissionRequest).not.toBeNull();
    expect(session.devicePermission?.()).toBe(false);
    expect(session.displayMedia).not.toBeNull();
    expect(session.listeners.get("will-download")).toHaveLength(1);
    expect(first.contents.listeners.get("will-frame-navigate")).toEqual([]);
    expect(second.contents.listeners.get("will-frame-navigate")).toEqual([]);
  });
});
