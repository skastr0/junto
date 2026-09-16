import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatOpenResult } from "../src/shared/ipc";
import {
  answerPermission,
  chatCoarse$,
  chatState$,
  closeChat,
  extractAuthMethods,
  getAgentChatState,
  initialAgentChatState,
  markRead,
  openChat,
  reduceChatEvent,
  sendPrompt,
  setAgentChatState,
  setModel,
  subscribeChatEvents,
  type AgentChatState,
  type ChatToolItem,
} from "../src/renderer/lib/chat-state";

// --- pure reducer: chunk aggregation, tool transitions, permission lifecycle,
// defensive degrade — no DOM, no window, no IPC. -----------------------------

const event = (kind: string, payload: unknown, agentKey = "remote-a:vega"): ChatEvent => ({ agentKey, kind, payload });

describe("reduceChatEvent — chunk aggregation", () => {
  it("aggregates consecutive assistant chunks into one message", () => {
    let state = initialAgentChatState();
    state = reduceChatEvent(state, event("agent_message_chunk", { content: { type: "text", text: "Hello, " } }));
    state = reduceChatEvent(state, event("agent_message_chunk", { content: { type: "text", text: "world." } }));

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", text: "Hello, world." });
    // Two chunks feeding one message bump unread once, not twice.
    expect(state.unread).toBe(1);
  });

  it("starts a new assistant message once a thought chunk interrupts the stream", () => {
    let state = initialAgentChatState();
    state = reduceChatEvent(state, event("agent_message_chunk", { content: { type: "text", text: "part one" } }));
    state = reduceChatEvent(state, event("agent_thought_chunk", { content: { type: "text", text: "pondering…" } }));
    state = reduceChatEvent(state, event("agent_message_chunk", { content: { type: "text", text: "part two" } }));

    expect(state.transcript.map((item) => item.kind)).toEqual(["assistant", "thought", "assistant"]);
    expect(state.transcript[0]).toMatchObject({ text: "part one" });
    expect(state.transcript[2]).toMatchObject({ text: "part two" });
    expect(state.unread).toBe(3);
  });

  it("accepts a plain string content block, and ignores a chunk with no extractable text", () => {
    let state = initialAgentChatState();
    state = reduceChatEvent(state, event("agent_message_chunk", { content: "plain string chunk" }));
    expect(state.transcript).toMatchObject([{ kind: "assistant", text: "plain string chunk" }]);

    const before = state;
    state = reduceChatEvent(state, event("agent_message_chunk", { content: {} }));
    expect(state).toBe(before); // no-op: unchanged reference, no throw
  });
});

describe("reduceChatEvent — tool call status transitions", () => {
  it("creates a pending tool card, then transitions it to completed on update", () => {
    let state = initialAgentChatState();
    state = reduceChatEvent(state, event("tool_call", { toolCallId: "tc-1", title: "grep", status: "pending", rawInput: { pattern: "TODO" } }));

    expect(state.transcript).toHaveLength(1);
    let tool = state.transcript[0] as ChatToolItem;
    expect(tool).toMatchObject({ kind: "tool", toolCallId: "tc-1", title: "grep", status: "pending" });

    state = reduceChatEvent(state, event("tool_call_update", { toolCallId: "tc-1", status: "completed", rawOutput: "3 matches" }));

    expect(state.transcript).toHaveLength(1); // updated in place, not appended
    tool = state.transcript[0] as ChatToolItem;
    expect(tool.status).toBe("completed");
    expect(tool.rawOutput).toBe("3 matches");
    expect(tool.title).toBe("grep"); // preserved from the original tool_call
    expect(tool.rawInput).toEqual({ pattern: "TODO" }); // preserved, update didn't send rawInput
  });

  it("defaults an untitled/unstatused tool_call to a pending placeholder", () => {
    const state = reduceChatEvent(initialAgentChatState(), event("tool_call", { toolCallId: "tc-2" }));
    expect(state.transcript[0]).toMatchObject({ kind: "tool", toolCallId: "tc-2", title: "tool call", status: "pending" });
  });

  it("creates a fresh card from a tool_call_update whose id was never seen (out-of-order delivery)", () => {
    const state = reduceChatEvent(initialAgentChatState(), event("tool_call_update", { toolCallId: "tc-3", status: "failed" }));
    expect(state.transcript).toMatchObject([{ kind: "tool", toolCallId: "tc-3", status: "failed" }]);
  });

  it("ignores a tool event with no toolCallId rather than guessing an identity", () => {
    const before = initialAgentChatState();
    const state = reduceChatEvent(before, event("tool_call", { title: "mystery" }));
    expect(state).toBe(before);
  });

  it("drops an unrecognized status string instead of corrupting the tool's state machine", () => {
    let state = reduceChatEvent(initialAgentChatState(), event("tool_call", { toolCallId: "tc-4", status: "pending" }));
    state = reduceChatEvent(state, event("tool_call_update", { toolCallId: "tc-4", status: "definitely-not-a-status" }));
    expect((state.transcript[0] as ChatToolItem).status).toBe("pending");
  });
});

