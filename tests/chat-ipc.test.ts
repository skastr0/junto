import type { ChatChromeChanged } from "../src/shared/chat-chrome";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { registerChatIpc } from "../src/main/junto/chat/ipc";
import type { ChatService } from "../src/main/junto/chat/service";
import { IPC_CHANNELS, type ChatEvent } from "../src/shared/ipc";

describe("chat IPC event delivery", () => {
  it("skips destroyed renderers and contains per-recipient send failures", async () => {
    let sink: ((event: ChatEvent) => void) | undefined;
    const service = {
      setEventSink: (next: (event: ChatEvent) => void) => { sink = next; },
      subscribeChromeChanges: () => () => {},
      chromeSnapshot: () => ({ revision: 0, states: [] }),
    } as unknown as ChatService;
    const ipcMain = { handle: vi.fn() } as unknown as IpcMain;
    const destroyed = {
      isDestroyed: () => true,
      send: vi.fn(),
    } as unknown as WebContents;
    const throwing = {
      isDestroyed: () => false,
      send: vi.fn(() => { throw new Error("renderer disappeared"); }),
    } as unknown as WebContents;
    const healthy = {
      isDestroyed: () => false,
      send: vi.fn(),
    } as unknown as WebContents;
    let getterMode: "healthy" | "throws" | "iterator-throws" = "healthy";

    await registerChatIpc(
      ipcMain,
      () => {
        if (getterMode === "throws") throw new Error("window enumeration failed");
        if (getterMode === "iterator-throws") {
          return {
            *[Symbol.iterator](): Iterator<WebContents> {
              yield healthy;
              throw new Error("window iterator failed");
            },
          };
        }
        return [destroyed, throwing, healthy];
      },
      service,
    );
    const event: ChatEvent = {
      agentKey: "local:default",
      kind: "status",
      payload: { status: "closed" },
    };

    expect(() => sink?.(event)).not.toThrow();
    expect(destroyed.send).not.toHaveBeenCalled();
    expect(throwing.send).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, event);
    expect(healthy.send).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, event);

    getterMode = "throws";
    expect(() => sink?.(event)).not.toThrow();
    getterMode = "iterator-throws";
    expect(() => sink?.(event)).not.toThrow();
    expect(healthy.send).toHaveBeenCalledTimes(1);
  });
});


describe("chat chrome IPC", () => {
  it("hydrates compact state and delivers changes despite stale renderers", async () => {
    let listener: ((event: ChatChromeChanged) => void) | undefined;
    const snapshot = { revision: 5, states: [
      { agentKey: "local:default", sessionLive: true, permissionPending: true },
    ] };
    const service = {
      setEventSink: () => {},
      subscribeChromeChanges: (next: (event: ChatChromeChanged) => void) => { listener = next; return () => {}; },
      chromeSnapshot: () => snapshot,
    } as unknown as ChatService;
    const handlers = new Map<string, () => unknown>();
    const ipc = { handle: (channel: string, handler: () => unknown) => { handlers.set(channel, handler); } } as unknown as IpcMain;
    const dead = { isDestroyed: () => true, send: vi.fn() } as unknown as WebContents;
    const stale = { isDestroyed: () => false, send: vi.fn(() => { throw new Error("gone"); }) } as unknown as WebContents;
    const healthy = { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    await registerChatIpc(ipc, () => [dead, stale, healthy], service);
    await expect(handlers.get(IPC_CHANNELS.chatChrome)!()).resolves.toEqual(snapshot);
    const event = { revision: 6, state: { ...snapshot.states[0]!, permissionPending: false } };
    expect(() => listener?.(event)).not.toThrow();
    expect(dead.send).not.toHaveBeenCalled();
    expect(healthy.send).toHaveBeenCalledWith(IPC_CHANNELS.chatChromeChanged, event);
  });
});
