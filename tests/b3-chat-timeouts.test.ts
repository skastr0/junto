import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  type AcpChildLike,
  type AcpClientHandlers,
  type JsonRpcId,
  type SpawnFn,
} from "../src/main/vellum/chat/acp-client";
import { ChatService } from "../src/main/vellum/chat/service";
import { buildAcpSpawnTarget, type AcpSpawnTarget } from "../src/main/vellum/chat/spawn";

// Covers batch b3-chat's timeout/race/kill-escalation contract:
//   - every post-handshake AcpClient.request() (session/new, session/load,
//     session/set_model, session/prompt) is now bounded (acp-client.ts
//     REQUEST_TIMEOUT_MS) so a wedged child can never latch
//     promptInFlight/openInFlight or a live-but-empty session forever.
//   - a second chatOpen racing an in-flight handshake joins it instead of
//     reading the partially-constructed session (service.ts sessionId !== "").
//   - close() (and a request timeout) escalate SIGTERM -> SIGKILL after a
//     grace window if the child never exits.

const TARGET: AcpSpawnTarget = buildAcpSpawnTarget("local:default")!;

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

const lastSentId = (child: FakeChild): JsonRpcId =>
  (JSON.parse(child.written[child.written.length - 1]!) as { id: JsonRpcId }).id;
const methodOf = (child: FakeChild, index: number): string =>
  (JSON.parse(child.written[index]!) as { method?: string }).method ?? "";

const respondOk = (child: FakeChild, id: JsonRpcId, result: unknown): void => {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const noopHandlers = (): AcpClientHandlers => ({
  onNotification: vi.fn(),
  onAgentRequest: vi.fn(),
  onLifecycle: vi.fn(),
});

// Drains the microtask queue a generous number of times — robust way to
// wait for "the next write has happened" without hand-counting await hops
// (mirrors tests/chat-service.test.ts's helper of the same shape).
const flush = async (ticks = 12): Promise<void> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

const waitForWrites = async (child: FakeChild, minLength: number): Promise<void> => {
  for (let i = 0; i < 20 && child.written.length < minLength; i++) await flush(1);
};

const INIT_RESULT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };

function fakeSpawn(): { spawnFn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AcpClient — SIGTERM -> SIGKILL escalation", () => {
  it("close() sends SIGTERM, then escalates to SIGKILL after the grace window if the child never exits", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = new AcpClient(TARGET, noopHandlers(), () => child);

    const startPromise = client.start();
    respondOk(child, lastSentId(child), INIT_RESULT);
    await startPromise;

    client.close();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenCalledTimes(1); // no escalation before the grace window elapses

    await vi.advanceTimersByTimeAsync(2_000); // SIGTERM_GRACE_MS
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("does not escalate if the child exits within the grace window", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = new AcpClient(TARGET, noopHandlers(), () => child);

    const startPromise = client.start();
    respondOk(child, lastSentId(child), INIT_RESULT);
    await startPromise;

    client.close();
    child.emit("exit", 0); // the real child reacted to SIGTERM promptly

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledTimes(1); // SIGTERM only
  });

  it("close() is idempotent — a second call is a no-op", async () => {
    const child = new FakeChild();
    const client = new AcpClient(TARGET, noopHandlers(), () => child);

    const startPromise = client.start();
    respondOk(child, lastSentId(child), INIT_RESULT);
    await startPromise;

    client.close();
    client.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("ChatService — a stalled session/new times out and tears the session down", () => {
  it("rejects ok:false after the 30s session/new budget, kills the child, and a retry opens cleanly", async () => {
    vi.useFakeTimers();
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT); // initialize
    await waitForWrites(child, 2);
    expect(methodOf(child, 1)).toBe("session/new");

    // Never answer session/new — the child is wedged. Advance past its 30s
    // budget (acp-client.ts REQUEST_TIMEOUT_MS["session/new"]).
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await openPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); // the wedged child got torn down

    // Retry: since the dead session was deleted (not left half-open), a
    // fresh chatOpen spawns a brand-new child and completes normally.
    const retryPromise = service.chatOpen("local:default");
    expect(children).toHaveLength(2);
    const child2 = children[1]!;
    await waitForWrites(child2, 1);
    respondOk(child2, lastSentId(child2), INIT_RESULT);
    await waitForWrites(child2, 2);
    respondOk(child2, lastSentId(child2), { sessionId: "sess-retry", models: { availableModels: [] } });

    await expect(retryPromise).resolves.toEqual({
      ok: true,
      sessionId: "sess-retry",
      resumed: false,
      models: [],
    });
  });
});

describe("ChatService — racing chatOpen calls join the in-flight handshake", () => {
  it("two chatOpen calls fired before the handshake settles share one child and both get the real sessionId", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const first = service.chatOpen("local:default");
    const second = service.chatOpen("local:default"); // racing call — must NOT see the empty-sessionId session

    expect(children).toHaveLength(1); // only one child ever spawned for the pair

    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT);
    await waitForWrites(child, 2);
    respondOk(child, lastSentId(child), { sessionId: "sess-shared", models: { availableModels: [] } });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ ok: true, sessionId: "sess-shared", resumed: false, models: [] });
    expect(secondResult).toEqual({ ok: true, sessionId: "sess-shared", resumed: false, models: [] });
  });

  it("a third chatOpen after the session is live returns the same result without a second spawn", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT);
    await waitForWrites(child, 2);
    respondOk(child, lastSentId(child), { sessionId: "sess-1", models: { availableModels: [] } });
    await openPromise;

    const again = await service.chatOpen("local:default");
    expect(children).toHaveLength(1);
    expect(again).toEqual({ ok: true, sessionId: "sess-1", resumed: false, models: [] });
  });
});