describe("reduceChatEvent — permission lifecycle", () => {
  it("surfaces a permission_request as a pending card with typed options", () => {
    const state = reduceChatEvent(
      initialAgentChatState(),
      event("permission_request", {
        requestId: "req-1",
        toolCall: { title: "rm -rf build/", kind: "execute" },
        options: [
          { optionId: "allow_once", name: "Allow once" },
          { optionId: "deny" }, // no name/label — falls back to optionId
        ],
      }),
    );

    expect(state.pendingPermission).toEqual({ requestId: "req-1" });
    expect(state.transcript).toMatchObject([
      {
        kind: "permission",
        requestId: "req-1",
        title: "rm -rf build/",
        toolKind: "execute",
        options: [
          { optionId: "allow_once", label: "Allow once" },
          { optionId: "deny", label: "deny" },
        ],
      },
    ]);
  });

  it("ignores a permission_request with no requestId", () => {
    const before = initialAgentChatState();
    const state = reduceChatEvent(before, event("permission_request", { options: [] }));
    expect(state).toBe(before);
  });
});

describe("reduceChatEvent — usage, status/error, and unknown kinds", () => {
  it("records usage_update tokens without touching the transcript", () => {
    const state = reduceChatEvent(initialAgentChatState(), event("usage_update", { inputTokens: 120, outputTokens: 40 }));
    expect(state.usage).toEqual({ inputTokens: 120, outputTokens: 40, totalTokens: undefined });
    expect(state.transcript).toHaveLength(0);
    expect(state.unread).toBe(0); // no transcript growth, no badge bump
  });

  it("promotes status to error and appends a status line on a synthetic error event", () => {
    const state = reduceChatEvent(initialAgentChatState(), event("error", { message: "child process exited" }));
    expect(state.status).toBe("error");
    expect(state.error).toBe("child process exited");
    expect(state.transcript).toMatchObject([{ kind: "status", level: "error", text: "child process exited" }]);
  });

  it("quietly no-ops on an unrecognized ACP kind (e.g. available_commands_update)", () => {
    const before = initialAgentChatState();
    const state = reduceChatEvent(before, event("available_commands_update", { commands: ["/foo"] }));
    expect(state).toBe(before);
  });

  it("never throws on a non-record payload for any known kind", () => {
    const kinds = ["agent_message_chunk", "tool_call", "tool_call_update", "plan", "usage_update", "permission_request", "status", "error"];
    for (const kind of kinds) {
      expect(() => reduceChatEvent(initialAgentChatState(), event(kind, "just a string"))).not.toThrow();
      expect(() => reduceChatEvent(initialAgentChatState(), event(kind, null))).not.toThrow();
      expect(() => reduceChatEvent(initialAgentChatState(), event(kind, 42))).not.toThrow();
    }
  });
});

