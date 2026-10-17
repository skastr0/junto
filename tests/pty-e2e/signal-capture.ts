#!/usr/bin/env node
/**
 * signal-capture.ts — limit, retry, error and compaction screens from the real
 * harness binaries, recorded into the PTY E2E corpus.
 *
 * Each harness TUI runs in the same isolated node-pty session pty-capture.ts
 * uses (120x32, isolated HOME), but its model provider points at a scripted
 * local stub. The binary renders its own screens; only the provider replies
 * are scripted, so no real quota is spent and no real account is touched.
 * Fixtures land beside the core scenarios:
 *
 *   tests/pty-e2e/corpus/<harness>/<scenario>.jsonl   {"t":ms,"b64":...}
 *   tests/pty-e2e/corpus/<harness>/manifest.json      row merged per scenario
 *   tests/pty-e2e/corpus/index.json                   row merged per scenario
 *
 * Every row carries `observed.source: "stub-provider"`, the replies the stub
 * served, and `observed.renderedLines`: every screen line that appeared after
 * the prompt was submitted, in order of first appearance. Those lines are the
 * exact strings the screen rule packs match.
 *
 * Run with node (node-pty never wakes under bun, see pty-capture.ts):
 *
 *   node --import jiti/register tests/pty-e2e/signal-capture.ts list
 *   node --import jiti/register tests/pty-e2e/signal-capture.ts probe <harness> <scenario>
 *   node --import jiti/register tests/pty-e2e/signal-capture.ts capture <harness> [scenario...]
 *
 * `probe` prints the rendered lines and the final screen and writes nothing.
 */

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  HARNESSES,
  Session,
  certifyHarness,
  earnSanitizedStamp,
  probeHarnessVersion,
  scrub,
  type HarnessDef,
  type ScenarioResult,
} from "./pty-capture";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, "corpus");
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as typeof import("@xterm/headless");
const COLS = 120;
const ROWS = 32;
const READY_CAP_MS = 45_000;
const SETTLE_CAP_MS = 75_000;
const SETTLE_QUIET_MS = 3_000;

// ── stub provider ───────────────────────────────────────────────────────────

/**
 * `gemini` is the Gemini API (agy's API-key mode). `devin` and `cursor` are
 * the vendors' own Connect RPC backends: the stub cannot encode a successful
 * answer for them, only errors, limits and dropped connections.
 */
type Protocol = "anthropic" | "openai-responses" | "openai-chat" | "gemini" | "devin" | "cursor";

type Reply =
  /** `inputTokens` is the context size the reply reports; large values trigger auto-compaction. */
  | { readonly kind: "ok"; readonly text: string; readonly delayMs?: number; readonly inputTokens?: number }
  | { readonly kind: "error"; readonly status: number; readonly body: unknown; readonly headers?: Record<string, string>; readonly delayMs?: number }
  /** Destroy the socket before any response: a network failure. */
  | { readonly kind: "drop"; readonly delayMs?: number }
  /** HTTP 200 whose Connect end-of-stream frame carries an error (devin, cursor). */
  | { readonly kind: "connect-error"; readonly code: string; readonly message: string; readonly details?: readonly unknown[]; readonly delayMs?: number };

/** Failures held back this long so a retry state stays on screen between attempts. */
const RETRY_HOLD_MS = 1_500;
const held = (reply: Reply): Reply => ({ ...reply, delayMs: RETRY_HOLD_MS });

type Served = { readonly path: string; readonly reply: string };

type OkReply = Extract<Reply, { kind: "ok" }>;

const OK: OkReply = { kind: "ok", text: "Hello from the capture stub." };
/** About 25k tokens of answer, so a two-turn session is worth compacting. */
const BULKY: OkReply = {
  kind: "ok",
  inputTokens: 30_000,
  text: Array.from({ length: 1_600 }, (_, i) => `Line ${i + 1} of a long capture answer, padding the conversation.`).join("\n"),
};
/** Held back so the compaction spinner stays on screen long enough to sample. */
const SUMMARY: OkReply = { kind: "ok", text: "Summary: the user greeted the assistant and the assistant replied.", delayMs: 4_000 };
const DEBUG = process.env.CAPTURE_STUB_DEBUG === "1";
/** A fixed port keeps the stub address that harnesses print stable across captures. */
const STUB_PORT = Number(process.env.CAPTURE_STUB_PORT ?? 47_820);

function protocolOf(pathname: string): Protocol | null {
  if (pathname.includes(":streamGenerateContent") || pathname.includes(":generateContent")) return "gemini";
  if (pathname.endsWith("/GetChatMessage")) return "devin";
  if (pathname === "/agent.v1.AgentService/Run") return "cursor";
  if (pathname.endsWith("/messages")) return "anthropic";
  if (pathname.endsWith("/responses")) return "openai-responses";
  if (pathname.endsWith("/chat/completions")) return "openai-chat";
  return null;
}

