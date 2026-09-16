import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiLiveConnection,
  LIVE_MAX_CONTEXT_BYTES,
  LIVE_MAX_EVENT_BYTES,
  type OpenAiLiveConnectionOptions,
  type OpenAiLiveSocket,
} from "../src/main/junto/overseer/live/openai-connection";

class FakeSocket extends EventEmitter implements OpenAiLiveSocket {
  readyState = 0;
  sent: string[] = [];
  terminated = false;
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(event: unknown) { this.emit("message", Buffer.from(JSON.stringify(event))); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit("close"); }
}

const credentials = "test-live-credential-do-not-disclose";
const answer = { session: { id: "opaque/session:id" }, transport: { type: "webrtc", sdp: "answer SDP" } };
function fixture(overrides: Partial<OpenAiLiveConnectionOptions> = {}, open = true) {
  const socket = new FakeSocket();
  const onEvent = vi.fn();
  const onClosed = vi.fn();
  const options: OpenAiLiveConnectionOptions = {
    apiKey: credentials, offer: "offer SDP", instructions: "Describe verified canvas state.",
    onEvent, onClosed, ...overrides,
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith("/hangup") ? new Response(null, { status: 200 }) : Response.json(answer, { status: 201 }));
  const createSocket = vi.fn((_url: string, _settings: unknown) => {
    if (open) queueMicrotask(() => socket.open());
    return socket;
  });
  const dependencies = { fetch: fetcher, createSocket, startupTimeoutMs: 100, closeTimeoutMs: 50 };
  return { socket, onEvent, onClosed, options, fetcher, createSocket, dependencies };
}
function finalized(socket: FakeSocket) {
  socket.receive({ type: "session.closed", event_id: "end", reason: "close_requested", session: answer.session, usage: { seconds: 23.5 } });
}

afterEach(() => vi.useRealTimers());

