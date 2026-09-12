import WebSocket from "ws";

// Provider contract, checked 2026-09-12:
// https://developers.openai.com/api/docs/guides/voice-webrtc
// https://developers.openai.com/api/docs/guides/voice-server-controls
// https://developers.openai.com/api/docs/guides/live-conversations
// This is the external transport adapter. The owning Effect scope controls its
// AbortSignal and finalizer; this module never admits or executes application work.
const LIVE_URL = "https://api.openai.com/v1/live/sessions";
export const LIVE_MAX_EVENT_BYTES = 256 * 1024;
export const LIVE_MAX_CONTEXT_BYTES = 500;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;

export type OpenAiLiveEvent = Readonly<Record<string, unknown>> & { readonly type: string };

export interface OpenAiLiveClosed {
  readonly finalized: boolean;
  readonly reason: string;
  readonly usageSeconds?: number;
}

export interface OpenAiLiveSocket {
  readonly readyState: number;
  on(event: string, listener: (data?: unknown) => void): unknown;
  off(event: string, listener: (data?: unknown) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export interface OpenAiLiveConnectionOptions {
  readonly apiKey: string;
  readonly offer: string;
  readonly instructions: string;
  readonly voice?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: OpenAiLiveEvent) => void;
  readonly onClosed: (outcome: OpenAiLiveClosed) => void;
}

export interface OpenAiLiveTransportDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly createSocket?: (url: string, options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly handshakeTimeout: number;
    readonly maxPayload: number;
  }) => OpenAiLiveSocket;
  readonly startupTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface OpenAiLiveConnection {
  readonly sessionId: string;
  readonly answerSdp: string;
  readonly sidebandReady: true;
  /** Authenticated sideband open only. Renderer session.started is a separate gate. */
  readonly ready: Promise<void>;
  readonly sendQuiet: (eventId: string, delegationId: string | null, content: string) => void;
  readonly sendCommentary: (eventId: string, delegationId: string | null, content: string) => void;
  readonly close: () => Promise<OpenAiLiveClosed>;
}