function sseLine(event: string | null, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

const sse = sseLine;

function okStream(protocol: Protocol, text: string, n: number, inputTokens = 12): string {
  if (protocol === "gemini") return sse(null, okJson(protocol, text, n, inputTokens));
  if (protocol === "anthropic") {
    return [
      sse("message_start", { type: "message_start", message: { id: `msg_stub${n}`, type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
  }
  if (protocol === "openai-responses") {
    let seq = 0;
    const sse = (event: string, data: Record<string, unknown>) => sseLine(event, { ...data, sequence_number: seq++ });
    const id = `resp_stub${n}`;
    const item = { id: `msg_stub${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + 8 };
    return [
      sse("response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } }),
      sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
      sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }),
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
      sse("response.completed", { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage } }),
    ].join("");
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sse(null, { id: `chatcmpl-stub${n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] });
  return [
    chunk({ role: "assistant", content: "" }, null),
    chunk({ content: text }, null),
    chunk({}, "stop"),
    sse(null, { id: `chatcmpl-stub${n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 8, total_tokens: inputTokens + 8 } }),
    sse(null, "[DONE]"),
  ].join("");
}

function okJson(protocol: Protocol, text: string, n: number, inputTokens = 12): unknown {
  if (protocol === "gemini") {
    return {
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: inputTokens, candidatesTokenCount: 8, totalTokenCount: inputTokens + 8 },
      modelVersion: "stub",
    };
  }
  if (protocol === "anthropic") {
    return { id: `msg_stub${n}`, type: "message", role: "assistant", model: "stub", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } };
  }
  if (protocol === "openai-responses") {
    return { id: `resp_stub${n}`, object: "response", status: "completed", output: [{ id: `msg_stub${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
  }
  return { id: `chatcmpl-stub${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
}

/** A Connect streaming frame: flags, big-endian length, payload. Flag 2 ends the stream. */
function connectFrame(flags: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const endOfStream = (error?: Record<string, unknown>): Buffer =>
  connectFrame(2, Buffer.from(JSON.stringify(error ? { error } : {})));

// Minimal protobuf encoding for the few cursor messages the stub must send.
function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function pb(...fields: ReadonlyArray<readonly [number, number | boolean | string | Buffer]>): Buffer {
  return Buffer.concat(fields.map(([no, value]) => {
    if (typeof value === "number" || typeof value === "boolean") return Buffer.concat([varint(no << 3), varint(Number(value))]);
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    return Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes]);
  }));
}

/** agent.v1.ModelDetails: model_id, display_model_id, display_name, display_name_short. */
const CURSOR_MODEL = pb([1, "stub-model"], [3, "stub-model"], [4, "Stub Model"], [5, "Stub"]);

/**
 * aiserver.v1.ErrorDetails { error: PRO_USER_USAGE_LIMIT (10), details { title, detail }, is_expected }.
 * Cursor renders the title and detail the server sends; these words are the stub's.
 */
function cursorErrorDetails(title: string, detail: string): unknown {
  const value = pb([1, 10], [2, pb([1, title], [2, detail], [4, false])], [3, true]).toString("base64").replace(/=+$/u, "");
  return { type: "aiserver.v1.ErrorDetails", value };
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An unsigned token cursor accepts as a session; it is never checked. */
const CURSOR_TOKEN = `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ sub: "capture-stub", exp: Math.floor(Date.now() / 1000) + 5 * 365 * 86_400 })}.`;

type SideReply = { readonly status: number; readonly type: string; readonly body: string | Buffer };

/** Everything a harness asks the stub for besides the model call. */
function sideRoute(method: string, pathname: string, contentType: string): SideReply {
  const json = (value: unknown): SideReply => ({ status: 200, type: "application/json", body: JSON.stringify(value) });
  if (pathname === "/muse-code/models") return json(MUSE_CATALOG);
  if (pathname === "/auth/exchange_user_api_key") return json({ accessToken: CURSOR_TOKEN, refreshToken: CURSOR_TOKEN });
  if (pathname.endsWith("/GetUsableModels") || pathname.endsWith("/GetDefaultModelForCli")) {
    return { status: 200, type: "application/proto", body: pb([1, CURSOR_MODEL]) };
  }
  if (pathname.endsWith("/AvailableModels")) return { status: 200, type: "application/proto", body: pb([1, "stub-model"]) };
  if (contentType.startsWith("application/connect+")) return { status: 200, type: contentType, body: endOfStream() };
  if (contentType.startsWith("application/proto") || pathname.includes("Service/")) return { status: 200, type: "application/proto", body: "" };
  if (method === "GET" && /\/models\/?$/u.test(pathname)) {
    return json({ object: "list", data: [], models: [{ name: "models/stub-model", displayName: "stub", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }] });
  }
  return json({ object: "list", data: [] });
}

/**
 * A scripted provider. Model requests consume `replies` in order and the last
 * reply repeats; anything else (model lists, health probes) gets an empty 200.
 */
class StubProvider {
  private server: net.Server | null = null;
  private readonly http1 = http.createServer((req, res) => this.collect(req, res));
  private readonly http2 = http2.createServer();
  private replies: readonly Reply[] = [OK];
  private cursor = 0;
  private lastGeminiStream = false;
  readonly served: Served[] = [];

  private collect(req: http.IncomingMessage | http2.Http2ServerRequest, res: http.ServerResponse | http2.Http2ServerResponse): void {
    const chunks: Buffer[] = [];
    let handled = false;
    // The HTTP/2 compatibility response has the same writeHead/end surface.
    const handle = () => {
      if (handled) return;
      handled = true;
      this.handle(req, res as http.ServerResponse, Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", handle);
    // A bidirectional HTTP/2 stream (cursor's agent call) never ends its
    // request body: answer once its opening frames have arrived.
    if ("stream" in req) setTimeout(handle, 300);
  }

  async start(): Promise<string> {
    this.http2.on("request", (req, res) => this.collect(req, res));
    this.http2.on("sessionError", (err) => { if (DEBUG) console.error(`[stub] h2 session error: ${err.message}`); });
    this.http2.on("stream", (_stream, headers) => { if (DEBUG) console.error(`[stub] h2 stream ${headers[":method"]} ${headers[":path"]}`); });
    // Closed harnesses run with HTTPS_PROXY pointed here: refuse every tunnel,
    // so nothing they send leaves the machine.
    this.http1.on("connect", (req, socket: net.Socket, head: Buffer) => {
      // A tunnel to the stub itself is allowed: cursor proxies even loopback.
      if (req.url !== `127.0.0.1:${STUB_PORT}` && req.url !== `localhost:${STUB_PORT}`) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      const self = net.connect(STUB_PORT, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) self.write(head);
        socket.pipe(self).pipe(socket);
      });
      self.on("error", () => socket.destroy());
      socket.on("error", () => self.destroy());
    });
    // One port for both: cursor opens its agent stream as cleartext HTTP/2.
    // The HTTP/2 server reads the native socket handle and never sees bytes
    // put back with unshift(), so HTTP/2 is piped to its own loopback listener.
    await new Promise<void>((resolve) => this.http2.listen(0, "127.0.0.1", resolve));
    const h2Port = (this.http2.address() as net.AddressInfo).port;
    this.server = net.createServer((socket) => {
      socket.on("error", () => { /* dropped by a scenario or the harness */ });
      socket.once("data", (first: Buffer) => {
        const h2 = first.subarray(0, 14).toString("latin1") === "PRI * HTTP/2.0";
        if (DEBUG) console.error(`[stub] connection ${h2 ? "h2" : "http/1"}: ${JSON.stringify(first.subarray(0, 40).toString("latin1"))}`);
        if (!h2) {
          socket.pause();
          socket.unshift(first);
          this.http1.emit("connection", socket);
          socket.resume();
          return;
        }
        const upstream = net.connect(h2Port, "127.0.0.1", () => {
          upstream.write(first);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(STUB_PORT, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  script(replies: readonly Reply[]): void {
    this.replies = replies;
    this.cursor = 0;
    this.served.length = 0;
  }

  stop(): Promise<void> {
    this.http1.closeAllConnections();
    this.http2.close();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(req: http.IncomingMessage | http2.Http2ServerRequest, res: http.ServerResponse, body: string): void {
    const pathname = new URL(req.url ?? "/", "http://stub").pathname;
    const protocol = req.method === "POST" ? protocolOf(pathname) : null;
    const contentType = String(req.headers["content-type"] ?? "");
    // Muse sends reminder side calls each turn; they never consume the script.
    const role = req.headers["x-tbh-agent-role"];
    if (protocol && typeof role === "string" && role !== "main") {
      this.respondOk(res, body, protocol, OK, 0);
      return;
    }
    if (!protocol) {
      const side = sideRoute(req.method ?? "GET", pathname, contentType);
      res.writeHead(side.status, { "content-type": side.type });
      res.end(side.body);
      return;
    }
    this.lastGeminiStream = pathname.includes(":streamGenerateContent");
    const reply = this.replies[Math.min(this.cursor, this.replies.length - 1)];
    this.cursor += 1;
    const n = this.cursor;
    this.served.push({ path: pathname, reply: reply.kind === "error" ? String(reply.status) : reply.kind === "connect-error" ? reply.code : reply.kind });
    const respond = () => {
      if (reply.kind === "drop") {
        if ("stream" in req) req.stream.session?.destroy();
        else req.socket.destroy();
      } else if (reply.kind === "connect-error") {
        res.writeHead(200, { "content-type": contentType || "application/connect+proto" });
        res.end(endOfStream({ code: reply.code, message: reply.message, ...(reply.details ? { details: reply.details } : {}) }));
      } else if (reply.kind === "error") {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      } else this.respondOk(res, body, protocol, reply, n);
    };
    if (reply.delayMs) setTimeout(respond, reply.delayMs);
    else respond();
  }

  private respondOk(res: http.ServerResponse, body: string, protocol: Protocol, reply: OkReply, n: number): void {
    const text = reply.text;
    if (protocol === "devin" || protocol === "cursor") {
      // No protobuf answer is encoded: an empty, successful stream.
      res.writeHead(200, { "content-type": "application/connect+proto" });
      res.end(endOfStream());
      return;
    }
    let streaming = false;
    try { streaming = (JSON.parse(body) as { stream?: unknown }).stream === true; } catch { /* not JSON */ }
    if (protocol === "gemini") streaming = this.lastGeminiStream;
    if (!streaming) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(okJson(protocol, text, n)));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(okStream(protocol, text, n, reply.inputTokens));
  }
}

/** Muse refuses to start without a visible model in its catalog. */
const MUSE_CATALOG = {
  object: "list",
  data: [{
    id: "stub-model", object: "model", created: 0, owned_by: "meta",
    metadata: { "muse-code": {
      family: "stub", release_date: "2026-01-01", is_hidden: false, attachment: false, reasoning: false, tool_call: true,
      modalities: { input: ["text"], output: ["text"] }, limit: { context: 200_000, output: 8_192 }, description: "Stub model",
    } },
  }],
};

// ── scenarios ───────────────────────────────────────────────────────────────

type Scenario = {
  readonly name: string;
  /** The domain signal the screen should carry (src/shared/harness-domain). */
  readonly signal: string;
  /** OpenAI and Anthropic replies; vendor protocols read VENDOR. Null: does not apply. */
  readonly replies: (protocol: Protocol) => readonly Reply[] | null;
  /** Typed into the composer in order; each waits for the previous to settle. */
  readonly prompts: readonly string[];
  /** Extra env for one harness in this scenario, over its wiring. */
  readonly env?: Readonly<Record<string, Record<string, string>>>;
  /** The screen must show this, or the scenario is a skip and writes no fixture. */
  readonly expect?: RegExp;
  /** The screen must not show this: the scenario failed to happen (e.g. a refused compaction). */
  readonly reject?: RegExp;
  /** Extra argv for one harness in this scenario, after its wiring. */
  readonly args?: Readonly<Record<string, readonly string[]>>;
};

function errorBody(protocol: Protocol, type: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return protocol === "anthropic"
    ? { type: "error", error: { type, message } }
    : { error: { type, message, code: type, ...extra } };
}

const RESET_SECONDS = 3 * 3600 + 17 * 60;

/** A hard plan limit: Anthropic unified rate-limit headers, OpenAI usage_limit_reached. */
function usageLimit(name: string, scope: string, claim: string, window: string, codexWindow: string): Scenario {
  return {
    name,
    signal: `UsageLimitHit { scope: ${scope}, resetsAt }`,
    prompts: ["say hi"],
    replies: (p) => {
      const resetAt = Math.floor(Date.now() / 1000) + (scope === "weekly" ? 4 * 86_400 + RESET_SECONDS : RESET_SECONDS);
      const reset = String(resetAt);
      if (p === "anthropic") {
        return [{
          kind: "error", status: 429,
          body: errorBody(p, "rate_limit_error", "This request would exceed your account's rate limit. Please try again later."),
          headers: {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": reset,
            "anthropic-ratelimit-unified-representative-claim": claim,
            [`anthropic-ratelimit-unified-${window}-status`]: "rejected",
            [`anthropic-ratelimit-unified-${window}-reset`]: reset,
            [`anthropic-ratelimit-unified-${window}-utilization`]: "1.0",
          },
        }];
      }
      return [{
        kind: "error", status: 429,
        headers: {
          [`x-codex-${codexWindow}-used-percent`]: "100",
          [`x-codex-${codexWindow}-window-minutes`]: scope === "weekly" ? "10080" : "300",
          [`x-codex-${codexWindow}-reset-at`]: reset,
        },
        body: errorBody(p, "usage_limit_reached", "The usage limit has been reached",
          { plan_type: "plus", resets_at: resetAt, resets_in_seconds: resetAt - Math.floor(Date.now() / 1000) }),
      }];
    },
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "retry-overloaded",
    signal: "Retrying { cause: overloaded }, then a completed turn",
    prompts: ["say hi"],
    replies: (p) => {
      const fail: Reply = p === "anthropic"
        ? { kind: "error", status: 529, body: errorBody(p, "overloaded_error", "Overloaded") }
        : { kind: "error", status: 503, body: errorBody(p, "server_error", "The server is overloaded. Please try again later.") };
      return [held(fail), held(fail), held(fail), OK];
    },
  },
  {
    name: "retry-rate",
    signal: "Retrying { cause: rate }, then a completed turn",
    prompts: ["say hi"],
    replies: (p) => {
      const fail: Reply = {
        kind: "error", status: 429, headers: { "retry-after": "2" },
        body: errorBody(p, p === "anthropic" ? "rate_limit_error" : "rate_limit_exceeded",
          "Rate limit reached for requests per minute. Please try again in 2s."),
      };
      return [held(fail), held(fail), held(fail), OK];
    },
  },
  {
    name: "retry-network",
    signal: "Retrying { cause: network }, then a completed turn",
    prompts: ["say hi"],
    replies: () => [held({ kind: "drop" }), held({ kind: "drop" }), held({ kind: "drop" }), OK],
  },
  usageLimit("usage-limit", "5h", "five_hour", "5h", "primary"),
  usageLimit("usage-limit-weekly", "weekly", "seven_day", "7d", "secondary"),
  {
    name: "error-auth",
    signal: "ErrorRaised { kind: auth }",
    prompts: ["say hi"],
    replies: (p) => [{
      kind: "error", status: 401,
      body: errorBody(p, p === "anthropic" ? "authentication_error" : "invalid_api_key",
        p === "anthropic" ? "invalid x-api-key" : "Incorrect API key provided."),
    }],
  },
  {
    name: "error-server",
    signal: "ErrorRaised { kind: provider } after retries run out",
    prompts: ["say hi"],
    replies: (p) => [held({
      kind: "error", status: 500,
      body: errorBody(p, p === "anthropic" ? "api_error" : "server_error", "Internal server error"),
    })],
  },
  {
    name: "error-context",
    signal: "ErrorRaised { kind: contextOverflow }",
    prompts: ["say hi"],
    replies: (p) => [{
      kind: "error", status: 400,
      body: p === "anthropic"
        ? errorBody(p, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum")
        : errorBody(p, "context_length_exceeded",
          "Your input exceeds the context window of this model. Please adjust your input and try again."),
    }],
  },
  {
    name: "compaction-auto",
    signal: "CompactionStarted { trigger: auto }, CompactionEnded { ok }, then a completed turn",
    prompts: ["say hi", "say hi again"],
    expect: /compact/i,
    // The first answer reports a nearly full context window.
    // The first answer reports a nearly full context window, and is bulky so
    // the pi family finds something to compact.
    replies: () => [{ ...BULKY, inputTokens: 190_000 }, SUMMARY, OK],
    args: { codex: ["-c", "model_context_window=200000", "-c", "model_auto_compact_token_limit=150000"] },
    env: { claude: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } },
  },
  {
    name: "compaction-manual",
    signal: "CompactionStarted { trigger: manual }, CompactionEnded { ok }",
    expect: /compact/i,
    // pi and omp refuse to compact a session too small by their own count of
    // the conversation text, so the two answers before /compact are bulky.
    prompts: ["say hi", "say more", "/compact"],
    reject: /compaction failed/i,
    replies: () => [BULKY, BULKY, SUMMARY],
  },
  // Devin's own limit kinds; see VENDOR.devin.
  { name: "usage-limit-monthly", signal: "UsageLimitHit { scope: monthly }", prompts: ["say hi"], replies: () => null },
  { name: "usage-limit-org", signal: "UsageLimitHit { scope: org }", prompts: ["say hi"], replies: () => null },
  { name: "usage-paused", signal: "UsageLimitHit { scope: org }, an admin paused usage", prompts: ["say hi"], replies: () => null },
];

type VendorProtocol = "gemini" | "devin" | "cursor";
const isVendor = (p: Protocol): p is VendorProtocol => p === "gemini" || p === "devin" || p === "cursor";

const geminiError = (status: number, code: string, message: string): Reply =>
  ({ kind: "error", status, body: { error: { code: status, message, status: code } } });
const connectHttp = (status: number, code: string, message: string): Reply =>
  ({ kind: "error", status, body: { code, message }, ...(status === 429 ? { headers: { "retry-after": "2" } } : {}) });
const connectEos = (code: string, message: string, details?: readonly unknown[]): Reply =>
  ({ kind: "connect-error", code, message, details });
const DROP: Reply = { kind: "drop" };

type VendorPlan = { readonly replies: () => readonly Reply[]; readonly signal?: string };

/**
 * What each scenario means on a vendor protocol; a missing entry does not
 * apply. Devin and cursor can never answer, so their retries end in an error.
 * The Connect error codes and messages are the ones each CLI classifies on.
 */
const VENDOR: Readonly<Record<VendorProtocol, Readonly<Record<string, VendorPlan>>>> = {
  gemini: {
    "retry-overloaded": { replies: () => { const f = held(geminiError(503, "UNAVAILABLE", "The model is overloaded. Please try again later.")); return [f, f, f, OK]; } },
    "retry-rate": { replies: () => { const f = held(geminiError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota).")); return [f, f, f, OK]; } },
    "retry-network": { replies: () => [held(DROP), held(DROP), held(DROP), OK] },
    "usage-limit": {
      signal: "UsageLimitHit { scope: unknown }, the Gemini API key quota",
      replies: () => [geminiError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.")],
    },
    "error-auth": { replies: () => [geminiError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")] },
    "error-server": { replies: () => [held(geminiError(500, "INTERNAL", "An internal error has occurred."))] },
    "error-context": { replies: () => [geminiError(400, "INVALID_ARGUMENT", "The input token count (250000) exceeds the maximum number of tokens allowed (200000).")] },
    "compaction-auto": { replies: () => [{ ...BULKY, inputTokens: 190_000 }, SUMMARY, OK] },
    "compaction-manual": { replies: () => [BULKY, BULKY, SUMMARY] },
  },
  devin: {
    "retry-overloaded": { signal: "Retrying { cause: overloaded }, never recovering", replies: () => [held(connectHttp(503, "unavailable", "service unavailable"))] },
    "retry-rate": { signal: "Retrying { cause: rate }, then ErrorRaised", replies: () => [held(connectEos("resource_exhausted", "You have reached your rate limit. Please try again later."))] },
    "retry-network": { signal: "Retrying { cause: network }, never recovering", replies: () => [held(DROP)] },
    "usage-limit-monthly": { replies: () => [connectEos("resource_exhausted", "monthly acu limit reached")] },
    "usage-limit-org": { replies: () => [connectEos("permission_denied", "organization usage limit reached")] },
    "usage-paused": { replies: () => [connectEos("permission_denied", "usage frozen by an administrator")] },
    "error-auth": { replies: () => [connectEos("unauthenticated", "invalid api key")] },
    "error-server": { replies: () => [held(connectEos("internal", "internal error"))] },
  },
  cursor: {
    "retry-overloaded": { signal: "Retrying { cause: overloaded }, then ErrorRaised { kind: provider }", replies: () => [held(connectHttp(503, "unavailable", "service unavailable"))] },
    "retry-rate": { signal: "Retrying { cause: rate }, then ErrorRaised { kind: provider }", replies: () => [held(connectHttp(429, "resource_exhausted", "rate limited"))] },
    "retry-network": { signal: "Retrying { cause: network }, never recovering within the capture", replies: () => [held(DROP)] },
    "usage-limit": {
      signal: "UsageLimitHit { scope: unknown }; Cursor renders the server's title and detail, here the stub's words",
      replies: () => [connectEos("resource_exhausted", "usage limit", [cursorErrorDetails("Usage limit reached", "You've hit your usage limit.")])],
    },
    "error-auth": { replies: () => [connectHttp(401, "unauthenticated", "invalid api key")] },
    "error-server": { replies: () => [held(connectHttp(500, "internal", "internal error"))] },
  },
};

/** The replies and signal a scenario has on one protocol, or null where it does not apply. */
function planFor(scenario: Scenario, protocol: Protocol): { readonly replies: readonly Reply[]; readonly signal: string } | null {
  if (isVendor(protocol)) {
    const vendor = VENDOR[protocol][scenario.name];
    return vendor ? { replies: vendor.replies(), signal: vendor.signal ?? scenario.signal } : null;
  }
  const replies = scenario.replies(protocol);
  return replies ? { replies, signal: scenario.signal } : null;
}

// ── provider wiring per harness ─────────────────────────────────────────────

type Wiring = {
  readonly protocol: Protocol;
  /** Derive a HarnessDef whose provider is the stub at `url`. */
  readonly def: (base: HarnessDef, url: string) => HarnessDef;
  /** Files written into the isolated home after Session.spawn() resets it. */
  readonly seed?: (home: string, cwd: string) => void;
  readonly note: string;
};

function withEnv(base: HarnessDef, extra: (home: string) => Record<string, string>): HarnessDef["env"] {
  return (home) => ({ ...(base.env?.(home) ?? {}), ...extra(home) });
}

const WIRING: Readonly<Record<string, Wiring>> = {
  claude: {
    protocol: "anthropic",
    note: "ANTHROPIC_BASE_URL and a subscription CLAUDE_CODE_OAUTH_TOKEN point at the stub, as Junto seats log in; onboarding and folder trust pre-seeded in the isolated CLAUDE_CONFIG_DIR",
    def: (base, url) => ({
      ...base,
      env: withEnv(base, () => ({
        ANTHROPIC_BASE_URL: url,
        CLAUDE_CODE_OAUTH_TOKEN: "capture-stub",
        CLAUDE_CODE_MAX_RETRIES: "3",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      })),
    }),
    seed: (home, cwd) => {
      const dir = path.join(home, ".claude");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
        hasCompletedOnboarding: true,
        theme: "dark",
        projects: Object.fromEntries([cwd, fs.realpathSync(cwd)].map((dir) =>
          [dir, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])),
      }, null, 2));
    },
  },
  codex: {
    protocol: "openai-responses",
    note: "-c model_provider points at a stub provider with env_key auth; CODEX_HOME isolated",
    def: (base, url) => ({
      ...base,
      argv: (cwd, sid) => [
        ...base.argv(cwd, sid),
        "-c", 'model_provider="capture"',
        "-c", `model_providers.capture={name="capture",base_url="${url}/v1",env_key="CAPTURE_STUB_KEY",wire_api="responses",request_max_retries=3,stream_max_retries=3}`,
      ],
      env: withEnv(base, () => ({ CAPTURE_STUB_KEY: "capture-stub" })),
    }),
    seed: (home) => { fs.mkdirSync(path.join(home, ".codex"), { recursive: true }); },
  },
  kimi: {
    protocol: "openai-chat",
    note: "KIMI_MODEL_* env points at the stub (kimi provider type, chat completions); folder trust seeded under the isolated HOME",
    def: (base, url) => ({
      ...base,
      env: withEnv(base, () => ({
        KIMI_MODEL_BASE_URL: `${url}/v1`,
        KIMI_MODEL_API_KEY: "capture-stub",
        KIMI_MODEL_NAME: "stub-model",
        KIMI_MODEL_PROVIDER_TYPE: "kimi",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_DISABLE_TELEMETRY: "1",
      })),
    }),
    seed: (home, cwd) => {
      const real = fs.realpathSync(cwd);
      const dir = path.join(home, ".kimi-code", "workspace-trust");
      fs.mkdirSync(dir, { recursive: true });
      const digest = createHash("sha256").update(real).digest("hex").slice(0, 12);
      fs.writeFileSync(path.join(dir, `wd_${path.basename(real).toLowerCase()}_${digest}`),
        JSON.stringify({ root: real, trustedAt: Date.now() }));
    },
  },
  hermes: {
    protocol: "openai-responses",
    note: "a named stub provider in the isolated ~/.hermes/config.yaml (codex_responses, as seats run openai-codex); dependencies come from a capture-owned install cache",
    // The status bar says "ready" once the session is forged; earlier glyphs paint before it.
    def: (base) => ({ ...base, argv: () => ["chat", "--tui"], promptGlyphs: ["ready"] }),
    seed: (home) => {
      const dir = path.join(home, ".hermes");
      fs.mkdirSync(dir, { recursive: true });
      // Hermes installs about 1.3 GB of dependencies into every new home and
      // updates them in place. Share one capture-owned cache across captures;
      // never the operator's ~/.hermes/installs, which a capture would rewrite.
      fs.mkdirSync(HERMES_INSTALLS, { recursive: true });
      fs.symlinkSync(HERMES_INSTALLS, path.join(dir, "installs"));
      fs.writeFileSync(path.join(dir, "config.yaml"), [
        "model:",
        "  provider: capture",
        "  default: stub-model",
        "providers:",
        "  capture:",
        `    base_url: http://127.0.0.1:${STUB_PORT}/v1`,
        "    api_key: capture-stub",
        "    api_mode: codex_responses",
        "telemetry:",
        "  shared_metrics:",
        "    enabled: false",
        "    send: false",
        "    offer_version: 2",
        "",
      ].join("\n"));
    },
  },
  grok: {
    protocol: "openai-chat",
    note: "a stub model in the isolated ~/.grok/config.toml (chat_completions backend); autoupdate, telemetry and campaigns off",
    def: (base) => ({
      ...base,
      argv: (cwd, sid) => ["--minimal", "-m", "stub", "--permission-mode", "default", "--session-id", sid],
      env: withEnv(base, () => ({
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_AUTO_UPDATE: "0",
        GROK_TELEMETRY_ENABLED: "0",
        GROK_FEEDBACK_ENABLED: "0",
        GROK_CAMPAIGNS: "0",
        GROK_PROMPT_SUGGESTIONS: "0",
      })),
    }),
    seed: (home) => {
      const dir = path.join(home, ".grok");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "config.toml"), [
        "[models]",
        'default = "stub"',
        "",
        "[model.stub]",
        'model = "stub-model"',
        `base_url = "http://127.0.0.1:${STUB_PORT}/v1"`,
        'name = "Stub"',
        'api_key = "capture-stub"',
        'api_backend = "chat_completions"',
        "context_window = 200000",
        "",
      ].join("\n"));
    },
  },
  pi: {
    protocol: "openai-responses",
    note: "a stub provider in the isolated PI_CODING_AGENT_DIR/models.json (openai-responses); --offline",
    def: (base) => ({
      ...base,
      argv: (cwd, sid) => ["-a", "--offline", "--model", "capture/stub-model", "--session-id", sid],
      // The footer context meter marks a ready composer.
      promptGlyphs: ["0.0%/200k (auto)"],
    }),
    seed: (home) => writePiModels(path.join(home, ".pi", "agent"), "models.json", "openai-responses"),
  },
  omp: {
    protocol: "anthropic",
    note: "a stub provider in the isolated PI_CODING_AGENT_DIR/models.yml (anthropic-messages); setup wizard and update check pre-seeded off",
    def: (base) => ({
      ...base,
      argv: () => ["--model", "capture/stub-model"],
      env: withEnv(base, (home) => ({
        PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
        PI_CODING_AGENT_SESSION_DIR: path.join(home, ".omp", "sessions"),
      })),
    }),
    seed: (home) => {
      const dir = path.join(home, ".omp", "agent");
      writePiModels(dir, "models.yml", "anthropic-messages");
      fs.writeFileSync(path.join(dir, "config.yml"), "setupVersion: 2\nstartup:\n  checkUpdate: false\n");
    },
  },
  muse: {
    protocol: "openai-responses",
    note: "the meta provider's --base-url points at the stub, which also serves the /muse-code/models catalog; auto-update off",
    def: (base, url) => ({
      ...base,
      argv: () => ["--base-url", `${url}/v1`, "--model", "stub-model", "--trust-workspace"],
      env: withEnv(base, () => ({ META_API_KEY: "capture-stub", MUSE_NO_AUTO_UPDATE: "1" })),
    }),
  },
  fx: {
    protocol: "openai-chat",
    note: "a stub provider in the isolated ~/.fx/settings.json (openai-chat-completions); auto_upgrade off",
    def: (base) => ({ ...base, env: withEnv(base, () => ({ CAPTURE_STUB_KEY: "capture-stub" })) }),
    seed: (home) => {
      const dir = path.join(home, ".fx");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
        providers: { capture: { protocol: "openai-chat-completions", base_url: `http://127.0.0.1:${STUB_PORT}/v1`, auth: { type: "bearer", env: "CAPTURE_STUB_KEY" } } },
        models: { capture: "stub-model" },
        provider: "capture",
        auto_upgrade: false,
      }, null, 2));
    },
  },
  devin: {
    protocol: "devin",
    note: "an isolated credentials.toml sends every Connect RPC to the stub; HTTPS_PROXY refuses anything else",
    def: (base, url) => ({ ...base, env: withEnv(base, () => sealedProxy(url)) }),
    seed: (home) => {
      // Overwrites the operator credentials Session.spawn() seeds for devin.
      const dir = path.join(home, ".local", "share", "devin");
      fs.mkdirSync(dir, { recursive: true });
      const url = `http://127.0.0.1:${STUB_PORT}`;
      fs.writeFileSync(path.join(dir, "credentials.toml"), [
        'windsurf_api_key = "capture-stub"',
        `api_server_url = "${url}"`,
        `devin_webapp_host = "${url}"`,
        `devin_api_url = "${url}"`,
        "",
      ].join("\n"));
    },
  },
  agy: {
    protocol: "gemini",
    note: "Gemini API key mode: GOOGLE_GEMINI_BASE_URL points at the stub; onboarding and folder trust pre-seeded; HTTPS_PROXY refuses anything else. The signed-in Google path is not reached.",
    def: (base, url) => ({
      ...base,
      env: withEnv(base, () => ({ ...sealedProxy(url), GEMINI_API_KEY: "capture-stub", GOOGLE_GEMINI_BASE_URL: url })),
    }),
    seed: (home, cwd) => {
      const dir = path.join(home, ".gemini", "antigravity-cli");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
        modelProvider: "gemini",
        trustedWorkspaces: [cwd, fs.realpathSync(cwd)],
      }, null, 2));
      fs.writeFileSync(path.join(dir, "jetski_state.pbtxt"), [
        "post_onboarding:  {",
        "  completed_steps:  POST_ONBOARDING_STEP_TYPE_MANAGER_WELCOME",
        "  completed_steps:  POST_ONBOARDING_STEP_TYPE_USAGE_MODE",
        "  completed_steps:  POST_ONBOARDING_STEP_TYPE_AGENT_CONFIGURATION",
        "  completed_steps:  POST_ONBOARDING_STEP_TYPE_ADD_WORKSPACE",
        "}",
        "",
      ].join("\n"));
    },
  },
  cursor: {
    protocol: "cursor",
    note: "CURSOR_API_ENDPOINT points at the stub, which answers Cursor's Connect RPCs and the cleartext HTTP/2 agent stream; file credential store, never the keychain; HTTPS_PROXY refuses anything else",
    def: (base, url) => ({
      ...base,
      env: withEnv(base, () => ({
        ...sealedProxy(url),
        CURSOR_API_KEY: "capture-stub",
        CURSOR_API_ENDPOINT: url,
        AGENT_CLI_CREDENTIAL_STORE: "file",
      })),
    }),
  },
  "prime-agent": {
    protocol: "openai-responses",
    note: "a stub provider in the isolated PRIME_AGENT_CODING_AGENT_DIR/models.json (openai-responses); its daemon socket is per capture, never the operator's",
    def: (base) => ({
      ...base,
      argv: () => ["--offline", "--model", "capture/stub-model", "--daemon-socket", PRIME_SOCKET],
      modals: [],
      env: withEnv(base, (home) => ({
        PRIME_AGENT_CODING_AGENT_DIR: path.join(home, ".prime", "agent"),
        PRIME_AGENT_SESSION_DIR: path.join(home, ".prime", "sessions"),
        PRIME_AGENT_TELEMETRY: "0",
        TMPDIR: path.join(home, "tmp"),
      })),
    }),
    seed: (home) => {
      fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
      writePiModels(path.join(home, ".prime", "agent"), "models.json", "openai-responses");
    },
  },
};