describe("OpenAI Live transport", () => {
  it("creates one client-delegated WebRTC session and attaches without awaiting a replayed started event", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${credentials}`, "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      session: { model: "gpt-live-1", delegation: { type: "client" }, instructions: f.options.instructions, store: false },
      transport: { type: "webrtc", sdp: "offer SDP" },
    });
    expect(f.createSocket.mock.calls[0]?.[0]).toBe("wss://api.openai.com/v1/live/sessions/opaque%2Fsession%3Aid/attach");
    expect(connection).toMatchObject({ sessionId: "opaque/session:id", answerSdp: "answer SDP", sidebandReady: true });
    expect(JSON.stringify(connection)).not.toContain(credentials);
    await connection.ready;
    expect(f.socket.sent).toEqual([]);
    finalized(f.socket);
  });

  it("preserves transcript/delegation correlation and discards reflected audio", async () => {
    const f = fixture();
    await createOpenAiLiveConnection(f.options, f.dependencies);
    const transcript = { type: "session.input_transcript.delta", event_id: "one", delta: "Move this", start_ms: 10, end_ms: 40 };
    const delegation = { type: "session.delegation.created", event_id: "two", offset_ms: 45, delegation: { id: "item_opaque", type: "delegation", target: "client" } };
    f.socket.receive(transcript);
    f.socket.receive(delegation);
    f.socket.receive({ type: "session.input_audio.append", audio: "raw audio" });
    f.socket.receive({ type: "session.output_audio.delta", delta: "raw audio" });
    expect(f.onEvent.mock.calls).toEqual([[transcript], [delegation]]);
    finalized(f.socket);
  });

  it("sends exact context commands with required nullable delegation and a conservative UTF-8 limit", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    connection.sendQuiet("context_1", null, "The operator selected node A.");
    connection.sendCommentary("result_1", "item_opaque", "The task was created.");
    expect(f.socket.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "session.thinking.append", event_id: "context_1", delegation_id: null, content: "The operator selected node A." },
      { type: "session.commentary.append", event_id: "result_1", delegation_id: "item_opaque", content: "The task was created." },
    ]);
    expect(() => connection.sendQuiet("large", null, "x".repeat(LIVE_MAX_CONTEXT_BYTES + 1))).toThrow("invalid-context");
    expect(() => connection.sendQuiet("unicode", null, "é".repeat(251))).toThrow("invalid-context");
    expect(() => connection.sendQuiet("empty", "", "context")).toThrow("invalid-context");
    expect(f.socket.sent).toHaveLength(2);
    finalized(f.socket);
  });

  it("keeps the sideband alive for final usage and makes close idempotent", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    const first = connection.close();
    const second = connection.close();
    expect(first).toBe(second);
    expect(f.socket.terminated).toBe(false);
    expect(f.socket.sent.map((item) => JSON.parse(item))).toEqual([{ type: "session.close" }]);
    expect(() => connection.sendQuiet("late", null, "late context")).toThrow("not-open");
    finalized(f.socket);
    await expect(first).resolves.toEqual({ finalized: true, reason: "close_requested", usageSeconds: 23.5 });
    expect(f.socket.terminated).toBe(true);
    expect(f.onClosed).toHaveBeenCalledTimes(1);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("releases a timed-out call and marks final usage unconfirmed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    const result = connection.close();
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({ finalized: false, reason: "close-timeout" });
    expect(f.socket.terminated).toBe(true);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/hangup"))).toHaveLength(1);
  });

  it("ends provider media after sideband loss without retrying or replaying a request", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    f.socket.close();
    await expect(connection.close()).resolves.toEqual({ finalized: false, reason: "connection-lost" });
    expect(f.createSocket).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/hangup"))).toHaveLength(1);
    expect(f.socket.sent).toEqual([]);
  });

  it("sanitizes HTTP, WebSocket, and command errors without credential-bearing causes", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(credentials, { status: 401 }));
    const error = await createOpenAiLiveConnection(f.options, f.dependencies).catch((reason: unknown) => reason);
    expect(String(error)).toContain("startup-failed");
    expect(String(error)).not.toContain(credentials);
    expect(error).not.toHaveProperty("cause");
    expect(f.createSocket).not.toHaveBeenCalled();
    const g = fixture();
    await createOpenAiLiveConnection(g.options, g.dependencies);
    g.socket.receive({ type: "error", error: { message: credentials, code: credentials } });
    expect(JSON.stringify(g.onEvent.mock.calls)).not.toContain(credentials);
    g.socket.emit("error", new Error(credentials));
    expect(JSON.stringify(g.onClosed.mock.calls)).not.toContain(credentials);
  });

  it("hangs up an allocated session whose SDP response is malformed", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ session: answer.session, transport: { type: "webrtc" } }, { status: 201 }));
    await expect(createOpenAiLiveConnection(f.options, f.dependencies)).rejects.toThrow("startup-failed");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.createSocket).not.toHaveBeenCalled();
  });

  it("bounds startup, closes an unready sideband, and never retries session creation", async () => {
    vi.useFakeTimers();
    const f = fixture({}, false);
    const creation = createOpenAiLiveConnection(f.options, f.dependencies);
    const rejected = expect(creation).rejects.toThrow("startup-timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.socket.terminated).toBe(true);
    expect(f.createSocket).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/sessions"))).toHaveLength(1);
  });

  it("releases an aborted call but does not manufacture worker cancellation", async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    controller.abort();
    expect(f.socket.sent.map((item) => JSON.parse(item))).toEqual([{ type: "session.close" }]);
    finalized(f.socket);
    await expect(connection.close()).resolves.toMatchObject({ finalized: true });
    const g = fixture({ signal: controller.signal });
    await expect(createOpenAiLiveConnection(g.options, g.dependencies)).rejects.toThrow("aborted");
    expect(g.fetcher).not.toHaveBeenCalled();
  });

  it("refuses oversized provider frames before forwarding them to the owner", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    f.socket.emit("message", Buffer.alloc(LIVE_MAX_EVENT_BYTES + 1));
    await expect(connection.close()).resolves.toEqual({ finalized: false, reason: "invalid-provider-event" });
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.socket.terminated).toBe(true);
  });

  it("does not accept another session's terminal event as finalization", async () => {
    const f = fixture();
    const connection = await createOpenAiLiveConnection(f.options, f.dependencies);
    f.socket.receive({ type: "session.closed", session: { id: "another-call" }, reason: "close_requested", usage: { seconds: 10 } });
    await expect(connection.close()).resolves.toEqual({ finalized: false, reason: "invalid-provider-event" });
    expect(f.onEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid local inputs before allocating a billed session", async () => {
    const f = fixture({ apiKey: "invalid\nheader" });
    await expect(createOpenAiLiveConnection(f.options, f.dependencies)).rejects.toThrow("invalid-input");
    expect(f.fetcher).not.toHaveBeenCalled();
    const g = fixture({ offer: "x".repeat(64 * 1024 + 1) });
    await expect(createOpenAiLiveConnection(g.options, g.dependencies)).rejects.toThrow("invalid-input");
    expect(g.fetcher).not.toHaveBeenCalled();
  });
});
