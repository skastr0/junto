import { beforeEach, describe, expect, it, vi } from "vitest";

const openChat = vi.fn();
const sendPrompt = vi.fn();
const getAgentChatState = vi.fn();

vi.mock("../src/renderer/lib/chat-state", () => ({
  openChat: (...args: unknown[]) => openChat(...args),
  sendPrompt: (...args: unknown[]) => sendPrompt(...args),
  getAgentChatState: (...args: unknown[]) => getAgentChatState(...args),
}));

import { multiPromptAgents } from "../src/renderer/lib/multi-prompt";

describe("multiPromptAgents", () => {
  beforeEach(() => {
    openChat.mockReset();
    sendPrompt.mockReset();
    getAgentChatState.mockReset();
    openChat.mockResolvedValue(undefined);
    sendPrompt.mockResolvedValue(undefined);
  });

  it("no-ops on empty text or targets", async () => {
    await expect(multiPromptAgents([], "hi")).resolves.toEqual({ sent: 0, failed: [] });
    await expect(
      multiPromptAgents([{ nodeId: "n", agentKey: "a:b" }], "  "),
    ).resolves.toEqual({ sent: 0, failed: [] });
    expect(openChat).not.toHaveBeenCalled();
  });

  it("opens when not live, then prompts each target", async () => {
    const opened = new Set<string>();
    openChat.mockImplementation(async (key: string) => {
      opened.add(key);
    });
    getAgentChatState.mockImplementation((key: string) => {
      if (key === "h:b" || opened.has(key)) return { status: "live", error: undefined };
      return { status: "idle", error: undefined };
    });

    const result = await multiPromptAgents(
      [
        { nodeId: "1", agentKey: "h:a" },
        { nodeId: "2", agentKey: "h:b" },
      ],
      "do the thing",
    );

    expect(openChat).toHaveBeenCalledWith("h:a");
    expect(openChat).not.toHaveBeenCalledWith("h:b");
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(sendPrompt).toHaveBeenCalledWith("h:a", "do the thing");
    expect(sendPrompt).toHaveBeenCalledWith("h:b", "do the thing");
    expect(result.sent).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("records open failure without throwing", async () => {
    getAgentChatState.mockReturnValue({ status: "error", error: "spawn failed" });
    openChat.mockResolvedValue(undefined);

    const result = await multiPromptAgents(
      [{ nodeId: "1", agentKey: "h:dead" }],
      "hello",
    );

    expect(result.sent).toBe(0);
    expect(result.failed).toEqual([
      { nodeId: "1", agentKey: "h:dead", error: "spawn failed" },
    ]);
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
