import { isAbsolute } from "node:path";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  type OwnedProcess,
} from "../process-signal";
import type { AcpSpawnTarget } from "./spawn";

// One long-lived `hermes acp` (or ssh-wrapped remote) child process, speaking
// newline-delimited JSON-RPC 2.0 over its stdio. This is the only place that
// knows the wire framing — ChatService only ever calls start/request/respond/
// respondError/close.
//
// PROVEN WIRE FACTS (live spike against hermes 0.16.0):
//   transport: ndjson over stdio; stderr is logging noise — never parsed.
//   Raw stderr/non-JSON lines are gated (see acpVerboseLogging); default off.
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
export type AcpChildLike = {
  readonly pid?: number;
  readonly stdin: { write(chunk: string): boolean };
  readonly stdout: NodeJS.EventEmitter;
  readonly stderr: NodeJS.EventEmitter;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

export interface LocalBrowserChildEnvironmentInput {
  readonly capability: string;
  readonly home: string;
}

export interface AcpChildEnvironmentOverlay {
  readonly VELLUM_BROWSER_CAPABILITY: string;
  readonly VELLUM_BROWSER_HOME: string;
}

export interface AcpSpawnOptions {
  readonly environmentOverlay?: AcpChildEnvironmentOverlay;
}

/** True when ACP may log raw stderr / non-JSON lines (sensitive material risk). */
export const acpVerboseLogging = (): boolean => {
  const value = process.env.VELLUM_ACP_VERBOSE ?? process.env.VELLUM_DEBUG ?? "";
  return value === "1" || value.toLowerCase() === "true";
};

export type SpawnFn = (
  target: AcpSpawnTarget,
  options?: AcpSpawnOptions,
) => AcpChildLike;

const BROWSER_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BROWSER_CAPABILITY_BYTES = 32;
const BROWSER_HOME_MAX_BYTES = 4_096;

const isCanonicalBrowserCapability = (capability: unknown): capability is string => {
  if (typeof capability !== "string" || !BROWSER_CAPABILITY_PATTERN.test(capability)) {
    return false;
  }
  try {
    const decoded = Buffer.from(capability, "base64url");
    return (
      decoded.byteLength === BROWSER_CAPABILITY_BYTES &&
      decoded.toString("base64url") === capability
    );
  } catch {
    return false;
  }
};

export const makeLocalBrowserChildEnvironment = (
  input: LocalBrowserChildEnvironmentInput,
): AcpChildEnvironmentOverlay => {
  if (!isCanonicalBrowserCapability(input.capability)) {
    throw new TypeError("browser capability has an invalid format");
  }
  if (
    typeof input.home !== "string" ||
    !isAbsolute(input.home) ||
    Buffer.byteLength(input.home, "utf8") > BROWSER_HOME_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(input.home)
  ) {
    throw new TypeError("browser home must be a bounded absolute path");
  }
  return Object.freeze({
    VELLUM_BROWSER_CAPABILITY: input.capability,
    VELLUM_BROWSER_HOME: input.home,
  });
};

const INIT_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = 1;
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;

// Grace window between SIGTERM and a SIGKILL escalation for a child that
// ignores (or is too wedged to process) the polite signal. Shared by close()
// and a post-handshake request timeout (killChild below).
const SIGTERM_GRACE_MS = 2_000;

// Per-method budget for post-handshake requests (session/new, session/load,
// session/prompt, session/set_model, ...), each strictly under the matching
// preload IPC ceiling (preload/index.ts: chatOpen/chatSetModel 45s,
// chatPrompt 900s) so the main process always times out and tears the
// session down first — the renderer's own timeout should only ever fire on a
// genuinely dead main process, never race a live one. "initialize" is
// deliberately absent: it is bounded by start()'s own withTimeout(
// INIT_TIMEOUT_MS) wrap instead, so request() leaves it unbounded here.
const REQUEST_TIMEOUT_MS: Readonly<Record<string, number>> = {
  "session/new": 30_000,
  "session/load": 30_000,
  "session/set_model": 30_000,
  "session/prompt": 840_000,
};

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
  private childProcess: OwnedProcess | undefined;
  private buffer = "";
  private nextId = 1;
  private closedFlag = false;
  private environmentOverlay: AcpChildEnvironmentOverlay | undefined;
  private readonly pending = new Map<
    JsonRpcId,
    { readonly resolve: (value: unknown) => void; readonly reject: (err: Error) => void }
  >();

  constructor(
    private readonly target: AcpSpawnTarget,
    private readonly handlers: AcpClientHandlers,
    private readonly spawnFn: SpawnFn,
    environmentOverlay?: AcpChildEnvironmentOverlay,
  ) {
    this.environmentOverlay =
      environmentOverlay === undefined
        ? undefined
        : makeLocalBrowserChildEnvironment({
            capability: environmentOverlay.VELLUM_BROWSER_CAPABILITY,
            home: environmentOverlay.VELLUM_BROWSER_HOME,
          });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** OS pid of the local ACP child after start(); undefined when remote/closed. */
  get childPid(): number | undefined {
    const pid = this.child?.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  // Spawns the child and performs the initialize handshake. Rejects (and
  // tears down the child) if the handshake doesn't complete within 20s.
  async start(): Promise<AcpInitializeResult> {
    if (this.closedFlag) throw new Error("ACP client is closed");

    // A restart supersedes the exact prior child. Detach it from client state
    // before signaling so a synchronous/late exit cannot close the replacement.
    const previousChild = this.child;
    const previousProcess = this.childProcess;
    if (previousChild !== undefined || previousProcess !== undefined) {
      this.child = undefined;
      this.childProcess = undefined;
      this.buffer = "";
      this.rejectAllPending(new Error("ACP client restarted"));
      if (previousChild !== undefined && previousProcess !== undefined) {
        this.killChild(previousChild, previousProcess);
      } else {
        releaseOwned(previousProcess);
      }
    }

    const environmentOverlay = this.environmentOverlay;
    this.environmentOverlay = undefined;
    if (environmentOverlay !== undefined && this.target.host !== "local") {
      throw new Error("ACP child environment overlays are local-only");
    }
    const child = this.spawnFn(
      this.target,
      environmentOverlay === undefined ? undefined : { environmentOverlay },
    );
    const childProcess = admitChildProcess({
      source: `chat-acp:${this.target.host}:${this.target.profile}`,
      child,
    });
    this.child = child;
    this.childProcess = childProcess;

    child.stdout.on("data", (chunk: unknown) => {
      if (this.isCurrentChild(child, childProcess)) this.onStdout(String(chunk));
    });
    child.stderr.on("data", (chunk: unknown) => {
      if (this.isCurrentChild(child, childProcess)) this.onStderr(String(chunk));
    });
    child.on("error", (err) =>
      this.onChildDown(child, childProcess, { kind: "error", message: err.message }),
    );
    child.on("exit", (code) =>
      this.onChildDown(child, childProcess, { kind: "closed", code }),
    );

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
      if (this.isCurrentChild(child, childProcess)) this.close();
      throw err;
    }
  }

  // Client -> agent request (session/new, session/prompt, ...). Rejects with
  // AcpRpcError when the agent answers with a JSON-RPC error. Post-handshake
  // methods listed in REQUEST_TIMEOUT_MS are bounded: a timeout rejects this
  // call AND presumes the whole child wedged — it tears the client down
  // (killChild) and fires onLifecycle so ChatService cleans up the session,
  // exactly like an unexpected exit, instead of latching promptInFlight/the
  // session map forever.
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child || this.closedFlag) return Promise.reject(new Error("ACP client is not running"));
    const id = this.nextId++;
    const raw = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });

    const timeoutMs = REQUEST_TIMEOUT_MS[method];
    if (timeoutMs === undefined) return raw; // e.g. "initialize" — bounded by start()'s own wrap

    const message = `ACP request '${method}' timed out after ${timeoutMs}ms`;
    return this.withTimeout(raw, timeoutMs, message).catch((err: unknown) => {
      if (err instanceof Error && err.message === message) this.handleFatalFailure(message);
      throw err;
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

  // Intentional teardown — never fires onLifecycle (the caller already
  // knows). Idempotent: a second call is a no-op. SIGTERM first, SIGKILL
  // after a short grace window if the child hasn't actually exited.
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.rejectAllPending(new Error("ACP client closed"));
    const child = this.child;
    const childProcess = this.childProcess;
    this.child = undefined;
    this.childProcess = undefined;
    if (child && childProcess) this.killChild(child, childProcess);
  }

  // Sends SIGTERM, then escalates to SIGKILL if the child hasn't exited
  // within SIGTERM_GRACE_MS. Shared by close() and a post-handshake request
  // timeout (handleFatalFailure) — both need the same hard-kill guarantee
  // for a child that ignores or is too wedged to process the polite signal.
  private killChild(child: AcpChildLike, childProcess: OwnedProcess): void {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      releaseOwned(childProcess);
    };
    child.on("exit", finish);
    child.on("error", finish);
    signalOwned(childProcess, "SIGTERM");
    if (finished) return;
    timer = setTimeout(() => {
      if (finished) return;
      signalOwned(childProcess, "SIGKILL");
      finish();
    }, SIGTERM_GRACE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private isCurrentChild(child: AcpChildLike, childProcess: OwnedProcess): boolean {
    return this.child === child && this.childProcess === childProcess;
  }

  // A fatal transport condition (timeout or oversized inbound frame) means
  // the whole child is unusable — tear the client down the
  // same way an unexpected exit would (kill the child, notify onLifecycle)
  // so ChatService deletes the session and its own promptInFlight/
  // openInFlight bookkeeping clears via its existing finally()/catch,
  // instead of latching "turn in flight" or a live-but-empty session
  // forever. Idempotent — a second failure (or a concurrent close()) after
  // teardown has already started is a no-op.
  private handleFatalFailure(message: string): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.rejectAllPending(new Error(message));
    const child = this.child;
    const childProcess = this.childProcess;
    this.child = undefined;
    this.childProcess = undefined;
    if (child && childProcess) this.killChild(child, childProcess);
    this.handlers.onLifecycle({ kind: "error", message });
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
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_INBOUND_FRAME_BYTES) {
        this.handleFatalFailure("ACP inbound frame exceeded the 1 MiB limit");
        return;
      }
      const line = rawLine.trim();
      if (line.length > 0) this.handleLine(line);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_INBOUND_FRAME_BYTES) {
      this.handleFatalFailure("ACP inbound frame exceeded the 1 MiB limit");
    }
  }

  private onStderr(chunk: string): void {
    // Privacy: remote tools may print secrets/tokens on stderr. Default is
    // silent; opt in with VELLUM_ACP_VERBOSE=1 or VELLUM_DEBUG=1.
    if (!acpVerboseLogging()) return;
    for (const line of chunk.split("\n")) {
      if (line.trim().length > 0) {
        console.debug(`[acp:${this.target.host}:${this.target.profile}]`, line);
      }
    }
  }

  private handleLine(line: string): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(line) as InboundMessage;
    } catch {
      if (acpVerboseLogging()) {
        console.debug("[acp] non-JSON line from child, skipping:", line.slice(0, 200));
      }
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

  private onChildDown(
    child: AcpChildLike,
    childProcess: OwnedProcess,
    event: AcpLifecycleEvent,
  ): void {
    releaseOwned(childProcess);
    if (!this.isCurrentChild(child, childProcess)) return;
    this.child = undefined;
    this.childProcess = undefined;
    if (this.closedFlag) return; // already torn down intentionally
    this.closedFlag = true;
    this.rejectAllPending(
      new Error(event.kind === "error" ? event.message : `ACP child exited (code ${event.code ?? "unknown"})`),
    );
    this.handlers.onLifecycle(event);
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}
