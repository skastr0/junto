import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcpChildLike,
  AcpSpawnOptions,
  JsonRpcId,
  SpawnFn,
} from "../src/main/vellum/chat/acp-client";
import type { AcpSpawnTarget } from "../src/main/vellum/chat/spawn";
import { ChatService } from "../src/main/vellum/chat/service";
import type { ChatEvent } from "../src/shared/ipc";

const noSpawn: SpawnFn = () => { throw new Error("unexpected ACP spawn"); };

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
function fakeSpawn(): {
  spawnFn: SpawnFn;
  children: FakeChild[];
  calls: Array<{ readonly target: AcpSpawnTarget; readonly options?: AcpSpawnOptions }>;
} {
  const children: FakeChild[] = [];
  const calls: Array<{ readonly target: AcpSpawnTarget; readonly options?: AcpSpawnOptions }> = [];
  const spawnFn: SpawnFn = (target, options) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ target, ...(options !== undefined ? { options } : {}) });
    return child;
  };
  return { spawnFn, children, calls };
}

const BROWSER_AUTHORITY = {
  capability: Buffer.alloc(32, 0xa1).toString("base64url"),
  home: "/tmp/vellum-browser",
};

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

async function finishPendingOpen(
  openPromise: Promise<Awaited<ReturnType<ChatService["chatOpen"]>>>,
  child: FakeChild,
  sessionId = "sess-authorized",
): Promise<Awaited<ReturnType<ChatService["chatOpen"]>>> {
  await waitForWrites(child, 1);
  respondOk(child, lastSentId(child), INIT_RESULT());
  await waitForWrites(child, 2);
  respondOk(child, lastSentId(child), {
    sessionId,
    models: { availableModels: [] },
  });
  return openPromise;
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

describe("local browser authority child environment", () => {
  it("passes a copied one-shot overlay only to the selected local child", async () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const processCapability = process.env.VELLUM_BROWSER_CAPABILITY;
    const processHome = process.env.VELLUM_BROWSER_HOME;

    const open = service.chatOpenWithLocalBrowserAuthority(
      "local:default",
      BROWSER_AUTHORITY,
    );
    expect(children).toHaveLength(1);
    expect(calls[0]).toEqual({
      target: {
        host: "local",
        profile: "default",
      },
      options: {
        environmentOverlay: {
          VELLUM_BROWSER_CAPABILITY: BROWSER_AUTHORITY.capability,
          VELLUM_BROWSER_HOME: BROWSER_AUTHORITY.home,
        },
      },
    });
    expect(process.env.VELLUM_BROWSER_CAPABILITY).toBe(processCapability);
    expect(process.env.VELLUM_BROWSER_HOME).toBe(processHome);

    const result = await finishPendingOpen(open, children[0]!);
    expect(result).toMatchObject({ ok: true, sessionId: "sess-authorized" });
    const wire = children[0]!.written.join("");
    expect(wire).not.toContain(BROWSER_AUTHORITY.capability);
    expect(wire).not.toContain(BROWSER_AUTHORITY.home);
  });

  it("rejects remote and malformed overlays before spawning", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await expect(
      service.chatOpenWithLocalBrowserAuthority("remote-a:default", BROWSER_AUTHORITY),
    ).resolves.toEqual({
      ok: false,
      error: "browser authority child environment is local-only",
    });
    await expect(
      service.chatOpenWithLocalBrowserAuthority("local:default", {
        capability: "short",
        home: "relative",
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(children).toHaveLength(0);
  });

  it("isolates concurrent local agents to their own overlay", async () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const authorityB = {
      capability: Buffer.alloc(32, 0xb2).toString("base64url"),
      home: "/tmp/vellum-browser-b",
    };
    const openA = service.chatOpenWithLocalBrowserAuthority(
      "local:agent-a",
      BROWSER_AUTHORITY,
    );
    const openB = service.chatOpenWithLocalBrowserAuthority(
      "local:agent-b",
      authorityB,
    );

    expect(calls[0]?.options?.environmentOverlay?.VELLUM_BROWSER_CAPABILITY)
      .toBe(BROWSER_AUTHORITY.capability);
    expect(calls[1]?.options?.environmentOverlay?.VELLUM_BROWSER_CAPABILITY)
      .toBe(authorityB.capability);
    await Promise.all([
      finishPendingOpen(openA, children[0]!, "sess-a"),
      finishPendingOpen(openB, children[1]!, "sess-b"),
    ]);
  });

  it("requires deliberate restart and automatically resumes the current live ACP session", async () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await openHappyPath(service, children, "local:default", { sessionId: "sess-current" });

    await expect(
      service.chatOpenWithLocalBrowserAuthority("local:default", BROWSER_AUTHORITY),
    ).resolves.toEqual({
      ok: false,
      error: "chat session already open or opening — use deliberate authority restart",
    });
    expect(children).toHaveLength(1);

    const restart = service.chatRestartWithLocalBrowserAuthority(
      "local:default",
      BROWSER_AUTHORITY,
    );
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(children).toHaveLength(2);
    expect(calls[1]?.options?.environmentOverlay?.VELLUM_BROWSER_CAPABILITY)
      .toBe(BROWSER_AUTHORITY.capability);
    const restartedChild = children[1]!;
    await waitForWrites(restartedChild, 1);
    respondOk(restartedChild, lastSentId(restartedChild), INIT_RESULT());
    await waitForWrites(restartedChild, 2);
    expect(methodOf(restartedChild, 1)).toBe("session/load");
    expect(paramsOf(restartedChild, 1)).toEqual({
      sessionId: "sess-current",
      cwd: homedir(),
      mcpServers: [],
    });
    respondOk(restartedChild, lastSentId(restartedChild), {
      models: { availableModels: [] },
    });
    await expect(restart).resolves.toEqual({
      ok: true,
      sessionId: "sess-current",
      resumed: true,
      models: [],
    });
  });

  it("prefers an explicit resume id over the current live ACP session", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    await openHappyPath(service, children, "local:default", { sessionId: "sess-current" });

    const restart = service.chatRestartWithLocalBrowserAuthority(
      "local:default",
      BROWSER_AUTHORITY,
      "sess-explicit",
    );
    const restartedChild = children[1]!;
    await waitForWrites(restartedChild, 1);
    respondOk(restartedChild, lastSentId(restartedChild), INIT_RESULT());
    await waitForWrites(restartedChild, 2);
    expect(methodOf(restartedChild, 1)).toBe("session/load");
    expect(paramsOf(restartedChild, 1)).toEqual({
      sessionId: "sess-explicit",
      cwd: homedir(),
      mcpServers: [],
    });
    respondOk(restartedChild, lastSentId(restartedChild), {
      models: { availableModels: [] },
    });

    await expect(restart).resolves.toEqual({
      ok: true,
      sessionId: "sess-explicit",
      resumed: true,
      models: [],
    });
  });

  it("revocation cancels an in-flight restart before stale authority can respawn", async () => {
    const { spawnFn, children } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const original = service.chatOpen("local:default");
    expect(children).toHaveLength(1);

    const restart = service.chatRestartWithLocalBrowserAuthority(
      "local:default",
      BROWSER_AUTHORITY,
    );
    await expect(service.chatRevokeLocalBrowserAuthority("local:default"))
      .resolves.toEqual({ ok: true });

    await expect(original).resolves.toMatchObject({ ok: false });
    await expect(restart).resolves.toEqual({
      ok: false,
      error: "authority restart superseded",
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.kill).toHaveBeenCalled();
  });

  it("does not reuse a consumed overlay after an unexpected child exit", async () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const authorized = service.chatOpenWithLocalBrowserAuthority(
      "local:default",
      BROWSER_AUTHORITY,
    );
    await finishPendingOpen(authorized, children[0]!);
    children[0]!.emit("exit", 1);

    const ordinary = service.chatOpen("local:default");
    expect(calls[1]?.options).toBeUndefined();
    await expect(finishPendingOpen(ordinary, children[1]!, "sess-ordinary"))
      .resolves.toMatchObject({ ok: true, sessionId: "sess-ordinary" });
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
    const service = new ChatService(noSpawn);
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
    const service = new ChatService(noSpawn);
    expect(await service.chatClose("local:default")).toEqual({ ok: true });
  });
});

describe("crash / event projection", () => {
  it("returns one-shot inspector replies through ACP stdin without process argv", async () => {
    const { spawnFn, children, calls } = fakeSpawn();
    const service = new ChatService(spawnFn);
    const { child } = await openHappyPath(service, children);

    const pending = service.agentMessage("local:default", "credential-shaped prompt");
    await waitForWrites(child, 3);
    const request = JSON.parse(child.written[2]!) as { readonly id: JsonRpcId };
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "private reply" },
    };
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } })}\n`,
    );
    respondOk(child, request.id, { stopReason: "end_turn" });

    expect(await pending).toEqual({ ok: true, reply: "private reply" });
    expect(calls[0]?.target).toEqual({ host: "local", profile: "default" });
    expect(JSON.stringify(calls[0]?.target)).not.toContain("credential-shaped prompt");
  });

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