describe("ChatService — a stalled session/prompt clears promptInFlight instead of latching", () => {
  it("times out after the 840s prompt budget, tears the session down, and a fresh open+prompt recovers", async () => {
    vi.useFakeTimers();
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);

    const openPromise = service.chatOpen("local:default");
    const child = children[0]!;
    await waitForWrites(child, 1);
    respondOk(child, lastSentId(child), INIT_RESULT);
    await waitForWrites(child, 2);
    respondOk(child, lastSentId(child), { sessionId: "sess-1", models: { availableModels: [] } });
    await openPromise;

    const promptPromise = service.chatPrompt("local:default", "hello");
    await waitForWrites(child, 3);
    expect(methodOf(child, 2)).toBe("session/prompt");

    // Never answer — advance past the 840s budget (REQUEST_TIMEOUT_MS["session/prompt"]).
    await vi.advanceTimersByTimeAsync(840_000);

    const promptResult = await promptPromise;
    expect(promptResult.ok).toBe(false);
    expect(promptResult.error).toMatch(/timed out/);

    // The session was torn down as part of the timeout — a second prompt
    // against the same agentKey reports "not open", never the old "turn in
    // flight" latch this fix removes.
    const secondPrompt = await service.chatPrompt("local:default", "again");
    expect(secondPrompt).toEqual({ ok: false, error: "chat session not open — call chatOpen first" });

    // Retry: a fresh open + prompt against a brand-new child succeeds cleanly.
    const retryOpen = service.chatOpen("local:default");
    expect(children).toHaveLength(2);
    const child2 = children[1]!;
    await waitForWrites(child2, 1);
    respondOk(child2, lastSentId(child2), INIT_RESULT);
    await waitForWrites(child2, 2);
    respondOk(child2, lastSentId(child2), { sessionId: "sess-2", models: { availableModels: [] } });
    await retryOpen;

    const retryPrompt = service.chatPrompt("local:default", "hi again");
    await waitForWrites(child2, 3);
    respondOk(child2, lastSentId(child2), { stopReason: "end_turn" });
    await expect(retryPrompt).resolves.toEqual({ ok: true, stopReason: "end_turn" });
  });
});
