import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { driverMark } from "../src/shared/page-driver";
import { activeTab } from "../src/shared/page-tabs";
import { makeLocalBrowserChrome, runChromeCommand } from "../src/renderer/lib/browser-chrome-source";

const S = "session-1";

describe("local browser chrome", () => {
  it("opens, activates and closes tabs by the shared reducer, and refuses the last close", async () => {
    const chrome = makeLocalBrowserChrome("https://example.com/");
    expect((await chrome.state(S))?.tabs.tabs).toHaveLength(1);
    expect(await runChromeCommand(chrome, S, { kind: "openTab", url: "https://docs.example.com/" })).toEqual({ ok: true });
    const two = (await chrome.state(S))!.tabs;
    expect(two.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(two.active).toBe("t2");
    expect(await runChromeCommand(chrome, S, { kind: "activateTab", tab: "t1" as never })).toEqual({ ok: true });
    expect(await runChromeCommand(chrome, S, { kind: "closeTab", tab: "t2" as never })).toEqual({ ok: true });
    expect(await runChromeCommand(chrome, S, { kind: "closeTab", tab: "t1" as never })).toEqual({
      ok: false,
      refusal: { kind: "last_tab", tab: "t1" },
    });
    expect(await runChromeCommand(chrome, S, { kind: "closeTab", tab: "t9" as never })).toMatchObject({
      ok: false,
      refusal: { kind: "no_such_tab" },
    });
  });

  it("goes to an address on the active tab", async () => {
    const chrome = makeLocalBrowserChrome();
    await runChromeCommand(chrome, S, { kind: "goto", url: "https://next.example.com/" });
    const state = (await chrome.state(S))!;
    expect(activeTab(state.tabs).url).toBe("https://next.example.com/");
    expect(activeTab(state.tabs).canGoBack).toBe(true);
  });

  it("takes over and hands back, and tells listeners each time", async () => {
    const chrome = makeLocalBrowserChrome();
    const heard: string[] = [];
    const off = chrome.onChanged((id) => heard.push(id));
    await runChromeCommand(chrome, S, { kind: "takeOver" });
    expect(driverMark((await chrome.state(S))!.driving, Date.now()).kind).toBe("operator-held");
    await runChromeCommand(chrome, S, { kind: "release" });
    expect((await chrome.state(S))!.driving.control.kind).toBe("shared");
    off();
    await runChromeCommand(chrome, S, { kind: "takeOver" });
    expect(heard).toEqual([S, S]);
  });

  it("shows a seat driving through the same reducer", async () => {
    const chrome = makeLocalBrowserChrome();
    chrome.seat(S, { kind: "seat-start", nodeId: asNodeId("seat-ada"), at: Date.now() });
    expect(driverMark((await chrome.state(S))!.driving, Date.now())).toMatchObject({ kind: "seat", running: true });
  });
});
