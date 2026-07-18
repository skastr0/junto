import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  AcpRpcError,
  makeLocalBrowserChildEnvironment,
  type AcpChildLike,
  type AcpClientHandlers,
  type JsonRpcId,
} from "../src/main/vellum/chat/acp-client";
import { buildAcpSpawnTarget, type AcpSpawnTarget } from "../src/main/vellum/chat/spawn";

const TARGET = buildAcpSpawnTarget("local:default")!;

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

const respondOk = (child: FakeChild, id: JsonRpcId, result: unknown): void => {
  child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const noopHandlers = (): AcpClientHandlers => ({
  onNotification: vi.fn(),
  onAgentRequest: vi.fn(),
  onLifecycle: vi.fn(),
});

const clients: AcpClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  delete process.env.VELLUM_ACP_VERBOSE;
  delete process.env.VELLUM_DEBUG;
  vi.useRealTimers();
});

async function startedClient(
  handlers: AcpClientHandlers = noopHandlers(),
): Promise<{ client: AcpClient; child: FakeChild }> {
  const child = new FakeChild();
  const client = new AcpClient(TARGET, handlers, () => child);
  clients.push(client);
  const startPromise = client.start();
  respondOk(child, lastSentId(child), {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    authMethods: [],
  });
  await startPromise;
  return { client, child };
}

