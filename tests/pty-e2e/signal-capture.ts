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
import type { AddressInfo } from "node:net";
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

type Protocol = "anthropic" | "openai-responses" | "openai-chat";

type Reply =
  /** `inputTokens` is the context size the reply reports; large values trigger auto-compaction. */
  | { readonly kind: "ok"; readonly text: string; readonly delayMs?: number; readonly inputTokens?: number }
  | { readonly kind: "error"; readonly status: number; readonly body: unknown; readonly headers?: Record<string, string>; readonly delayMs?: number }
  /** Destroy the socket before any response: a network failure. */
  | { readonly kind: "drop"; readonly delayMs?: number };

/** Failures held back this long so a retry state stays on screen between attempts. */
const RETRY_HOLD_MS = 1_500;
const held = (reply: Reply): Reply => ({ ...reply, delayMs: RETRY_HOLD_MS });

type Served = { readonly path: string; readonly reply: string };

const OK: Reply = { kind: "ok", text: "Hello from the capture stub." };
/** Held back so the compaction spinner stays on screen long enough to sample. */
const SUMMARY: Reply = { kind: "ok", text: "Summary: the user greeted the assistant and the assistant replied.", delayMs: 4_000 };
/** A fixed port keeps the stub address that harnesses print stable across captures. */
const STUB_PORT = Number(process.env.CAPTURE_STUB_PORT ?? 47_820);

function protocolOf(pathname: string): Protocol | null {
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

function okJson(protocol: Protocol, text: string, n: number): unknown {
  if (protocol === "anthropic") {
    return { id: `msg_stub${n}`, type: "message", role: "assistant", model: "stub", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } };
  }
  if (protocol === "openai-responses") {
    return { id: `resp_stub${n}`, object: "response", status: "completed", output: [{ id: `msg_stub${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
  }
  return { id: `chatcmpl-stub${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } };
}

/**
 * A scripted provider. Model requests consume `replies` in order and the last
 * reply repeats; anything else (model lists, health probes) gets an empty 200.
 */
class StubProvider {
  private server: http.Server | null = null;
  private replies: readonly Reply[] = [OK];
  private cursor = 0;
  readonly served: Served[] = [];

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(STUB_PORT, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  script(replies: readonly Reply[]): void {
    this.replies = replies;
    this.cursor = 0;
    this.served.length = 0;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const pathname = new URL(req.url ?? "/", "http://stub").pathname;
    const protocol = req.method === "POST" ? protocolOf(pathname) : null;
    if (pathname === "/muse-code/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MUSE_CATALOG));
      return;
    }
    // Muse sends reminder side calls each turn; they never consume the script.
    const role = req.headers["x-tbh-agent-role"];
    if (protocol && typeof role === "string" && role !== "main") {
      this.respondOk(res, body, protocol, OK, 0);
      return;
    }
    if (!protocol) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    const reply = this.replies[Math.min(this.cursor, this.replies.length - 1)];
    this.cursor += 1;
    const n = this.cursor;
    this.served.push({ path: pathname, reply: reply.kind === "error" ? String(reply.status) : reply.kind });
    const respond = () => {
      if (reply.kind === "drop") req.socket.destroy();
      else if (reply.kind === "error") {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      } else this.respondOk(res, body, protocol, reply, n);
    };
    if (reply.delayMs) setTimeout(respond, reply.delayMs);
    else respond();
  }

  private respondOk(res: http.ServerResponse, body: string, protocol: Protocol, reply: Extract<Reply, { kind: "ok" }>, n: number): void {
    const text = reply.text;
    let streaming = false;
    try { streaming = (JSON.parse(body) as { stream?: unknown }).stream === true; } catch { /* not JSON */ }
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
  readonly replies: (protocol: Protocol) => readonly Reply[];
  /** Typed into the composer in order; each waits for the previous to settle. */
  readonly prompts: readonly string[];
  /** Extra env for one harness in this scenario, over its wiring. */
  readonly env?: Readonly<Record<string, Record<string, string>>>;
  /** The screen must show this, or the scenario is a skip and writes no fixture. */
  readonly expect?: RegExp;
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
    replies: () => [{ ...OK, inputTokens: 190_000 }, SUMMARY, OK],
    args: { codex: ["-c", "model_context_window=200000", "-c", "model_auto_compact_token_limit=150000"] },
    env: { claude: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } },
  },
  {
    name: "compaction-manual",
    signal: "CompactionStarted { trigger: manual }, CompactionEnded { ok }",
    prompts: ["say hi", "/compact"],
    expect: /compact/i,
    replies: () => [OK, SUMMARY],
  },
];

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
      // The footer context meter marks a ready composer; the stub model has a 128k window.
      promptGlyphs: ["0.0%/128k (auto)"],
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

/** pi-lineage provider file: one `capture` provider pointed at the stub. */
function writePiModels(dir: string, file: string, api: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const baseUrl = api === "anthropic-messages" ? `http://127.0.0.1:${STUB_PORT}` : `http://127.0.0.1:${STUB_PORT}/v1`;
  const providers = { capture: { baseUrl, api, apiKey: "capture-stub", models: [{ id: "stub-model" }] } };
  fs.writeFileSync(path.join(dir, file), file.endsWith(".yml")
    ? `providers:\n  capture: {baseUrl: "${baseUrl}", api: ${api}, apiKey: capture-stub, models: [{id: stub-model}]}\n`
    : JSON.stringify({ providers }, null, 2));
}

const HERMES_INSTALLS = "/tmp/junto-capture-cache/hermes-installs";

/** Short enough for the 104-byte macOS socket path limit. */
const PRIME_SOCKET = `/tmp/junto-capture-prime-${process.pid}.sock`;

/** Harnesses pty-capture.ts has no definition for. */
const EXTRA_HARNESSES: readonly HarnessDef[] = [
  {
    name: "fx", displayName: "fx",
    argv: () => [],
    promptGlyphs: ["stub-model"],
    exitRecipe: ["\u0003", "\u0003", "\u0004"],
    note: "status bar names the active model once the composer is ready",
  },
];

const harnessDef = (harness: string): HarnessDef | undefined =>
  [...HARNESSES, ...EXTRA_HARNESSES].find((def) => def.name === harness);

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
  const observed: Record<string, unknown> = { source: "stub-provider", signal: scenario.signal, wiring: wiring.note };
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
      stub.script(scenario.replies(wiring.protocol));
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
    // The daemon detaches from the TUI; it is ours by its per-capture socket.
    spawnSync("pkill", ["-f", PRIME_SOCKET]);
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
