/**
 * One persistent Cua Driver connection for the QA tiers.
 *
 * Spawns `cua-driver mcp` once and speaks newline-delimited JSON-RPC over its
 * stdio for the whole run: no per-action process, one named session, and the
 * agent cursor overlay switched off so no action waits on a cursor glide. The
 * driver is model-free; every call here is a deterministic tool invocation.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Json = Record<string, unknown>;

export class CuaError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

interface Pending {
  readonly resolve: (value: Json) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CuaDriver {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly session: string,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`cua-driver mcp exited (${code ?? signal})`));
      }
      this.pending.clear();
    });
  }

  /**
   * Connect once, open the session, and turn the agent cursor overlay off. A
   * session name binds to one transport lease, so each connection gets its own.
   */
  static async connect(prefix: string, binary = process.env.CUA_DRIVER_BIN ?? "cua-driver"): Promise<CuaDriver> {
    const child = spawn(binary, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const driver = new CuaDriver(child, `${prefix}-${process.pid}-${Date.now().toString(36)}`);
    await driver.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "junto-qa", version: "1" },
    });
    driver.notify("notifications/initialized", {});
    await driver.call("start_session", {});
    await driver.call("set_agent_cursor_enabled", { enabled: false });
    return driver;
  }

  private onLine(line: string): void {
    let message: { id?: number; result?: Json; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result ?? {});
  }

  private notify(method: string, params: Json): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private rpc(method: string, params: Json, timeoutMs = 60_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("cua-driver connection is closed"));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Call one driver tool in this session; returns its structured result or throws. */
  async call(tool: string, args: Json, timeoutMs?: number): Promise<Json> {
    const withSession = tool === "list_windows" || tool === "kill_app" || tool === "list_apps" ? args : { ...args, session: this.session };
    const result = await this.rpc("tools/call", { name: tool, arguments: withSession }, timeoutMs);
    const structured = result.structuredContent as Json | undefined;
    if (result.isError === true) {
      const text = (result.content as Array<{ text?: string }> | undefined)?.map((part) => part.text ?? "").join(" ");
      throw new CuaError(tool, text?.slice(0, 500) || JSON.stringify(structured ?? result).slice(0, 500));
    }
    if (structured && (structured.status === "refused" || structured.refusal)) {
      throw new CuaError(tool, `refused ${JSON.stringify(structured.refusal ?? structured).slice(0, 500)}`);
    }
    return structured ?? {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.call("end_session", {}).catch(() => {});
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}
