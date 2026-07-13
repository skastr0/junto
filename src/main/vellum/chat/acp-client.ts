import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AcpSpawnTarget } from "./spawn";

// One long-lived `hermes acp` (or ssh-wrapped remote) child process, speaking
// newline-delimited JSON-RPC 2.0 over its stdio. This is the only place that
// knows the wire framing — ChatService only ever calls start/request/respond/
// respondError/close.
//
// PROVEN WIRE FACTS (live spike against hermes 0.16.0):
//   transport: ndjson over stdio; stderr is logging noise, forwarded to
//   console.debug, never parsed.
//   initialize -> {protocolVersion, agentCapabilities, authMethods}.
//   Agent -> client REQUESTS (session/request_permission, ...) arrive as
//   ndjson lines with both `id` and `method` — distinct from notifications
//   (method, no id) and from responses to our own requests (id, no method).

export type JsonRpcId = string | number;

interface JsonRpcOutboundRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcOutboundResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

// A raw ndjson line from the child, before we know which JSON-RPC shape it
// is — response to our request, agent -> client request, or notification.
interface InboundMessage {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

// Thrown when the agent answers one of our requests with a JSON-RPC error.
// Callers (ChatService) branch on `.code` — e.g. -32601 method not found —
// to decide whether a feature is simply unsupported rather than broken.
export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export type AcpLifecycleEvent =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "closed"; readonly code: number | null };

export interface AcpClientHandlers {
  // agent -> client notification (session/update, ...). Method + raw params
  // forwarded verbatim — ChatService decides how to project it to a ChatEvent.
  readonly onNotification: (method: string, params: unknown) => void;
  // agent -> client REQUEST (has both id and method, e.g.
  // session/request_permission). The handler owns answering it via
  // respond()/respondError() — the client never auto-answers.
  readonly onAgentRequest: (method: string, id: JsonRpcId, params: unknown) => void;
  // Fires once, on crash or unexpected exit. Never fires for an intentional
  // close() — the caller who called close() already knows.
  readonly onLifecycle: (event: AcpLifecycleEvent) => void;
}

// The minimal shape of a child process this client needs — satisfied by
// node:child_process's ChildProcessWithoutNullStreams, and by the fake
// EventEmitter-based child the unit tests inject in its place.
export interface AcpChildLike {
  readonly stdin: { write(chunk: string): boolean };
  readonly stdout: NodeJS.EventEmitter;
  readonly stderr: NodeJS.EventEmitter;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export type SpawnFn = (target: AcpSpawnTarget) => AcpChildLike;

const defaultSpawn: SpawnFn = (target) =>
  spawnProcess(target.command, [...target.argv], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

const INIT_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = 1;

export interface AcpAuthMethod {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}

export interface AcpInitializeResult {
  readonly protocolVersion?: number;
  readonly agentCapabilities?: {
    readonly loadSession?: boolean;
    readonly promptCapabilities?: Record<string, unknown>;
    readonly sessionCapabilities?: Record<string, unknown>;
  };
  readonly authMethods?: ReadonlyArray<AcpAuthMethod>;
}

export class AcpClient {
  private child: AcpChildLike | undefined;
  private buffer = "";
  private nextId = 1;
  private closedFlag = false;
  private readonly pending = new Map<
    JsonRpcId,
    { readonly resolve: (value: unknown) => void; readonly reject: (err: Error) => void }
  >();

  constructor(
    private readonly target: AcpSpawnTarget,
    private readonly handlers: AcpClientHandlers,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  // Spawns the child and performs the initialize handshake. Rejects (and
  // tears down the child) if the handshake doesn't complete within 20s.
  async start(): Promise<AcpInitializeResult> {
    const child = this.spawnFn(this.target);
    this.child = child;

    child.stdout.on("data", (chunk: unknown) => this.onStdout(String(chunk)));
    child.stderr.on("data", (chunk: unknown) => this.onStderr(String(chunk)));
    child.on("error", (err) => this.onChildDown({ kind: "error", message: err.message }));
    child.on("exit", (code) => this.onChildDown({ kind: "closed", code }));

    try {
      return await this.withTimeout(
        this.request<AcpInitializeResult>("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
        INIT_TIMEOUT_MS,
        "ACP initialize timed out after 20s",
      );
    } catch (err) {
      this.close();
      throw err;
    }
  }

  // Client -> agent request (session/new, session/prompt, ...). Rejects with
  // AcpRpcError when the agent answers with a JSON-RPC error.
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child || this.closedFlag) return Promise.reject(new Error("ACP client is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  // Answers an agent -> client request the handler decided to allow.
  respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  // Answers an agent -> client request the handler rejected (e.g. an unknown
  // method -> -32601, per the ACP wire contract).
  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  // Intentional teardown — never fires onLifecycle (the caller already knows).
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.rejectAllPending(new Error("ACP client closed"));
    try {
      this.child?.kill();
    } catch {
      // best-effort — the child may already be gone
    }
    this.child = undefined;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private write(message: JsonRpcOutboundRequest | JsonRpcOutboundResponse): void {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.handleLine(line);
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim().length > 0) console.debug(`[acp:${this.target.command}]`, line);
    }
  }

  private handleLine(line: string): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(line) as InboundMessage;
    } catch {
      console.debug("[acp] non-JSON line from child, skipping:", line.slice(0, 200));
      return;
    }
    if (typeof msg !== "object" || msg === null) return;

    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === "string";

    if (hasMethod && hasId) {
      // Agent -> client request: distinct from a notification (no id) and
      // from a response to one of our own requests (no method).
      this.handlers.onAgentRequest(msg.method as string, msg.id as JsonRpcId, msg.params);
      return;
    }
    if (hasMethod) {
      this.handlers.onNotification(msg.method as string, msg.params);
      return;
    }
    if (hasId) {
      const id = msg.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return; // stale/unknown id — nothing waiting on it
      this.pending.delete(id);
      if (msg.error) {
        pending.reject(new AcpRpcError(msg.error.code, msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private onChildDown(event: AcpLifecycleEvent): void {
    if (this.closedFlag) return; // already torn down intentionally
    this.closedFlag = true;
    this.rejectAllPending(
      new Error(event.kind === "error" ? event.message : `ACP child exited (code ${event.code ?? "unknown"})`),
    );
    this.child = undefined;
    this.handlers.onLifecycle(event);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}
