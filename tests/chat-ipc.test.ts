import { describe, expect, it, vi } from "vitest";
import type { IpcMain, WebContents } from "electron";
import { registerChatIpc } from "../src/main/vellum/chat/ipc";
import type { ChatService } from "../src/main/vellum/chat/service";
import { IPC_CHANNELS, type ChatEvent } from "../src/shared/ipc";

describe("chat IPC event delivery", () => {
  it("skips destroyed renderers and contains per-recipient send failures", async () => {
    let sink: ((event: ChatEvent) => void) | undefined;
    const service = {
      setEventSink: (next: (event: ChatEvent) => void) => { sink = next; },
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
    let getterThrows = false;

    await registerChatIpc(
      ipcMain,
      () => {
        if (getterThrows) throw new Error("window enumeration failed");
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

    getterThrows = true;
    expect(() => sink?.(event)).not.toThrow();
  });
});
