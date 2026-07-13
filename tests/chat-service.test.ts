import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpChildLike, JsonRpcId, SpawnFn } from "../src/main/vellum/chat/acp-client";
import { ChatService } from "../src/main/vellum/chat/service";
import type { ChatEvent } from "../src/shared/ipc";

class FakeChild extends EventEmitter implements AcpChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk);
      return true;
    },
  };
  kill = vi.fn();
}

const lastSentId = (child: FakeChild): JsonRpcId => (JSON.parse(child.written[child.written.length - 1]!) as { id: JsonRpcId }).id;
const methodOf = (child: FakeChild, index: number): string => (JSON.parse(child.written[index]!) as { method?: string }).method ?? "";
const paramsOf = (child: FakeChild, index: number): unknown => (JSON.parse(child.written[index]!) as { params?: unknown }).params;

const respondOk = (child: FakeChild, id: JsonRpcId, result: unknown): void => {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const respondErr = (child: FakeChild, id: JsonRpcId, code: number, message: string): void => {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
};

// Drains the microtask queue a generous number of times. Exact "how many
// `await`s does a resolve need to propagate through" is an implementation
// detail (differs for a plain request() vs the withTimeout-wrapped one in
// start()) — looping well past any real chain is the robust way to wait
// for "the next write has happened" without hand-counting hops.
const flush = async (ticks = 12): Promise<void> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

// Waits until the fake child has written at least `minLength` lines, or
// gives up after a bounded number of microtask flushes (fails loudly via
// the caller's subsequent assertion rather than hanging).
const waitForWrites = async (child: FakeChild, minLength: number): Promise<void> => {
  for (let i = 0; i < 20 && child.written.length < minLength; i++) {
    await flush(1);
  }
};

const INIT_RESULT = (authMethods: ReadonlyArray<{ id?: string; name?: string }> = []) => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods,
});

// One spawnFn shared by a test that hands out one FakeChild per spawn() call
// (mirroring how ChatService spawns a fresh child per agentKey/session).
function fakeSpawn(): { spawnFn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

// Drives chatOpen for the given agent key through a successful handshake +
// session/new, returning once the open has resolved. Takes the shared
// `children` array (not a specific child) and reads off whichever child was
// just spawned — chatOpen()'s synchronous prefix spawns before returning a
// pending promise, so children.at(-1) is always the right one, even for a
// second open after a prior close().
async function openHappyPath(
  service: ChatService,
  children: FakeChild[],
  agentKey = "local:default",
  opts: { sessionId?: string; modelId?: string } = {},
): Promise<{ result: Awaited<ReturnType<ChatService["chatOpen"]>>; child: FakeChild }> {
  const openPromise = service.chatOpen(agentKey);
  const child = children[children.length - 1]!;
  await waitForWrites(child, 1);
  respondOk(child, lastSentId(child), INIT_RESULT()); // initialize
  await waitForWrites(child, 2);
  respondOk(child, lastSentId(child), {
    sessionId: opts.sessionId ?? "sess-1",
    models: { availableModels: [{ modelId: opts.modelId ?? "model-a", name: "Model A", description: "desc" }] },
  }); // session/new
  const result = await openPromise;
  return { result, child };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatOpen", () => {
  it("spawns local:default, sends session/new with the real home dir, and maps models", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const { result, child } = await openHappyPath(service, children);

    expect(methodOf(child, 0)).toBe("initialize");
    expect(methodOf(child, 1)).toBe("session/new");
    expect(paramsOf(child, 1)).toEqual({ cwd: homedir(), mcpServers: [] });

    expect(result).toEqual({
      ok: true,
      sessionId: "sess-1",
      resumed: false,
      models: [{ modelId: "model-a", description: "desc" }],
    });
  });

  it("is idempotent per key: a second chatOpen while live returns the same session without respawning", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await openHappyPath(service, children);

    const second = await service.chatOpen("local:default");

    expect(children).toHaveLength(1); // no second spawn
    expect(second).toEqual({
      ok: true,
      sessionId: "sess-1",
      resumed: false,
      models: [{ modelId: "model-a", description: "desc" }],
    });
  });

  it("resumes via session/load when resumeSessionId is given", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default", "old-session");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT());
    await waitForWrites(child, 2);

    expect(methodOf(child, 1)).toBe("session/load");
    expect(paramsOf(child, 1)).toEqual({ sessionId: "old-session", cwd: homedir(), mcpServers: [] });

    respondOk(child, lastSentId(child), {
      models: { availableModels: [{ modelId: "model-a", description: "d" }] },
    });

    await expect(openPromise).resolves.toEqual({
      ok: true,
      sessionId: "old-session",
      resumed: true,
      models: [{ modelId: "model-a", description: "d" }],
    });
  });

  it("falls back to session/new when session/load answers with no session (null result)", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default", "gone-session");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT());
    await waitForWrites(child, 2);
    respondOk(child, lastSentId(child), null); // session/load: not found

    await waitForWrites(child, 3);
    expect(methodOf(child, 2)).toBe("session/new");
    respondOk(child, lastSentId(child), { sessionId: "fresh-1", models: { availableModels: [] } });

    await expect(openPromise).resolves.toEqual({ ok: true, sessionId: "fresh-1", resumed: false, models: [] });
  });

  it("rejects an invalid agent key without spawning", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const result = await service.chatOpen("not-a-valid-key");
    expect(result).toEqual({ ok: false, error: "invalid agent key: not-a-valid-key" });
    expect(children).toHaveLength(0);
  });

  it("surfaces authMethods in the error when session/new fails (creds missing)", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT([{ id: "env", name: "Environment Variable" }]));
    await waitForWrites(child, 2);
    respondErr(child, lastSentId(child), 1, "no credentials configured");

    const result = await openPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no credentials configured");
    expect(result.error).toContain("auth methods available: Environment Variable");
  });
});