describe("AcpClient.start", () => {
  it("sends the initialize handshake with the proven wire shape", () => {
    const child = new FakeChild();
    const client = new AcpClient(TARGET, noopHandlers(), () => child);
    clients.push(client);

    // This test only cares about the synchronous write; afterEach's cleanup
    // close() will reject this later (never answered) — swallow that so it
    // doesn't surface as an unhandled rejection.
    client.start().catch(() => {});

    expect(child.written).toHaveLength(1);
    expect(JSON.parse(child.written[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
  });

  it("resolves with the agent's initialize result once the matching response arrives", async () => {
    const { client } = await startedClient();
    expect(client.closed).toBe(false);
  });

  it("terminates a child whose unterminated inbound frame exceeds 1 MiB", async () => {
    const handlers = noopHandlers();
    const { client, child } = await startedClient(handlers);

    child.stdout.emit("data", "x".repeat(1024 * 1024 + 1));

    expect(client.closed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(handlers.onLifecycle).toHaveBeenCalledWith({
      kind: "error",
      message: "ACP inbound frame exceeded the 1 MiB limit",
    });
  });

  it("consumes a validated local child overlay at spawn without changing ACP intent", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const overlay = makeLocalBrowserChildEnvironment({
      capability: Buffer.alloc(32, 0xa1).toString("base64url"),
      home: "/tmp/vellum-browser",
    });
    const client = new AcpClient(TARGET, noopHandlers(), spawn, overlay);
    clients.push(client);
    const start = client.start();

    expect(spawn).toHaveBeenCalledWith(TARGET, { environmentOverlay: overlay });
    expect(TARGET).toEqual({ host: "local", profile: "default" });
    expect(child.written[0]).not.toContain(overlay.VELLUM_BROWSER_CAPABILITY);
    expect(child.written[0]).not.toContain(overlay.VELLUM_BROWSER_HOME);
    respondOk(child, lastSentId(child), {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    });
    await start;
  });

  it("rejects a remote child overlay before invoking spawn", async () => {
    const remote: AcpSpawnTarget = buildAcpSpawnTarget("remote-a:default")!;
    const spawn = vi.fn(() => new FakeChild());
    const client = new AcpClient(
      remote,
      noopHandlers(),
      spawn,
      makeLocalBrowserChildEnvironment({
        capability: Buffer.alloc(32, 0xa1).toString("base64url"),
        home: "/tmp/vellum-browser",
      }),
    );
    clients.push(client);

    await expect(client.start()).rejects.toThrow("local-only");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized environment values", () => {
    expect(() => makeLocalBrowserChildEnvironment({
      capability: "short",
      home: "/tmp/vellum-browser",
    })).toThrow("invalid format");
    expect(() => makeLocalBrowserChildEnvironment({
      capability: "a".repeat(43),
      home: "/tmp/vellum-browser",
    })).toThrow("invalid format");
    expect(() => makeLocalBrowserChildEnvironment({
      capability: Buffer.alloc(32, 0xa1).toString("base64url"),
      home: "relative/path",
    })).toThrow("bounded absolute path");
    expect(() => makeLocalBrowserChildEnvironment({
      capability: Buffer.alloc(32, 0xa1).toString("base64url"),
      home: "/tmp/vellum\tbrowser",
    })).toThrow("bounded absolute path");
    expect(() => makeLocalBrowserChildEnvironment({
      capability: Buffer.alloc(32, 0xa1).toString("base64url"),
      home: "/tmp/vellum\u007fbrowser",
    })).toThrow("bounded absolute path");
    expect(() => makeLocalBrowserChildEnvironment({
      capability: Buffer.alloc(32, 0xa1).toString("base64url"),
      home: `/${"x".repeat(4_097)}`,
    })).toThrow("bounded absolute path");
  });

  it("rejects and kills the child after 20s with no response", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = new AcpClient(TARGET, noopHandlers(), () => child);
    clients.push(client);

    const startPromise = client.start();
    const assertion = expect(startPromise).rejects.toThrow(/timed out after 20s/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
  });
});

describe("AcpClient.request", () => {
  it("correlates responses to requests by id, independent of arrival order", async () => {
    const { client, child } = await startedClient();

    const first = client.request<{ tag: string }>("a", {});
    const second = client.request<{ tag: string }>("b", {});
    const firstId = JSON.parse(child.written[1]!).id;
    const secondId = JSON.parse(child.written[2]!).id;
    expect(firstId).not.toBe(secondId);

    // answer out of order
    respondOk(child, secondId, { tag: "second" });
    respondOk(child, firstId, { tag: "first" });

    await expect(first).resolves.toEqual({ tag: "first" });
    await expect(second).resolves.toEqual({ tag: "second" });
  });

  it("rejects with AcpRpcError carrying the JSON-RPC error code", async () => {
    const { client, child } = await startedClient();
    const promise = client.request("session/set_model", { modelId: "x", sessionId: "s1" });
    const id = lastSentId(child);
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })}\n`,
    );
    await expect(promise).rejects.toBeInstanceOf(AcpRpcError);
    await expect(promise).rejects.toMatchObject({ code: -32601, message: "method not found" });
  });

  it("splits ndjson lines that arrive split across multiple stdout chunks", async () => {
    const onNotification = vi.fn();
    const { child } = await startedClient({ onNotification, onAgentRequest: vi.fn(), onLifecycle: vi.fn() });
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_thought_chunk" } },
    });
    child.stdout.emit("data", line.slice(0, 10));
    child.stdout.emit("data", `${line.slice(10)}\n`);
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith("session/update", { update: { sessionUpdate: "agent_thought_chunk" } });
  });

  it("handles two ndjson lines delivered in a single stdout chunk", async () => {
    const onNotification = vi.fn();
    const { child } = await startedClient({ onNotification, onAgentRequest: vi.fn(), onLifecycle: vi.fn() });
    const lineA = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "a" } } });
    const lineB = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "b" } } });
    child.stdout.emit("data", `${lineA}\n${lineB}\n`);
    expect(onNotification).toHaveBeenCalledTimes(2);
  });
});

describe("agent -> client requests and notifications", () => {
  it("routes a line with id+method to onAgentRequest, distinct from a bare response", async () => {
    const onAgentRequest = vi.fn();
    const { child } = await startedClient({ onNotification: vi.fn(), onAgentRequest, onLifecycle: vi.fn() });
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { sessionId: "s1", options: [] } })}\n`,
    );
    expect(onAgentRequest).toHaveBeenCalledWith("session/request_permission", 77, { sessionId: "s1", options: [] });
  });

  it("respond()/respondError() write correctly-shaped JSON-RPC response lines", async () => {
    const { client, child } = await startedClient();
    child.written.length = 0;

    client.respond(77, { outcome: { outcome: "selected", optionId: "allow_once" } });
    client.respondError(78, -32601, "method not found: foo/bar");

    expect(JSON.parse(child.written[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 77,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    expect(JSON.parse(child.written[1]!)).toEqual({
      jsonrpc: "2.0",
      id: 78,
      error: { code: -32601, message: "method not found: foo/bar" },
    });
  });

  it("ignores a non-JSON line instead of throwing", async () => {
    const onNotification = vi.fn();
    const { child } = await startedClient({ onNotification, onAgentRequest: vi.fn(), onLifecycle: vi.fn() });
    expect(() => child.stdout.emit("data", "not json at all\n")).not.toThrow();
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("keeps stderr private by default and never treats it as protocol input", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onNotification = vi.fn();
    const { child } = await startedClient({ onNotification, onAgentRequest: vi.fn(), onLifecycle: vi.fn() });
    child.stderr.emit("data", "some log line\n");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(onNotification).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("forwards stderr only under the explicit verbose diagnostic opt-in", async () => {
    process.env.VELLUM_ACP_VERBOSE = "1";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onNotification = vi.fn();
    const { child } = await startedClient({ onNotification, onAgentRequest: vi.fn(), onLifecycle: vi.fn() });
    child.stderr.emit("data", "diagnostic line\n");
    expect(debugSpy).toHaveBeenCalledWith("[acp:local:default]", "diagnostic line");
    expect(onNotification).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("crash handling", () => {
  it("child exit rejects pending requests and fires onLifecycle('closed')", async () => {
    const onLifecycle = vi.fn();
    const { client, child } = await startedClient({ onNotification: vi.fn(), onAgentRequest: vi.fn(), onLifecycle });

    const pending = client.request("session/prompt", { sessionId: "s1", prompt: [] });
    child.emit("exit", 1);

    await expect(pending).rejects.toThrow(/exited/);
    expect(onLifecycle).toHaveBeenCalledWith({ kind: "closed", code: 1 });
    expect(client.closed).toBe(true);
  });

  it("child error fires onLifecycle('error') with the underlying message", async () => {
    const onLifecycle = vi.fn();
    const { client, child } = await startedClient({ onNotification: vi.fn(), onAgentRequest: vi.fn(), onLifecycle });

    child.emit("error", new Error("ENOENT: hermes not found"));

    expect(onLifecycle).toHaveBeenCalledWith({ kind: "error", message: "ENOENT: hermes not found" });
    expect(client.closed).toBe(true);
  });

  it("an intentional close() never fires onLifecycle", async () => {
    const onLifecycle = vi.fn();
    const { client, child } = await startedClient({ onNotification: vi.fn(), onAgentRequest: vi.fn(), onLifecycle });

    client.close();
    child.emit("exit", 0); // the real child's exit event still fires after kill()

    expect(onLifecycle).not.toHaveBeenCalled();
  });

  it("request() rejects immediately once closed", async () => {
    const { client } = await startedClient();
    client.close();
    await expect(client.request("session/prompt", {})).rejects.toThrow(/not running/);
  });
});