export class OpenAiLiveConnectionError extends Error {
  constructor(readonly code: "invalid-input" | "startup-failed" | "startup-timeout" | "aborted" | "not-open" | "invalid-context") {
    // Never forward HTTP bodies, WebSocket errors, or credential-bearing causes.
    super(`Vellum Command live connection: ${code}.`);
    this.name = "OpenAiLiveConnectionError";
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max;

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new OpenAiLiveConnectionError("startup-failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > LIVE_MAX_EVENT_BYTES) throw new OpenAiLiveConnectionError("startup-failed");
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function eventText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= LIVE_MAX_EVENT_BYTES ? value : undefined;
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength <= LIVE_MAX_EVENT_BYTES ? value.toString("utf8") : undefined;
  }
  return undefined;
}

/**
 * Creates exactly one provider session and attaches main's authenticated sideband.
 * Attachment does not replay session.started or older events. The renderer must
 * preserve its startup events and independently report data-channel readiness to
 * the owner before microphone input, context updates, or delegations are admitted.
 */
export async function createOpenAiLiveConnection(
  options: OpenAiLiveConnectionOptions,
  dependencies: OpenAiLiveTransportDependencies = {},
): Promise<OpenAiLiveConnection> {
  if (!boundedString(options.apiKey, 4096) || /[\r\n]/.test(options.apiKey) ||
      !boundedString(options.offer, MAX_SDP_BYTES) ||
      !boundedString(options.instructions, MAX_INSTRUCTIONS_BYTES) ||
      (options.voice !== undefined && !boundedString(options.voice, 128))) {
    throw new OpenAiLiveConnectionError("invalid-input");
  }
  if (options.signal?.aborted) throw new OpenAiLiveConnectionError("aborted");
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 20_000;
  const closeTimeoutMs = dependencies.closeTimeoutMs ?? 15_000;
  const startup = new AbortController();
  let startupError: OpenAiLiveConnectionError | undefined;
  let sessionId: string | undefined;
  let socket: OpenAiLiveSocket | undefined;
  let closed: OpenAiLiveClosed | undefined;
  let hangupRequested = false;
  let closing = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: (outcome: OpenAiLiveClosed) => void;
  const closedPromise = new Promise<OpenAiLiveClosed>((resolve) => { resolveClosed = resolve; });
  const abortStartup = (code: "aborted" | "startup-timeout") => {
    startupError ??= new OpenAiLiveConnectionError(code);
    startup.abort();
  };
  const startupTimer = setTimeout(() => abortStartup("startup-timeout"), startupTimeoutMs);
  const abortDuringStartup = () => abortStartup("aborted");
  options.signal?.addEventListener("abort", abortDuringStartup, { once: true });

  // Also bounds injected transports that fail to honor fetch's AbortSignal.
  async function duringStartup<T>(work: Promise<T>): Promise<T> {
    if (startup.signal.aborted) throw startupError;
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(startupError);
      startup.signal.addEventListener("abort", listener, { once: true });
    });
    try { return await Promise.race([work, aborted]); }
    finally { if (listener) startup.signal.removeEventListener("abort", listener); }
  }

  const hangup = async () => {
    if (!sessionId || hangupRequested) return;
    hangupRequested = true;
    const stop = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timeout = setTimeout(() => { stop.abort(); resolve(); }, Math.min(closeTimeoutMs, 5000));
    });
    try {
      await Promise.race([expired, (async () => {
        const response = await fetcher(`${LIVE_URL}/${encodeURIComponent(sessionId)}/hangup`, {
          method: "POST", headers: { Authorization: `Bearer ${options.apiKey}` },
          signal: stop.signal, redirect: "error",
        });
        await response.body?.cancel().catch(() => undefined);
      })()]);
    } catch { /* Unknown finalization remains explicit in the close outcome. */ }
    finally { clearTimeout(timeout); }
  };
  const finish = (outcome: OpenAiLiveClosed) => {
    if (closed) return;
    closed = outcome;
    closing = true;
    clearTimeout(closeTimer);
    options.signal?.removeEventListener("abort", abortAfterStartup);
    resolveClosed(outcome);
    try { options.onClosed(outcome); } catch { /* Observer failure cannot retain audio resources. */ }
    try { socket?.terminate(); } catch { /* Already closed. */ }
  };
  const close = (): Promise<OpenAiLiveClosed> => {
    if (closed || closing) return closedPromise;
    closing = true;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      void hangup();
      finish({ finalized: false, reason: "connection-lost" });
      return closedPromise;
    }
    closeTimer = setTimeout(() => {
      void hangup();
      finish({ finalized: false, reason: "close-timeout" });
    }, closeTimeoutMs);
    try { socket.send(JSON.stringify({ type: "session.close" })); }
    catch {
      void hangup();
      finish({ finalized: false, reason: "connection-lost" });
    }
    return closedPromise;
  };
  const abortAfterStartup = () => { void close(); };
  const onMessage = (data?: unknown) => {
    if (closed) return;
    const raw = eventText(data);
    let event: unknown;
    try { if (raw !== undefined) event = JSON.parse(raw); } catch { /* Reject malformed provider frames below. */ }
    if (!record(event) || typeof event.type !== "string") {
      void hangup();
      finish({ finalized: false, reason: "invalid-provider-event" });
      return;
    }
    // Sideband reflects audio even while model input is muted. Never retain or
    // forward these frames: microphone transmission is controlled in the renderer.
    if (event.type === "session.input_audio.append" || event.type === "session.output_audio.delta") return;
    let closeOutcome: OpenAiLiveClosed | undefined;
    if (event.type === "session.closed") {
      const seconds = record(event.usage) ? event.usage.seconds : undefined;
      if (!record(event.session) || event.session.id !== sessionId ||
          typeof event.reason !== "string" || !["close_requested", "expired", "content", "remote_hangup", "connection_lost"].includes(event.reason) ||
          typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        void hangup();
        finish({ finalized: false, reason: "invalid-provider-event" });
        return;
      }
      closeOutcome = { finalized: true, reason: event.reason, usageSeconds: seconds };
    }
    const safeEvent: OpenAiLiveEvent = event.type === "error"
      ? { type: "error", error: { message: "The live provider rejected a session command." } }
      : { ...event, type: event.type };
    try { options.onEvent(safeEvent); }
    catch {
      void close();
      return;
    }
    if (closeOutcome) finish(closeOutcome);
  };

  try {
    const response = await duringStartup(fetcher(LIVE_URL, {
      method: "POST", redirect: "error", signal: startup.signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1", delegation: { type: "client" },
          instructions: options.instructions, store: false,
          ...(options.voice ? { audio: { output: { voice: options.voice } } } : {}),
        },
        transport: { type: "webrtc", sdp: options.offer },
      }),
    }));
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAiLiveConnectionError("startup-failed");
    }
    const result = await duringStartup(boundedJson(response));
    if (!record(result) || !record(result.session) || !boundedString(result.session.id, 512)) {
      throw new OpenAiLiveConnectionError("startup-failed");
    }
    sessionId = result.session.id;
    if (!record(result.transport) || result.transport.type !== "webrtc" || !boundedString(result.transport.sdp, MAX_SDP_BYTES)) {
      throw new OpenAiLiveConnectionError("startup-failed");
    }
    const answerSdp = result.transport.sdp;
    const createSocket = dependencies.createSocket ?? ((url, settings) => new WebSocket(url, {
      ...settings, followRedirects: false,
    }));
    socket = createSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      handshakeTimeout: startupTimeoutMs, maxPayload: LIVE_MAX_EVENT_BYTES,
    });
    socket.on("message", onMessage);
    const connectionSocket = socket;
    const opened = new Promise<void>((resolve, reject) => {
      const onOpen = () => { detach(); resolve(); };
      const onError = () => { detach(); reject(new OpenAiLiveConnectionError("startup-failed")); };
      const detach = () => {
        connectionSocket.off("open", onOpen);
        connectionSocket.off("error", onError);
        connectionSocket.off("close", onError);
      };
      connectionSocket.on("open", onOpen);
      connectionSocket.on("error", onError);
      connectionSocket.on("close", onError);
    });
    // Keep an error receiver throughout shutdown: ws can emit error after a
    // connecting socket is terminated, and EventEmitter must never throw it.
    const lost = () => {
      if (closed || startup.signal.aborted) return;
      void hangup();
      finish({ finalized: false, reason: "connection-lost" });
    };
    socket.on("error", lost);
    socket.on("close", lost);
    await duringStartup(opened);
    if (closed) throw new OpenAiLiveConnectionError("startup-failed");
    if (options.signal?.aborted) throw new OpenAiLiveConnectionError("aborted");
    options.signal?.removeEventListener("abort", abortDuringStartup);
    options.signal?.addEventListener("abort", abortAfterStartup, { once: true });
    const send = (type: string, eventId: string, delegationId: string | null, content: string) => {
      // UTF-8 byte count upper-bounds byte-token vocabulary token counts; never
      // silently trim a result or send more than the provider's 500-token limit.
      if (!boundedString(content, LIVE_MAX_CONTEXT_BYTES) || !boundedString(eventId, 512) ||
          (delegationId !== null && !boundedString(delegationId, 512))) {
        throw new OpenAiLiveConnectionError("invalid-context");
      }
      if (closing || closed || connectionSocket.readyState !== WebSocket.OPEN) {
        throw new OpenAiLiveConnectionError("not-open");
      }
      try { connectionSocket.send(JSON.stringify({ type, event_id: eventId, delegation_id: delegationId, content })); }
      catch { throw new OpenAiLiveConnectionError("not-open"); }
    };
    return {
      sessionId, answerSdp, sidebandReady: true, ready: Promise.resolve(), close,
      sendQuiet: (eventId, delegationId, content) => send("session.thinking.append", eventId, delegationId, content),
      sendCommentary: (eventId, delegationId, content) => send("session.commentary.append", eventId, delegationId, content),
    };
  } catch (error) {
    startup.abort();
    try { socket?.terminate(); } catch { /* No live socket remains. */ }
    await hangup();
    throw error instanceof OpenAiLiveConnectionError ? error : startupError ?? new OpenAiLiveConnectionError("startup-failed");
  } finally {
    clearTimeout(startupTimer);
    options.signal?.removeEventListener("abort", abortDuringStartup);
  }
}