describe("chatPrompt", () => {
  it("sends session/prompt with text + context blocks and resolves stopReason", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const promptPromise = service.chatPrompt("local:default", "reply with pong", ["node digest here"]);
    await waitForWrites(child, 3);
    expect(methodOf(child, 2)).toBe("session/prompt");
    expect(paramsOf(child, 2)).toEqual({
      sessionId: "sess-1",
      prompt: [
        { type: "text", text: "reply with pong" },
        { type: "text", text: "node digest here" },
      ],
    });

    respondOk(child, lastSentId(child), { stopReason: "end_turn" });
    await expect(promptPromise).resolves.toEqual({ ok: true, stopReason: "end_turn" });
  });

  it("rejects a concurrent second prompt with ok:false 'turn in flight'", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const first = service.chatPrompt("local:default", "one");
    const second = service.chatPrompt("local:default", "two");

    await expect(second).resolves.toEqual({ ok: false, error: "turn in flight" });

    await waitForWrites(child, 3);
    respondOk(child, lastSentId(child), { stopReason: "end_turn" });
    await expect(first).resolves.toEqual({ ok: true, stopReason: "end_turn" });
  });

  it("rejects with ok:false when no session is open", async () => {
    const service = new ChatService();
    const result = await service.chatPrompt("local:default", "hi");
    expect(result).toEqual({ ok: false, error: "chat session not open — call chatOpen first" });
  });
});

describe("permission requests", () => {
  it("surfaces session/request_permission as a permission_request ChatEvent, and chatPermission answers it", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "session/request_permission",
        params: { sessionId: "sess-1", options: [{ optionId: "allow_once" }], toolCall: { toolCallId: "t1" } },
      })}\n`,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.agentKey).toBe("local:default");
    expect(events[0]!.kind).toBe("permission_request");
    const payload = events[0]!.payload as { requestId: string; sessionId: string };
    expect(payload.sessionId).toBe("sess-1");
    expect(typeof payload.requestId).toBe("string");

    child.written.length = 0;
    const ack = await service.chatPermission("local:default", payload.requestId, "allow_once");
    expect(ack).toEqual({ ok: true });
    expect(JSON.parse(child.written[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
  });

  it("answers with ok:false for an unknown requestId", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await openHappyPath(service, children);

    expect(await service.chatPermission("local:default", "nope", "allow_once")).toEqual({ ok: false });
  });

  it("rejects an unknown agent -> client method with -32601", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);
    child.written.length = 0;

    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "fs/read_text_file", params: {} })}\n`,
    );

    expect(JSON.parse(child.written[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32601, message: "method not found: fs/read_text_file" },
    });
  });
});

describe("chatSetModel", () => {
  it("sends session/set_model and resolves ok:true on success", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const setPromise = service.chatSetModel("local:default", "model-b");
    await waitForWrites(child, 3);
    expect(methodOf(child, 2)).toBe("session/set_model");
    expect(paramsOf(child, 2)).toEqual({ modelId: "model-b", sessionId: "sess-1" });

    respondOk(child, lastSentId(child), {});
    await expect(setPromise).resolves.toEqual({ ok: true });
  });

  it("maps a -32601 JSON-RPC error to ok:false error:'unsupported'", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const setPromise = service.chatSetModel("local:default", "model-b");
    await waitForWrites(child, 3);
    respondErr(child, lastSentId(child), -32601, "method not found");

    await expect(setPromise).resolves.toEqual({ ok: false, error: "unsupported" });
  });
});

describe("chatClose", () => {
  it("kills the child and a later chatOpen spawns a fresh one", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await openHappyPath(service, children);

    const closeResult = await service.chatClose("local:default");
    expect(closeResult).toEqual({ ok: true });
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);

    const { result: reopened } = await openHappyPath(service, children, "local:default", { sessionId: "sess-2" });
    expect(children).toHaveLength(2);
    expect(reopened).toEqual({
      ok: true,
      sessionId: "sess-2",
      resumed: false,
      models: [{ modelId: "model-a", description: "desc" }],
    });
  });

  it("is a no-op ok:true when nothing is open", async () => {
    const service = new ChatService();
    expect(await service.chatClose("local:default")).toEqual({ ok: true });
  });
});

describe("crash / event projection", () => {
  it("an unexpected exit emits error then status:closed, and the session becomes unusable", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));

    child.emit("exit", 1);

    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("error");
    expect(events[1]!).toEqual({ agentKey: "local:default", kind: "status", payload: { status: "closed" } });

    const promptResult = await service.chatPrompt("local:default", "hello");
    expect(promptResult).toEqual({ ok: false, error: "chat session not open — call chatOpen first" });
  });

  it("forwards session/update notifications verbatim, tagged with kind = sessionUpdate", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));

    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } };
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update } })}\n`,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ agentKey: "local:default", kind: "agent_message_chunk", payload: update });
  });
});