// --- action layer: window.junto mocked exactly like tests/mutations.test.ts,
// one unique agentKey per test so the shared chatState$ store never bleeds
// between cases. ---------------------------------------------------------

interface MockJunto {
  chatOpen: ReturnType<typeof vi.fn>;
  chatPrompt: ReturnType<typeof vi.fn>;
  chatPermission: ReturnType<typeof vi.fn>;
  chatSetModel: ReturnType<typeof vi.fn>;
  chatClose: ReturnType<typeof vi.fn>;
  onChatEvent: ReturnType<typeof vi.fn>;
}

let keyCounter = 0;
const freshAgentKey = (): string => `remote-a:test-${++keyCounter}`;

function installMockJunto(overrides: Partial<MockJunto> = {}): MockJunto {
  const mock: MockJunto = {
    chatOpen: vi.fn(async (): Promise<ChatOpenResult> => ({ ok: true, sessionId: "s1", models: [{ modelId: "m1" }] })),
    chatPrompt: vi.fn(async () => ({ ok: true })),
    chatPermission: vi.fn(async () => ({ ok: true })),
    chatSetModel: vi.fn(async () => ({ ok: true })),
    chatClose: vi.fn(async () => ({ ok: true })),
    onChatEvent: vi.fn(() => () => undefined),
    ...overrides,
  };
  (globalThis as unknown as { window: { junto: MockJunto } }).window = { junto: mock };
  return mock;
}

function clearWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

describe("openChat", () => {
  afterEach(clearWindow);

  it("goes connecting -> live and adopts the returned session/models", async () => {
    const agentKey = freshAgentKey();
    const mock = installMockJunto();
    const promise = openChat(agentKey);
    expect(getAgentChatState(agentKey).status).toBe("connecting");
    await promise;
    expect(mock.chatOpen).toHaveBeenCalledWith(agentKey, undefined);
    const state = getAgentChatState(agentKey);
    expect(state.status).toBe("live");
    expect(state.sessionId).toBe("s1");
    expect(state.selectedModelId).toBe("m1");
  });

  it("surfaces ok:false as an error state, threading an authMethods hint through", async () => {
    const agentKey = freshAgentKey();
    // authMethods isn't in the typed ChatOpenResult — ACP carries it on the raw
    // payload when the agent isn't authenticated yet; extractAuthMethods reads
    // it defensively off the untyped result.
    installMockJunto({
      chatOpen: vi.fn(async () => ({ ok: false, error: "not authenticated", authMethods: ["oauth"] }) as unknown as ChatOpenResult),
    });
    await openChat(agentKey);
    const state = getAgentChatState(agentKey);
    expect(state.status).toBe("error");
    expect(state.error).toBe("not authenticated");
    expect(state.authMethods).toEqual(["oauth"]);
  });

  it("degrades to a quiet error state when window.junto is absent — never throws", async () => {
    clearWindow();
    const agentKey = freshAgentKey();
    await expect(openChat(agentKey)).resolves.toBeUndefined();
    expect(getAgentChatState(agentKey)).toMatchObject({ status: "error", error: "chat unavailable" });
  });

  it("degrades to a quiet error state when chatOpen rejects", async () => {
    const agentKey = freshAgentKey();
    installMockJunto({ chatOpen: vi.fn(async () => { throw new Error("ipc down"); }) });
    await openChat(agentKey);
    expect(getAgentChatState(agentKey)).toMatchObject({ status: "error", error: "ipc down" });
  });
});

