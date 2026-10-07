import { describe, expect, it, vi } from "vitest";
import { observe } from "@legendapp/state";
import { createChatChromeStore, type ChatChromeChanged, type ChatChromeSnapshot } from "../src/renderer/lib/chat-chrome-store";

const row = (agentKey: string, permissionPending: boolean) => ({ agentKey, sessionLive: true, permissionPending });
const flush = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
const harness = () => {
  let notify!: (event: ChatChromeChanged) => void;
  let resolve!: (snapshot: ChatChromeSnapshot) => void;
  let reject!: (error: Error) => void;
  const off = vi.fn();
  const api = {
    chatChrome: vi.fn(() => new Promise<ChatChromeSnapshot>((yes, no) => { resolve = yes; reject = no; })),
    onChatChromeChanged: vi.fn((listener: typeof notify) => { notify = listener; return off; }),
  };
  const store = createChatChromeStore(() => api);
  return { api, off, store, emit: (event: ChatChromeChanged) => notify(event), snapshot: (value: ChatChromeSnapshot) => resolve(value), reject: (error: Error) => reject(error) };
};

describe("ACP chrome hydration", () => {
  it("restores a permission already pending before renderer load, without opening a chat", async () => {
    const h = harness();
    const release = h.store.retain();
    try {
      expect(h.api.onChatChromeChanged.mock.invocationCallOrder[0]).toBeLessThan(h.api.chatChrome.mock.invocationCallOrder[0]);
      h.snapshot({ revision: 7, states: [row("local:seat", true)] }); await flush();
      expect(h.store.state.hydrated.peek()).toBe(true);
      expect(h.store.state.byAgentKey["local:seat"].permissionPending.peek()).toBe(true);
      h.emit({ revision: 8, state: row("local:seat", false) });
      expect(h.store.state.byAgentKey["local:seat"].permissionPending.peek()).toBe(false);
    } finally { release(); }
    expect(h.off).toHaveBeenCalledOnce();
  });

  it("keeps newer answers and permission requests that race the initial snapshot", async () => {
    const h = harness(); const release = h.store.retain();
    try {
      h.emit({ revision: 11, state: row("answered", false) });
      h.emit({ revision: 9, state: row("old", true) });
      h.emit({ revision: 12, state: row("new", true) });
      h.snapshot({ revision: 10, states: [row("answered", true), row("old", false)] }); await flush();
      expect(h.store.state.byAgentKey.answered.permissionPending.peek()).toBe(false);
      expect(h.store.state.byAgentKey.old.permissionPending.peek()).toBe(false);
      expect(h.store.state.byAgentKey.new.permissionPending.peek()).toBe(true);
      h.emit({ revision: 11, state: row("answered", true) });
      expect(h.store.state.byAgentKey.answered.permissionPending.peek()).toBe(false);
    } finally { release(); }
  });

  it("shares one bridge and keeps changes to another seat out of a selector", async () => {
    const h = harness(); const a = h.store.retain(), b = h.store.retain();
    h.snapshot({ revision: 0, states: [row("seat", false)] }); await flush();
    const changed = vi.fn();
    const off = observe(() => h.store.state.byAgentKey.seat.permissionPending.get(), changed);
    changed.mockClear();
    try {
      h.emit({ revision: 1, state: row("other", true) });
      expect(changed).not.toHaveBeenCalled();
      expect(h.api.chatChrome).toHaveBeenCalledOnce();
      a(); expect(h.off).not.toHaveBeenCalled();
      b(); expect(h.off).toHaveBeenCalledOnce();
    } finally { off(); a(); b(); }
  });

  it("ignores a late snapshot after release and replaces obsolete rows when retained again", async () => {
    const h = harness(); const first = h.store.retain();
    first(); h.snapshot({ revision: 100, states: [row("old", true)] }); await flush();
    expect(h.store.state.byAgentKey.old.peek()).toBeUndefined();
    const second = h.store.retain();
    h.snapshot({ revision: 1, states: [row("current", true)] }); await flush();
    expect(h.store.state.byAgentKey.current.permissionPending.peek()).toBe(true);
    second();
    const third = h.store.retain();
    h.snapshot({ revision: 2, states: [] }); await flush();
    expect(h.store.state.byAgentKey.current.peek()).toBeUndefined();
    third();
  });

  it("keeps live buffered events visible if the initial read fails", async () => {
    const h = harness(); const release = h.store.retain();
    h.emit({ revision: 3, state: row("seat", true) });
    h.reject(new Error("snapshot unavailable")); await flush();
    expect(h.store.state.byAgentKey.seat.permissionPending.peek()).toBe(true);
    expect(h.store.state.error.peek()).toBe("snapshot unavailable");
    release();
  });
});
