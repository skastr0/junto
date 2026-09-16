import { describe, expect, it } from "vitest";
import {
  browserDeleteAction,
  DEFAULT_BROWSER_PROFILES,
  initialBrowserSession,
  isAllowedBrowserUrl,
  isValidProfileId,
  isWarmBrowserSession,
  partitionNameForProfile,
  reduceBrowserSession,
} from "../src/shared/browser";

describe("browser profile id validation", () => {
  it("accepts default profiles and valid slugs", () => {
    expect(DEFAULT_BROWSER_PROFILES).toEqual(["personal", "work"]);
    expect(isValidProfileId("personal")).toBe(true);
    expect(isValidProfileId("work")).toBe(true);
    expect(isValidProfileId("client-acme")).toBe(true);
    expect(isValidProfileId("a")).toBe(true);
  });

  it("rejects empty and malformed ids", () => {
    expect(isValidProfileId("")).toBe(false);
    expect(isValidProfileId("-leading")).toBe(false);
    expect(isValidProfileId("Upper")).toBe(false);
    expect(isValidProfileId("has space")).toBe(false);
    expect(isValidProfileId("a".repeat(64))).toBe(false);
  });

  it("maps profile to stable partition name", () => {
    expect(partitionNameForProfile("work")).toBe("persist:junto-profile-work");
  });
});

describe("browser public target policy", () => {
  it("allows canonical public web targets", () => {
    expect(isAllowedBrowserUrl("https://example.com")).toBe(true);
    expect(isAllowedBrowserUrl("http://one.one.one.one/x")).toBe(true);
    expect(isAllowedBrowserUrl("https://1.1.1.1/dns-query")).toBe(true);
    expect(isAllowedBrowserUrl("https://[2606:4700:4700::1111]/dns-query")).toBe(true);
  });

  it("rejects non-web schemes, URL credentials, and garbage", () => {
    expect(isAllowedBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserUrl("data:text/html,hi")).toBe(false);
    expect(isAllowedBrowserUrl("https://user:secret@example.com/")).toBe(false);
    expect(isAllowedBrowserUrl("https://@example.com/")).toBe(false);
    expect(isAllowedBrowserUrl("not a url")).toBe(false);
  });

  it.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://printer.local/",
    "http://router.internal/",
    "http://machine/",
    "http://0.0.0.0/",
    "http://10.2.3.4/",
    "http://100.64.0.1/",
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://192.88.99.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::]/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fec0::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    "http://[64:ff9b:1::1]/",
    "http://[2001:2::1]/",
    "http://[2001:20::1]/",
  ])("rejects local or non-public target %s", (url) => {
    expect(isAllowedBrowserUrl(url)).toBe(false);
  });

  it.each([
    "http://127.1/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://1.1.1.1./",
    "http://example.com./",
    "http://exa_mple.com/",
  ])("rejects ambiguous host spelling %s", (url) => {
    expect(isAllowedBrowserUrl(url)).toBe(false);
  });
});

describe("browser delete decision matrix", () => {
  it("defaults to detach", () => {
    expect(browserDeleteAction({ sessionLive: true })).toBe("detach");
    expect(browserDeleteAction({ onDelete: "detach", sessionLive: true })).toBe("detach");
  });

  it("kill-session policy kills only when session live", () => {
    expect(browserDeleteAction({ onDelete: "kill-session", sessionLive: true })).toBe(
      "kill-session",
    );
    expect(browserDeleteAction({ onDelete: "kill-session", sessionLive: false })).toBe("detach");
  });

  it("explicit kill requires live session", () => {
    expect(browserDeleteAction({ explicitKill: true, sessionLive: true })).toBe("kill-session");
    expect(browserDeleteAction({ explicitKill: true, sessionLive: false })).toBe("noop");
  });
});

describe("browser session state machine", () => {
  it("opens into loading then ready", () => {
    let m = initialBrowserSession();
    expect(m.state).toBe("idle");
    m = reduceBrowserSession(m, { type: "open" });
    expect(m.state).toBe("loading");
    m = reduceBrowserSession(m, { type: "load_ok", title: "Docs" });
    expect(m.state).toBe("ready");
    expect(m.title).toBe("Docs");
    expect(isWarmBrowserSession(m.state)).toBe(true);
  });

  it("load fail records error", () => {
    let m = initialBrowserSession();
    m = reduceBrowserSession(m, { type: "load_start" });
    m = reduceBrowserSession(m, { type: "load_fail", message: "net::ERR" });
    expect(m.state).toBe("failed");
    expect(m.lastError).toBe("net::ERR");
    expect(isWarmBrowserSession(m.state)).toBe(true);
  });

  it("detach and reattach preserve warm session", () => {
    let m = reduceBrowserSession(initialBrowserSession(), { type: "open" });
    m = reduceBrowserSession(m, { type: "load_ok", title: "App" });
    m = reduceBrowserSession(m, { type: "detach" });
    expect(m.state).toBe("detached");
    m = reduceBrowserSession(m, { type: "reattach" });
    expect(m.state).toBe("ready");
    expect(m.title).toBe("App");
  });

  it("destroy is terminal", () => {
    let m = reduceBrowserSession(initialBrowserSession(), { type: "open" });
    m = reduceBrowserSession(m, { type: "destroy" });
    expect(m.state).toBe("destroyed");
    m = reduceBrowserSession(m, { type: "open" });
    expect(m.state).toBe("destroyed");
    expect(isWarmBrowserSession(m.state)).toBe(false);
  });

  it("reload returns to loading from ready", () => {
    let m = reduceBrowserSession(initialBrowserSession(), { type: "load_ok", title: "X" });
    // load_ok from idle is allowed as ready for convenience after open path
    m = reduceBrowserSession({ state: "ready", title: "X" }, { type: "reload" });
    expect(m.state).toBe("loading");
  });
});