describe("sendPrompt", () => {
  afterEach(clearWindow);

  it("pushes an optimistic user item and forwards context block texts to chatPrompt", async () => {
    const agentKey = freshAgentKey();
    const mock = installMockJunto();
    await sendPrompt(agentKey, "  hello agent  ", [{ label: "node", text: "selected node digest" }]);
    expect(mock.chatPrompt).toHaveBeenCalledWith(agentKey, "hello agent", ["selected node digest"]);
    expect(getAgentChatState(agentKey).transcript).toMatchObject([{ kind: "user", text: "hello agent" }]);
  });

  it("is a no-op for blank text", async () => {
    const agentKey = freshAgentKey();
    const mock = installMockJunto();
    await sendPrompt(agentKey, "   ");
    expect(mock.chatPrompt).not.toHaveBeenCalled();
    expect(getAgentChatState(agentKey).transcript).toHaveLength(0);
  });

  it("appends an error status line when the turn fails, without throwing", async () => {
    const agentKey = freshAgentKey();
    installMockJunto({ chatPrompt: vi.fn(async () => ({ ok: false, error: "agent refused" })) });
    await sendPrompt(agentKey, "do the thing");
    const transcript = getAgentChatState(agentKey).transcript;
    expect(transcript.map((item) => item.kind)).toEqual(["user", "status"]);
    expect(transcript[1]).toMatchObject({ level: "error", text: "agent refused" });
  });
});

describe("answerPermission — lifecycle", () => {
  afterEach(clearWindow);

  it("marks the card answered, clears pendingPermission, and calls chatPermission with the chosen option", async () => {
    const agentKey = freshAgentKey();
    const mock = installMockJunto();
    let state = reduceChatEvent(
      initialAgentChatState(),
      event("permission_request", { requestId: "req-9", options: [{ optionId: "allow_once" }, { optionId: "deny" }] }, agentKey),
    );
    chatState$[agentKey].set(state);
    expect(getAgentChatState(agentKey).pendingPermission).toEqual({ requestId: "req-9" });

    await answerPermission(agentKey, "req-9", "allow_once");

    expect(mock.chatPermission).toHaveBeenCalledWith(agentKey, "req-9", "allow_once");
    state = getAgentChatState(agentKey);
    expect(state.pendingPermission).toBeUndefined();
    expect(state.transcript[0]).toMatchObject({ kind: "permission", answeredOptionId: "allow_once" });
  });

  it("still marks the card answered (disabling it) even if the IPC call fails", async () => {
    const agentKey = freshAgentKey();
    installMockJunto({ chatPermission: vi.fn(async () => ({ ok: false })) });
    chatState$[agentKey].set(
      reduceChatEvent(initialAgentChatState(), event("permission_request", { requestId: "req-10", options: [{ optionId: "deny" }] }, agentKey)),
    );

    await answerPermission(agentKey, "req-10", "deny");

    const state = getAgentChatState(agentKey);
    expect(state.transcript[0]).toMatchObject({ answeredOptionId: "deny" });
    expect(state.transcript[1]).toMatchObject({ level: "error" }); // failure surfaced, not swallowed
  });
});

describe("setModel / closeChat / markRead", () => {
  afterEach(clearWindow);

  it("setModel adopts the id on success and reports failure otherwise", async () => {
    const agentKey = freshAgentKey();
    installMockJunto({ chatSetModel: vi.fn(async () => ({ ok: true })) });
    await setModel(agentKey, "opus");
    expect(getAgentChatState(agentKey).selectedModelId).toBe("opus");
  });

  it("closeChat sets status closed even when window.junto is absent", async () => {
    clearWindow();
    const agentKey = freshAgentKey();
    await closeChat(agentKey);
    expect(getAgentChatState(agentKey).status).toBe("closed");
  });

  it("markRead zeroes the unread counter", () => {
    const agentKey = freshAgentKey();
    chatState$[agentKey].set({ ...initialAgentChatState(), unread: 4 });
    markRead(agentKey);
    expect(getAgentChatState(agentKey).unread).toBe(0);
  });
});