/** Proxy everything but the stub to the stub, which refuses every tunnel. */
function sealedProxy(url: string): Record<string, string> {
  return { HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
}

/** pi-lineage provider file: one `capture` provider pointed at the stub. */
function writePiModels(dir: string, file: string, api: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const baseUrl = api === "anthropic-messages" ? `http://127.0.0.1:${STUB_PORT}` : `http://127.0.0.1:${STUB_PORT}/v1`;
  // A 200k window, so the 190k context compaction-auto reports crosses the threshold.
  const providers = { capture: { baseUrl, api, apiKey: "capture-stub", models: [{ id: "stub-model", contextWindow: 200_000, maxTokens: 8_192 }] } };
  fs.writeFileSync(path.join(dir, file), file.endsWith(".yml")
    ? `providers:\n  capture: {baseUrl: "${baseUrl}", api: ${api}, apiKey: capture-stub, models: [{id: stub-model, contextWindow: 200000, maxTokens: 8192}]}\n`
    : JSON.stringify({ providers }, null, 2));
}

const HERMES_INSTALLS = "/tmp/junto-capture-cache/hermes-installs";

/**
 * Kill processes that outlived the TUI (prime-agent's daemon and its kernel)
 * by the capture home in their environment: the daemon rewrites its title.
 */
function killDetached(home: string): void {
  const ps = spawnSync("ps", ["-axE", "-o", "pid=,command="]).stdout?.toString() ?? "";
  for (const line of ps.split("\n")) {
    if (!line.includes(`HOME=${home} `) && !line.includes(`${home}/`)) continue;
    const pid = Number(line.trim().split(/\s+/u)[0]);
    if (pid && pid !== process.pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

/** Short enough for the 104-byte macOS socket path limit. */
const PRIME_SOCKET = `/tmp/junto-capture-prime-${process.pid}.sock`;

/** Harnesses pty-capture.ts has no definition for. */
const EXTRA_HARNESSES: readonly HarnessDef[] = [
  {
    name: "agy", displayName: "Antigravity",
    argv: () => [],
    promptGlyphs: ["? for shortcuts"],
    exitRecipe: ["\u0003", "\u0003", "\u0004"],
    modals: [
      { when: /press enter to continue/i, reply: "\r" },
      // Untick the data-use box (checked by default), then Down, Right to Done, Enter.
      { when: /terms of service & data use/i, reply: "\r\u001b[B\u001b[C\r" },
    ],
    note: "Gemini API key mode; first run is a theme picker, then the Terms screen",
  },
  {
    name: "cursor-agent", displayName: "Cursor Agent",
    argv: () => [],
    promptGlyphs: ["\u2192", "\u276f", ">"],
    exitRecipe: ["\u0003", "\u0003", "\u0004"],
    modals: [{ when: /workspace trust required/i, reply: "a" }],
    note: "the binary is cursor-agent; the corpus harness is cursor",
  },
  {
    name: "fx", displayName: "fx",
    argv: () => [],
    promptGlyphs: ["stub-model"],
    exitRecipe: ["\u0003", "\u0003", "\u0004"],
    note: "status bar names the active model once the composer is ready",
  },
];

const BINARY: Readonly<Record<string, string>> = { cursor: "cursor-agent" };

const harnessDef = (harness: string): HarnessDef | undefined =>
  [...HARNESSES, ...EXTRA_HARNESSES].find((def) => def.name === (BINARY[harness] ?? harness));

// ── driver ──────────────────────────────────────────────────────────────────

type Run = {
  readonly result: ScenarioResult;
  readonly screen: readonly string[];
  readonly sess: Session;
  /** Event count when the scenario ended, before the exit recipe repaints. */
  readonly endEvent: number;
};

/** Session start through scenario end, scrubbed as one contiguous stream. */
function writeFixture(sess: Session, endEvent: number, outPath: string): void {
  const slice = sess.events.slice(0, endEvent);
  const scrubbed = scrub(Buffer.concat(slice.map((e) => e.buf)).toString("utf8"), sess.cwd);
  const t0 = slice[0].t;
  const t1 = slice[slice.length - 1].t;
  const lines: string[] = [];
  const CHUNK = 24_000;
  for (let off = 0; off < scrubbed.length; off += CHUNK) {
    const chunk = scrubbed.slice(off, off + CHUNK);
    const t = Math.round(t0 + (t1 - t0) * Math.min(1, (off + chunk.length / 2) / scrubbed.length));
    lines.push(JSON.stringify({ t, b64: Buffer.from(chunk, "utf8").toString("base64") }));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`[${sess.name}] -> ${path.relative(path.join(__dirname, "..", ".."), outPath)} (${Math.round(scrubbed.length / 1024)} KiB)`);
}

function screenLines(term: import("@xterm/headless").Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runScenario(harness: string, scenario: Scenario, stub: StubProvider, url: string): Promise<Run> {
  const base = harnessDef(harness);
  const wiring = WIRING[harness];
  if (!base || !wiring) throw new Error(`${harness}: no stub wiring (have: ${Object.keys(WIRING).join(", ")})`);
  const wiredBase = wiring.def(base, url);
  // UTC keeps reset times deterministic and the operator's timezone out of fixtures.
  const overlay = { TZ: "UTC", ...scenario.env?.[harness] };
  const extraArgs = scenario.args?.[harness] ?? [];
  const wired: HarnessDef = {
    ...wiredBase,
    argv: (cwd, sid) => [...wiredBase.argv(cwd, sid), ...extraArgs],
    env: withEnv(wiredBase, () => overlay),
  };
  // Session.spawn() wipes the home before prep runs, so seeding goes in prep.
  const def: HarnessDef = {
    ...wired,
    prep: (cwd) => { wired.prep?.(cwd); wiring.seed?.(sess.home, cwd); },
  };
  const sess: Session = new Session(def);
  killDetached(sess.home);
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  let fed = 0;
  const pump = async () => {
    const pending = sess.events.slice(fed);
    fed = sess.events.length;
    for (const event of pending) await new Promise<void>((resolve) => term.write(event.buf, resolve));
  };
  const rendered: string[] = [];
  const seen = new Set<string>();
  // Spinner frames and ticking counters repaint one line many times; keep the
  // first paint of each line shape.
  const shape = (line: string) => line.replace(/^\s*[·*•◦]\s/u, "").replace(/[\p{So}\u2800-\u28ff]/gu, "").replace(/\d+/g, "#");
  const collect = (baseline: ReadonlySet<string>) => {
    for (const raw of screenLines(term)) {
      const line = raw.trimEnd();
      if (!line.trim() || baseline.has(line) || seen.has(shape(line))) continue;
      seen.add(shape(line));
      rendered.push(line);
    }
  };
  const plan = planFor(scenario, wiring.protocol);
  if (!plan) throw new Error(`${scenario.name} does not apply to ${wiring.protocol}`);
  const observed: Record<string, unknown> = { source: "stub-provider", signal: plan.signal, wiring: wiring.note };
  let status: ScenarioResult["status"] = "complete";
  let reason: string | undefined;

  stub.script([OK]);
  try {
    sess.spawn();
    const ready = await sess.waitPrompt(READY_CAP_MS);
    await sess.waitQuiet(8_000);
    await pump();
    if (!ready) {
      status = "skip";
      reason = sess.detectBlock() ?? "composer never ready";
    } else {
      stub.script(planFor(scenario, wiring.protocol)!.replies);
      for (const prompt of scenario.prompts) {
        await pump();
        const baseline = new Set(screenLines(term).map((line) => line.trimEnd()));
        sess.write(prompt);
        await wait(400);
        sess.write("\r");
        const start = Date.now();
        let quietSince = Date.now();
        let lastBytes = sess.bytes;
        let lastServed = stub.served.length;
        while (Date.now() - start < SETTLE_CAP_MS && !sess.exited) {
          await wait(100);
          await pump();
          collect(baseline);
          if (sess.bytes !== lastBytes || stub.served.length !== lastServed) {
            lastBytes = sess.bytes;
            lastServed = stub.served.length;
            quietSince = Date.now();
          }
          // Spinners and clocks never go byte-quiet; a stable screen with
          // the stub idle is settled too.
          if (Date.now() - quietSince >= SETTLE_QUIET_MS && stub.served.length > 0) break;
          if (Date.now() - start > 12_000 && stub.served.length === lastServed && sess.promptVisible(true) &&
              Date.now() - quietSince >= SETTLE_QUIET_MS / 2) break;
        }
      }
      await wait(1_000);
      await pump();
      if (stub.served.length === 0) {
        status = "skip";
        reason = "the harness never called the stub provider";
      } else if (scenario.expect && !rendered.some((line) => scenario.expect!.test(line))) {
        status = "skip";
        reason = `the screen never showed ${scenario.expect}`;
      } else if (scenario.reject && rendered.some((line) => scenario.reject!.test(line))) {
        status = "skip";
        reason = `the screen showed ${scenario.reject}`;
      }
    }
  } catch (err) {
    status = "fail";
    reason = String(err);
  }
  const screen = screenLines(term).map((line) => line.trimEnd());
  const endEvent = sess.events.length;
  observed.stubServed = stub.served.map((s) => `${s.path} ${s.reply}`);
  observed.renderedLines = rendered;
  observed.cliVersion = probeHarnessVersion(harness);
  for (const step of def.exitRecipe) { sess.write(step); await wait(500); }
  await sess.killTree();
  if (harness === "prime-agent") {
    killDetached(sess.home);
    fs.rmSync(PRIME_SOCKET, { force: true });
  }
  term.dispose();
  const cwd = sess.cwd;
  const scrubbed = JSON.parse(scrub(JSON.stringify(observed), cwd)) as Record<string, unknown>;
  return {
    result: { harness, scenario: scenario.name, status, reason, observed: scrubbed, expectedScreen: {} },
    screen: screen.map((line) => scrub(line, cwd)),
    sess,
    endEvent,
  };
}

// ── corpus merge ────────────────────────────────────────────────────────────

function mergeManifest(harness: string, results: readonly ScenarioResult[]): void {
  const file = path.join(OUT_ROOT, harness, "manifest.json");
  const manifest = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    : {
      harness,
      displayName: harnessDef(harness)?.displayName ?? harness,
      source: "stub-provider",
      pty: { cols: COLS, rows: ROWS, term: "xterm-256color" },
      sanitized: false,
      scrub: ["<HOME>", "<USER>", "<HOST>", "<CWD>", "<CAPTURE>", "<SESSION>", "<EMAIL>", "<TOKEN>"],
      scenarios: [],
    };
  const names = new Set(results.map((result) => result.scenario));
  const prior = Array.isArray(manifest.scenarios) ? manifest.scenarios as ScenarioResult[] : [];
  manifest.scenarios = [...prior.filter((row) => !names.has(row.scenario)), ...results];
  manifest.signalCaptureEvidence = {
    tool: "tests/pty-e2e/signal-capture.ts",
    capturedAt: new Date().toISOString(),
    harnessVersion: probeHarnessVersion(harness),
    provider: "scripted local stub; the binary and its rendering are real, the provider replies are not",
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

function mergeIndex(harness: string, results: readonly ScenarioResult[]): void {
  const file = path.join(OUT_ROOT, "index.json");
  const index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
  const prior = (index[harness] ?? {}) as { scenarios?: Array<{ scenario: string }> };
  const names = new Set(results.map((result) => result.scenario));
  index[harness] = {
    ...prior,
    scenarios: [
      ...(prior.scenarios ?? []).filter((row) => !names.has(row.scenario)),
      ...results.map((result) => ({ scenario: result.scenario, status: result.status, reason: result.reason ?? null })),
    ],
  };
  const ordered = Object.fromEntries(Object.entries(index).sort(([left], [right]) => left.localeCompare(right)));
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + "\n");
}

// ── main ────────────────────────────────────────────────────────────────────

function pickScenarios(names: readonly string[]): readonly Scenario[] {
  if (names.length === 0) return SCENARIOS;
  return names.map((name) => {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (!scenario) throw new Error(`unknown scenario ${name} (have: ${SCENARIOS.map((s) => s.name).join(", ")})`);
    return scenario;
  });
}

async function main(): Promise<void> {
  const [mode, harness, ...rest] = process.argv.slice(2);
  if (mode === "list" || !mode) {
    console.log(`harnesses: ${Object.keys(WIRING).join(", ")}`);
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(18)} ${s.signal}`);
    return;
  }
  if ((mode !== "probe" && mode !== "capture") || !harness) {
    throw new Error("usage: signal-capture.ts list | probe <harness> <scenario> | capture <harness> [scenario...]");
  }
  const stub = new StubProvider();
  const url = await stub.start();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of pickScenarios(rest)) {
      const wiring = WIRING[harness];
      if (wiring && !planFor(scenario, wiring.protocol)) {
        console.log(`[${harness}] ${scenario.name}: does not apply to ${wiring.protocol}`);
        continue;
      }
      console.log(`[${harness}] ${scenario.name}: ${scenario.signal}`);
      const run = await runScenario(harness, scenario, stub, url);
      console.log(`[${harness}] ${scenario.name}: ${run.result.status}${run.result.reason ? ` (${run.result.reason})` : ""}`);
      console.log(`  served: ${(run.result.observed.stubServed as string[]).join(", ") || "nothing"}`);
      for (const line of run.result.observed.renderedLines as string[]) console.log(`  | ${line}`);
      if (mode === "probe") {
        console.log("  ── final screen ──");
        for (const line of run.screen) console.log(`  ${line}`);
        continue;
      }
      if (run.result.status === "complete") {
        writeFixture(run.sess, run.endEvent, path.join(OUT_ROOT, harness, `${scenario.name}.jsonl`));
      }
      results.push(run.result);
    }
  } finally {
    await stub.stop();
  }
  if (mode === "capture" && results.length > 0) {
    mergeManifest(harness, results);
    mergeIndex(harness, results);
    earnSanitizedStamp(OUT_ROOT, harness, certifyHarness(OUT_ROOT, harness));
  }
}

const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedAs === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}
