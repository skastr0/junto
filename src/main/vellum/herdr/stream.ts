import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { herdrArgv, isKnownHerdrHost, UnknownHerdrHostError } from "./hosts";

export interface HerdrStreamFrame {
  readonly streamId: string;
  readonly type: "frame" | "closed" | "error";
  readonly bytes?: string; // base64 ANSI
  readonly encoding?: string;
  readonly full?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly seq?: number;
  readonly reason?: string;
  readonly message?: string;
}

export type StreamSink = (frame: HerdrStreamFrame) => void;

interface ActiveStream {
  readonly streamId: string;
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly openedAt: number;
}

/**
 * Owns at most one interactive control stream globally (product lock).
 * Opening a second stream releases the previous control (takeover path).
 *
 * ## Product lock — detach, never murder
 *
 * Closing a stream (modal close, takeover, app quit, launchd unload) ONLY:
 *   1. sends `terminal.release` to herdr
 *   2. SIGTERM the local/ssh *control client* process (`herdr terminal session control …`)
 *
 * It NEVER runs `pane close`, `tab close`, `workspace close`, or `session stop`.
 * Herdr panes and agents keep running on the host when Vellum exits. Rebuilding
 * or quitting Vellum must be a non-event for the fleet.
 */
export class HerdrStreamManager {
  private active: ActiveStream | undefined;
  private seq = 0;
  private sink: StreamSink | undefined;
  private shutDown = false;

  setSink(sink: StreamSink | undefined): void {
    this.sink = sink;
  }

  getActiveStreamId(): string | undefined {
    return this.active?.streamId;
  }

  open(input: {
    readonly hostId: string;
    readonly session?: string | null;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
    readonly takeover?: boolean;
  }): { readonly ok: true; readonly streamId: string } | { readonly ok: false; readonly message: string } {
    if (this.shutDown) {
      return { ok: false, message: "herdr streams shut down (app quitting)" };
    }
    if (!input.terminalId) {
      return { ok: false, message: "terminalId required for control stream" };
    }
    if (!isKnownHerdrHost(input.hostId) || input.hostId.startsWith("-")) {
      return { ok: false, message: `unknown herdr host: ${input.hostId}` };
    }
    // Single global control stream — detach previous first (never kill panes).
    if (this.active) this.detachControl(this.active.streamId, "superseded");

    const streamId = `hs-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const args = [
      "terminal",
      "session",
      "control",
      input.terminalId,
      ...(input.takeover === false ? [] : ["--takeover"]),
      "--cols",
      String(Math.max(20, Math.floor(input.cols || 80))),
      "--rows",
      String(Math.max(5, Math.floor(input.rows || 24))),
    ];
    let command: string;
    let argv: string[];
    try {
      ({ command, argv } = herdrArgv(input.hostId, args, input.session));
    } catch (error) {
      const message =
        error instanceof UnknownHerdrHostError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { ok: false, message };
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, argv, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to spawn control stream: ${message}` };
    }

    this.active = {
      streamId,
      hostId: input.hostId,
      session: input.session,
      terminalId: input.terminalId,
      child,
      openedAt: Date.now(),
    };

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this.handleLine(streamId, line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.emit({ streamId, type: "error", message: text.slice(0, 400) });
      }
    });

    child.on("close", (code) => {
      if (this.active?.streamId === streamId) {
        this.active = undefined;
        this.emit({
          streamId,
          type: "closed",
          reason: code === 0 ? "exit" : `exit_${code ?? "null"}`,
        });
      }
    });

    child.on("error", (error) => {
      if (this.active?.streamId === streamId) {
        this.active = undefined;
        this.emit({
          streamId,
          type: "error",
          message: error.message,
        });
        this.emit({ streamId, type: "closed", reason: "spawn_error" });
      }
    });

    return { ok: true, streamId };
  }

  input(streamId: string, dataBase64: string): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    return this.writeJson(stream.stream, {
      type: "terminal.input",
      data: dataBase64,
    });
  }

  /** Convenience: encode utf-8 text as base64 input. */
  inputText(streamId: string, text: string): { readonly ok: boolean; readonly error?: string } {
    return this.input(streamId, Buffer.from(text, "utf8").toString("base64"));
  }

  resize(
    streamId: string,
    cols: number,
    rows: number,
  ): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    return this.writeJson(stream.stream, {
      type: "terminal.resize",
      cols: Math.max(20, Math.floor(cols)),
      rows: Math.max(5, Math.floor(rows)),
    });
  }

  scroll(
    streamId: string,
    delta: number,
  ): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    return this.writeJson(stream.stream, {
      type: "terminal.scroll",
      delta,
    });
  }

  /**
   * Detach control only. Alias kept for IPC naming (`herdrStreamClose`).
   * Never kills a herdr pane/tab/session.
   */
  close(streamId: string, reason = "client_close"): { readonly ok: boolean; readonly error?: string } {
    return this.detachControl(streamId, reason);
  }

  /**
   * Release the interactive control client for `streamId`.
   * |- never pane close / tab close / session stop
   * |- safe to call on app quit and launchd unload
   */
  detachControl(streamId: string, reason = "client_close"): { readonly ok: boolean; readonly error?: string } {
    const active = this.active;
    if (!active || active.streamId !== streamId) {
      return { ok: true };
    }
    try {
      // Protocol: release input ownership; PTY continues on host.
      this.writeJson(active, { type: "terminal.release" });
    } catch {
      // ignore
    }
    try {
      // Kill only the control CLI/ssh *client* child — not the herdr server, not the pane.
      active.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.active = undefined;
    this.emit({ streamId, type: "closed", reason });
    return { ok: true };
  }

  /**
   * App/launchd shutdown: detach every control stream. Idempotent.
   * Product lock: quitting Vellum must not mass-kill herdr sessions.
   */
  detachAllOnQuit(reason = "app_quit"): void {
    this.shutDown = true;
    if (this.active) this.detachControl(this.active.streamId, reason);
  }

  /** @deprecated use detachAllOnQuit — name kept so greps for closeAll still find the intent */
  closeAll(): void {
    this.detachAllOnQuit("shutdown");
  }

  private require(
    streamId: string,
  ): { readonly ok: true; readonly stream: ActiveStream } | { readonly ok: false; readonly error: string } {
    if (!this.active || this.active.streamId !== streamId) {
      return { ok: false, error: "stream not active" };
    }
    return { ok: true, stream: this.active };
  }

  private writeJson(
    stream: ActiveStream,
    payload: Record<string, unknown>,
  ): { readonly ok: boolean; readonly error?: string } {
    try {
      stream.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private handleLine(streamId: string, line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "terminal.frame") {
      this.emit({
        streamId,
        type: "frame",
        bytes: typeof obj.bytes === "string" ? obj.bytes : "",
        encoding: typeof obj.encoding === "string" ? obj.encoding : "ansi",
        full: typeof obj.full === "boolean" ? obj.full : undefined,
        width: typeof obj.width === "number" ? obj.width : undefined,
        height: typeof obj.height === "number" ? obj.height : undefined,
        seq: typeof obj.seq === "number" ? obj.seq : undefined,
      });
      return;
    }
    if (type === "terminal.closed") {
      this.emit({
        streamId,
        type: "closed",
        reason: typeof obj.reason === "string" ? obj.reason : "closed",
      });
      if (this.active?.streamId === streamId) {
        try {
          this.active.child.kill("SIGTERM");
        } catch {
          // ignore
        }
        this.active = undefined;
      }
      return;
    }
  }

  private emit(frame: HerdrStreamFrame): void {
    this.sink?.(frame);
  }
}

export const herdrStreams = new HerdrStreamManager();