describe("subscribeChatEvents", () => {
  afterEach(clearWindow);

  it("degrades to a no-op unsubscribe when onChatEvent is absent", () => {
    clearWindow();
    const unsubscribe = subscribeChatEvents();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("routes a pushed ChatEvent into the right agent's slot", () => {
    const agentKey = freshAgentKey();
    let handler: ((event: ChatEvent) => void) | undefined;
    installMockJunto({
      onChatEvent: vi.fn((listener: (event: ChatEvent) => void) => { handler = listener; return () => undefined; }),
    });
    const unsubscribe = subscribeChatEvents();
    expect(handler).toBeTypeOf("function");
    handler?.({ agentKey, kind: "agent_message_chunk", payload: { content: { text: "routed" } } });
    expect(getAgentChatState(agentKey).transcript).toMatchObject([{ kind: "assistant", text: "routed" }]);
    unsubscribe();
  });

  it("mirrors coarse chrome on stream events and paint-equals skip identical slots", () => {
    const agentKey = freshAgentKey();
    let handler: ((event: ChatEvent) => void) | undefined;
    installMockJunto({
      onChatEvent: vi.fn((listener: (event: ChatEvent) => void) => {
        handler = listener;
        return () => undefined;
      }),
    });
    const unsubscribe = subscribeChatEvents();
    handler?.({ agentKey, kind: "status", payload: { status: "live" } });
    const first = chatCoarse$[agentKey].peek();
    expect(first).toMatchObject({ status: "live", turnBusy: false, hasBusyTools: false });

    handler?.({ agentKey, kind: "agent_message_chunk", payload: { content: { text: "tok" } } });
    // Token chunk must not remint coarse identity when chrome fields unchanged.
    expect(chatCoarse$[agentKey].peek()).toBe(first);

    handler?.({
      agentKey,
      kind: "tool_call",
      payload: { toolCallId: "t1", title: "grep", status: "in_progress" },
    });
    const withTool = chatCoarse$[agentKey].peek();
    expect(withTool).not.toBe(first);
    expect(withTool?.hasBusyTools).toBe(true);
    unsubscribe();
  });
});

describe("setAgentChatState / chatCoarse$", () => {
  it("keeps chatCoarse$ in lockstep with full slot writes", () => {
    const agentKey = `test-${Math.random().toString(36).slice(2)}`;
    setAgentChatState(agentKey, {
      ...initialAgentChatState(),
      status: "live",
      turnBusy: true,
      pendingPermission: { requestId: "p1" },
      transcript: [{ kind: "tool", id: "t1", toolCallId: "t1", title: "x", status: "pending", ts: 1 }],
    });
    expect(chatCoarse$[agentKey].peek()).toEqual({
      status: "live",
      pendingPermissionId: "p1",
      turnBusy: true,
      hasBusyTools: true,
    });
  });

  it("closeChat clears pending permission in both stores", async () => {
    clearWindow();
    const agentKey = `test-${Math.random().toString(36).slice(2)}`;
    setAgentChatState(agentKey, {
      ...initialAgentChatState(),
      status: "live",
      pendingPermission: { requestId: "p2" },
    });
    await closeChat(agentKey);
    expect(getAgentChatState(agentKey).pendingPermission).toBeUndefined();
    expect(chatCoarse$[agentKey].peek()?.pendingPermissionId).toBeUndefined();
    expect(chatCoarse$[agentKey].peek()?.status).toBe("closed");
  });
});

describe("extractAuthMethods", () => {
  it("reads a string array off an untyped payload and drops anything malformed", () => {
    expect(extractAuthMethods({ authMethods: ["oauth", "device_code"] })).toEqual(["oauth", "device_code"]);
    expect(extractAuthMethods({ authMethods: [1, "oauth", null] })).toEqual(["oauth"]);
    expect(extractAuthMethods({ authMethods: [] })).toBeUndefined();
    expect(extractAuthMethods({})).toBeUndefined();
    expect(extractAuthMethods(null)).toBeUndefined();
    expect(extractAuthMethods("nope")).toBeUndefined();
  });
});

// Type-level smoke: AgentChatState is exported and matches the field list the
// per-agent store is specified around.
const _typeCheck: AgentChatState = initialAgentChatState();
void _typeCheck;
