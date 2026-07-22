import type { HerdrPointerCell, HerdrRetainedPayload } from "@shared/ipc";
import { isKnownHerdrHost } from "./hosts";
import { feedNdjson } from "./ndjson";
import { pastePathPayload, stageImageOnHost, type StageRemoteImage } from "./stage-image";

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

const CONTROL_CHILD_TERMINATION_GRACE_MS = 1_500;

type LocalControlLifecycle = {
  readonly kind: "local-process";
  readonly terminate: (reason: string) => unknown;
  readonly forceTerminate: (reason: string) => unknown;
  terminationRequested: boolean;
  closed: boolean;
  terminationTimer?: ReturnType<typeof setTimeout>;
};

type RemoteControlLifecycle = {
  readonly kind: "remote-scope";
  readonly close: () => Promise<RemoteScopeCloseReceipt>;
  closeRequested: boolean;
};

interface ActiveStream {
  readonly streamId: string;
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly child: HerdrClientIo;
  /** The control client belongs to this attached session, never the host pane. */
  readonly lifetime: "session-owned";
  readonly lifecycle: LocalControlLifecycle | RemoteControlLifecycle;
  readonly openedAt: number;
  /** Last known geometry — reused when handing the terminal back to the observe pool. */
  cols: number;
  rows: number;
  /** First live control frame clears the pool's retention for this terminal. */
  firstFrameSeen: boolean;
  /**
   * Settles once every write enqueued so far has been fully flushed to
   * stdin. Present only while a chunked (or queued-behind-one) write is
   * in flight — its presence is the ordering gate: a write that arrives
   * while this is set queues behind it instead of writing straight through,
   * so a resize can never overtake a paste's slices mid-flight.
   */
  pendingWrite?: Promise<void>;
  /**
   * Set the moment inbound overflow kills the child. SIGTERM delivery is
   * not instantaneous — a wedged child can keep emitting unterminated
   * garbage after the signal until it actually exits, and each chunk would
   * otherwise re-trip feedNdjson's overflow path. Guards handleInboundOverflow
   * against re-emitting duplicate error frames / re-issuing redundant kills
   * for the same stream in that window.
   */
  overflowed?: boolean;
}

export interface HerdrClientIo {
  readonly stdin: {
    write(chunk: string): boolean;
    /** Real Node Writables (local spawn) and test PassThroughs support this;
     * the Effect-owned remote child does not — treated as never-backpressured. */
    once?(event: "drain", listener: () => void): unknown;
  };
  readonly stdout: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  readonly stderr: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type RemoteScopeCloseReceipt =
  | { readonly status: "closed" }
  | { readonly status: "timed-out"; readonly timeoutMs: number }
  | { readonly status: "failed"; readonly message: string };

export type HerdrSpawnedClient =
  | {
      readonly kind: "local-process";
      readonly child: HerdrClientIo;
      /** Exact central app-process capability, bound by the spawn factory. */
      readonly terminate: (reason: string) => unknown;
      readonly forceTerminate: (reason: string) => unknown;
    }
  | {
      readonly kind: "remote-scope";
      readonly child: HerdrClientIo;
      readonly close: () => Promise<RemoteScopeCloseReceipt>;
    };

export type HerdrSpawnFn = (
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
) => HerdrSpawnedClient;

/** Observe-pool hooks the stream manager drives (injectable for tests). */
export interface ObservePoolHooks {
  ensureObserve(input: {
    readonly hostId: string;
    readonly session?: string | null;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  }): { readonly pooled: boolean };
  retainedFrames(terminalId: string): HerdrRetainedPayload;
  pauseForControl(terminalId: string): void;
  clearRetention(terminalId: string): void;
  releaseObserve(terminalId: string): void;
  stopAll(): void | Promise<void>;
}

/**
 * Outbound NDJSON command lines larger than this are sliced into multiple
 * stdin writes so a single big paste cannot alone trip the ssh transport's
 * per-write boundary (INPUT_CHUNK_LIMIT_BYTES in ../ssh/service.ts, 1 MiB) —
 * converting what used to be a child error + stream reconnect into an
 * ordinary multi-write flush. Line framing is `\n`-delimited, so slicing one
 * line across writes is protocol-safe: herdr just sees the same bytes arrive
 * as several reads before the trailing newline.
 */
const DEFAULT_WRITE_CHUNK_CHARS = 256 * 1024;

/** Never split a UTF-16 surrogate pair — base64 payloads are pure ASCII and
 * unaffected, but raw pasted text (inputText) may carry astral characters
 * (emoji) that would mangle into replacement chars if cut mid-pair. */
const chunkSliceEnd = (payload: string, start: number, maxChars: number): number => {
  const end = Math.min(start + maxChars, payload.length);
  if (end < payload.length) {
    const code = payload.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  }
  return end;
};

/**
 * Writes `payload` to `stdin` in <=chunkChars slices, honoring write()
 * backpressure — waits for `drain` before the next slice whenever the
 * stream signals it (`write` returns false) and supports the event.
 * Resolves once every slice has been handed to the stream.
 */
export const writeChunked = (
  stdin: HerdrClientIo["stdin"],
  payload: string,
  chunkChars = DEFAULT_WRITE_CHUNK_CHARS,
): Promise<void> =>
  new Promise((resolve) => {
    let offset = 0;
    const pump = (): void => {
      while (offset < payload.length) {
        const end = chunkSliceEnd(payload, offset, chunkChars);
        const slice = payload.slice(offset, end);
        offset = end;
        const flushed = stdin.write(slice);
        if (!flushed && offset < payload.length) {
          if (typeof stdin.once === "function") {
            stdin.once("drain", pump);
            return;
          }
          // No drain signal on this stdin shape — best effort, keep pumping.
        }
      }
      resolve();
    };
    pump();
  });

/**
 * Owns concurrent interactive control streams (one per streamId).
 * At most one control stream per terminalId: re-opening the same terminal
 * detaches that terminal's prior control only — unrelated terminals stay live.
 *
 * ## Product lock — detach, never murder
 *
 * Closing a stream (modal close, same-PTY re-open, app quit, launchd unload) ONLY:
 *   1. sends `terminal.release` to herdr
 *   2. SIGTERM the exact local control client with bounded SIGKILL escalation,
 *      or close the exact remote SSH Effect scope with a bounded receipt
 *
 * It NEVER runs `pane close`, `tab close`, `workspace close`, or `session stop`.
 * Herdr panes and agents keep running on the host when Vellum exits. Rebuilding
 * or quitting Vellum must be a non-event for the fleet.
 */
export class HerdrStreamManager {
  /** streamId → active control stream */
  private streams = new Map<string, ActiveStream>();
  /** terminalId → streamId (at most one control per terminal) */
  private byTerminal = new Map<string, string>();
  private seq = 0;
  private sink: StreamSink | undefined;
  private shutDown = false;
  /** Bounded close receipts retained after streams leave the active indexes. */
  private readonly pendingRemoteCloses = new Set<Promise<RemoteScopeCloseReceipt>>();
  /** Fires once a control stream is live for a terminal (message-delivery retry). */
  private openHook: ((terminalId: string) => void) | undefined;

  constructor(
    private readonly pool: ObservePoolHooks,
    private readonly spawnFn: HerdrSpawnFn,
    private readonly stageRemote: StageRemoteImage,
  ) {}

  setSink(sink: StreamSink | undefined): void {
    this.sink = sink;
  }

  /** Optional attach hook — message delivery retries pending nudges here. */
  setOpenHook(hook: ((terminalId: string) => void) | undefined): void {
    this.openHook = hook;
  }

  /** Lookup live control stream for a herdr terminal (message delivery). */
  streamIdForTerminal(terminalId: string): string | undefined {
    return this.byTerminal.get(terminalId);
  }

  /** @deprecated multi-stream era — returns first/any active streamId if any */
  getActiveStreamId(): string | undefined {
    return this.streams.keys().next().value;
  }

  /** Count of attached control streams (quit affordance / live-work gate). */
  activeControlCount(): number {
    return this.streams.size;
  }

  open(input: {
    readonly hostId: string;
    readonly session?: string | null;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
    readonly takeover?: boolean;
  }):
    | { readonly ok: true; readonly streamId: string; readonly retained: HerdrRetainedPayload }
    | { readonly ok: false; readonly message: string } {
    if (this.shutDown) {
      return { ok: false, message: "herdr streams shut down (app quitting)" };
    }
    if (!input.terminalId) {
      return { ok: false, message: "terminalId required for control stream" };
    }
    if (!isKnownHerdrHost(input.hostId) || input.hostId.startsWith("-")) {
      return { ok: false, message: `unknown herdr host: ${input.hostId}` };
    }
    // Same-PTY re-open: detach only this terminal's prior control (never others).
    const priorStreamId = this.byTerminal.get(input.terminalId);
    if (priorStreamId) this.detachControl(priorStreamId, "superseded");

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
    // Capture retained observe frames BEFORE the observe child is killed —
    // the renderer paints these synchronously while live frames spin up.
    const retained = this.pool.retainedFrames(input.terminalId);

    let child: HerdrClientIo;
    let lifecycle: LocalControlLifecycle | RemoteControlLifecycle;
    try {
      const spawned = this.spawnFn(input.hostId, args, input.session);
      if ((input.hostId === "local") !== (spawned.kind === "local-process")) {
        throw new Error(`herdr spawn kind does not match host ${input.hostId}`);
      }
      child = spawned.child;
      if (spawned.kind === "local-process") {
        lifecycle = {
          kind: "local-process",
          terminate: spawned.terminate,
          forceTerminate: spawned.forceTerminate,
          terminationRequested: false,
          closed: false,
        };
      } else {
        lifecycle = {
          kind: "remote-scope",
          close: spawned.close,
          closeRequested: false,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to spawn control stream: ${message}` };
    }

    // Control now provides frames: kill the terminal's observe child but keep
    // its retention until the first live control frame arrives (handleLine).
    this.pool.pauseForControl(input.terminalId);

    const active: ActiveStream = {
      streamId,
      hostId: input.hostId,
      session: input.session,
      terminalId: input.terminalId,
      child,
      lifetime: "session-owned",
      lifecycle,
      openedAt: Date.now(),
      cols: Math.max(20, Math.floor(input.cols || 80)),
      rows: Math.max(5, Math.floor(input.rows || 24)),
      firstFrameSeen: false,
    };
    this.streams.set(streamId, active);
    this.byTerminal.set(input.terminalId, streamId);
    try {
      this.openHook?.(input.terminalId);
    } catch {
      // Hook must never sink stream open.
    }

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer = feedNdjson(buffer, chunk, (line) => this.handleLine(streamId, line), {
        onOverflow: () => this.handleInboundOverflow(streamId),
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (!this.streams.has(streamId)) return;
      // herdr often prints "herdr: … input ignored: …" on stderr (or stdout).
      for (const text of chunk.split("\n").map((l) => l.trim()).filter(Boolean)) {
        this.emit({ streamId, type: "error", message: text.slice(0, 400) });
      }
    });

    child.on("close", (code) => {
      if (active.lifecycle.kind === "remote-scope") {
        // Natural remote exit still owns scope finalizers. Route it through
        // the same bounded receipt flight used by explicit detach.
        this.terminateControl(active);
      } else {
        this.settleLocalControl(active);
      }
      const closing = this.streams.get(streamId);
      if (!closing) return;
      this.removeStream(streamId, closing.terminalId);
      this.handBackToObservePool(closing);
      this.emit({
        streamId,
        type: "closed",
        reason: code === 0 ? "exit" : `exit_${code ?? "null"}`,
      });
    });

    child.on("error", (error) => {
      const closing = this.streams.get(streamId);
      if (!closing) {
        // Generic ChildProcess errors are not proof of exit (kill/send and
        // remote lease writes can fail). Preserve the already-retained exact
        // generation authority so its TERM grace can still reach SIGKILL.
        this.terminateControl(active);
        return;
      }
      this.removeStream(streamId, closing.terminalId);
      this.terminateControl(active);
      this.handBackToObservePool(active);
      this.emit({
        streamId,
        type: "error",
        message: error.message,
      });
      this.emit({ streamId, type: "closed", reason: "child_error" });
    });

    return { ok: true, streamId, retained };
  }

  /**
   * herdr control protocol (verified against herdr client):
   *   { type: "terminal.input", bytes: "<base64>" }
   *   { type: "terminal.input", text: "<utf8>" }
   * Field name `data` is IGNORED → empty write, silent no-op (not an error).
   */
  input(streamId: string, dataBase64: string): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    return this.writeJson(stream.stream, {
      type: "terminal.input",
      bytes: dataBase64,
    });
  }

  /** Plaintext path — herdr accepts `text` without base64. */
  inputText(streamId: string, text: string): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    return this.writeJson(stream.stream, {
      type: "terminal.input",
      text,
    });
  }


  /**
   * Vellum-owned image paste (stock herdr only):
   *   1. stage bytes as a temp file on the stream's host (local FS or ssh write)
   *   2. paste the absolute path via stock `terminal.input` (bracketed paste)
   * No herdr protocol extensions.
   */
  async pasteImage(
    streamId: string,
    extension: string,
    dataBase64: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string; readonly path?: string }> {
    const opened = this.require(streamId);
    if (!opened.ok) return opened;
    // Capture host before await — stream may detach during remote stage.
    const hostId = opened.stream.hostId;
    const staged = await stageImageOnHost(hostId, extension, dataBase64, {
      stageRemote: this.stageRemote,
    });
    if (!staged.ok) return { ok: false, error: staged.error };
    // Re-bind after stage: close/takeover must not write a stale stdin.
    const live = this.require(streamId);
    if (!live.ok) return live;
    const written = this.writeJson(live.stream, {
      type: "terminal.input",
      text: pastePathPayload(staged.path),
    });
    if (!written.ok) return written;
    return { ok: true, path: staged.path };
  }

  resize(
    streamId: string,
    cols: number,
    rows: number,
  ): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    const nextCols = Number.isFinite(cols) ? Math.max(20, Math.floor(cols)) : 80;
    const nextRows = Number.isFinite(rows) ? Math.max(5, Math.floor(rows)) : 24;
    const written = this.writeJson(stream.stream, {
      type: "terminal.resize",
      cols: nextCols,
      rows: nextRows,
    });
    if (written.ok) {
      // Track last geometry so the post-detach observe re-attach matches.
      stream.stream.cols = nextCols;
      stream.stream.rows = nextRows;
    }
    return written;
  }

  /**
   * herdr control protocol: { type: "terminal.scroll", direction: "up"|"down", lines: N }
   * (not `delta` — that is rejected as missing field `direction`).
   *
   * `at` matters for mouse-reporting apps (grok, htop, …): herdr encodes an
   * SGR wheel event at that cell instead of moving host scrollback, so the
   * app scrolls the region under the pointer. Without it herdr defaults to
   * cell (0,0) and mouse-aware apps scroll the wrong region or nothing.
   */
  scroll(
    streamId: string,
    delta: number,
    at?: HerdrPointerCell,
  ): { readonly ok: boolean; readonly error?: string } {
    const stream = this.require(streamId);
    if (!stream.ok) return stream;
    const rawDelta = Number.isFinite(delta) ? Math.round(delta) : 1;
    const ticks = Math.max(1, Math.min(20, Math.abs(rawDelta) || 1));
    // Browser wheel: deltaY > 0 → scroll down; herdr uses direction up/down.
    const direction = rawDelta < 0 ? "up" : "down";
    const payload = JSON.stringify({
      type: "terminal.scroll",
      direction,
      lines: 1,
      ...(at
        ? {
            column: Math.max(0, Math.floor(Number.isFinite(at.column) ? at.column : 0)),
            row: Math.max(0, Math.floor(Number.isFinite(at.row) ? at.row : 0)),
            modifiers: (Number.isFinite(at.modifiers) ? at.modifiers : 0) & 0xff,
          }
        : {}),
    });
    // One command per wheel tick, batched into a single stdin write: stock
    // herdr emits one wheel report per command for mouse-reporting apps, so a
    // coalesced gesture keeps real per-tick semantics. Host scrollback apps
    // see the same total (N × 1 line). No patched binary required.
    // Routed through enqueueWrite (not a bare child.stdin.write) so a scroll
    // can never interleave into the middle of a paste's in-flight slices.
    return this.enqueueWrite(stream.stream, `${payload}\n`.repeat(ticks));
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
    return this.detachControlInternal(streamId, reason, true);
  }

  /**
   * Host removed/edited: detach every live control stream for hostId. Same
   * product lock as detachControl (release + SIGTERM client only), but never
   * hands the terminal back to the observe pool — the caller (host
   * reconciliation) is about to release those pooled entries too, so
   * re-pooling here would just spawn an observer for a host that is already
   * being torn down.
   */
  detachByHost(hostId: string, reason = "host_revoked"): void {
    for (const [streamId, active] of [...this.streams.entries()]) {
      if (active.hostId !== hostId) continue;
      try {
        this.detachControlInternal(streamId, reason, false);
      } catch {
        // One defective control/sink must not retain the rest of this host's
        // clients during endpoint revocation.
      }
    }
  }

  private detachControlInternal(
    streamId: string,
    reason: string,
    handBack: boolean,
  ): { readonly ok: boolean; readonly error?: string } {
    const active = this.streams.get(streamId);
    if (!active) {
      return { ok: true };
    }
    try {
      // Protocol: release input ownership; PTY continues on host.
      this.writeJson(active, { type: "terminal.release" });
    } catch {
      // ignore
    }
    // Local clients use their sealed child capability; remote clients close
    // only their captured Effect scope. Neither branch accepts a bare pid.
    this.removeStream(streamId, active.terminalId);
    this.terminateControl(active);
    if (handBack) this.handBackToObservePool(active);
    this.emit({ streamId, type: "closed", reason });
    return { ok: true };
  }

  /**
   * App/launchd shutdown: detach every control stream. Idempotent.
   * Product lock: quitting Vellum must not mass-kill herdr sessions.
   */
  async detachAllOnQuit(reason = "app_quit"): Promise<void> {
    this.shutDown = true;
    for (const streamId of [...this.streams.keys()]) {
      try {
        this.detachControl(streamId, reason);
      } catch {
        // Shutdown is a best-effort fan-out: one client may be defective, but
        // every other exact child capability still gets its detach attempt.
      }
    }
    // Observers own nothing on the host. Their tagged teardown is started
    // independently and never sends terminal.release (control-only).
    let poolStop: Promise<void> = Promise.resolve();
    try {
      poolStop = Promise.resolve(this.pool.stopAll()).catch(() => undefined);
    } catch {
      // Event/control cleanup above is already complete; never rethrow from
      // the app-quit boundary because an observe implementation misbehaved.
    }
    await Promise.all([poolStop, this.awaitRemoteCloses()]);
  }

  /** @deprecated use detachAllOnQuit — name kept so greps for closeAll still find the intent */
  closeAll(): void {
    void this.detachAllOnQuit("shutdown");
  }

  /**
   * Control closed for any reason: re-pool an observe stream for the terminal
   * (most-recent LRU slot) so switching back paints instantly from retention.
   * Never on app quit — detachAllOnQuit sets shutDown before detaching.
   */
  private handBackToObservePool(stream: ActiveStream): void {
    if (this.shutDown) return;
    this.pool.ensureObserve({
      hostId: stream.hostId,
      session: stream.session,
      terminalId: stream.terminalId,
      cols: stream.cols,
      rows: stream.rows,
    });
  }

  private require(
    streamId: string,
  ): { readonly ok: true; readonly stream: ActiveStream } | { readonly ok: false; readonly error: string } {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return { ok: false, error: "stream not active" };
    }
    return { ok: true, stream };
  }

  /** Drop stream from both indexes. Caller handles pool handoff / emit. */
  private removeStream(streamId: string, terminalId: string): void {
    this.streams.delete(streamId);
    if (this.byTerminal.get(terminalId) === streamId) {
      this.byTerminal.delete(terminalId);
    }
  }

  /** Record the central plane's close witness for one exact generation. */
  private settleLocalControl(stream: ActiveStream): void {
    const lifecycle = stream.lifecycle;
    if (lifecycle.kind === "remote-scope" || lifecycle.closed) return;
    lifecycle.closed = true;
    if (lifecycle.terminationTimer !== undefined) {
      clearTimeout(lifecycle.terminationTimer);
      lifecycle.terminationTimer = undefined;
    }
  }

  /**
   * Tagged teardown. The ActiveStream object is the generation key, so a
   * superseding stream can never be signalled or have its scope closed.
   */
  private terminateControl(stream: ActiveStream): void {
    const lifecycle = stream.lifecycle;
    if (lifecycle.kind === "remote-scope") {
      if (lifecycle.closeRequested) return;
      lifecycle.closeRequested = true;
      this.trackRemoteClose(lifecycle.close);
      return;
    }
    if (lifecycle.terminationRequested || lifecycle.closed) return;
    lifecycle.terminationRequested = true;
    lifecycle.terminate("herdr-control-detach");
    // Some test clients report close synchronously from termination.
    if (lifecycle.closed) return;
    const timer = setTimeout(() => {
      lifecycle.terminationTimer = undefined;
      if (lifecycle.closed) return;
      lifecycle.forceTerminate("herdr-control-grace-expired");
    }, CONTROL_CHILD_TERMINATION_GRACE_MS);
    lifecycle.terminationTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Normalize a structural remote closer into a contained receipt flight. */
  private trackRemoteClose(close: () => Promise<RemoteScopeCloseReceipt>): void {
    let closeFlight: Promise<RemoteScopeCloseReceipt>;
    try {
      closeFlight = Promise.resolve(close()).catch((error): RemoteScopeCloseReceipt => ({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    } catch (error) {
      closeFlight = Promise.resolve<RemoteScopeCloseReceipt>({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.pendingRemoteCloses.add(closeFlight);
    void closeFlight.finally(() => {
      this.pendingRemoteCloses.delete(closeFlight);
    });
  }

  private async awaitRemoteCloses(): Promise<void> {
    while (this.pendingRemoteCloses.size > 0) {
      await Promise.all([...this.pendingRemoteCloses]);
    }
  }

  private writeJson(
    stream: ActiveStream,
    payload: Record<string, unknown>,
  ): { readonly ok: boolean; readonly error?: string } {
    return this.enqueueWrite(stream, `${JSON.stringify(payload)}\n`);
  }

  /**
   * Single choke point for every write to a control child's stdin.
   * |- command order is preserved: a write issued while a prior (large,
   *    still-chunking) write is in flight queues behind it rather than
   *    racing straight through — a resize must never overtake a paste.
   * Small writes with nothing in flight take the exact synchronous path
   * writeJson always had (one write() call, try/catch around it).
   */
  private enqueueWrite(
    stream: ActiveStream,
    payload: string,
  ): { readonly ok: boolean; readonly error?: string } {
    if (!stream.pendingWrite && payload.length <= DEFAULT_WRITE_CHUNK_CHARS) {
      try {
        stream.child.stdin.write(payload);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const prior = stream.pendingWrite ?? Promise.resolve();
    const queued: Promise<void> = prior
      .catch(() => undefined)
      .then(() => writeChunked(stream.child.stdin, payload).catch(() => undefined));
    stream.pendingWrite = queued.finally(() => {
      if (stream.pendingWrite === queued) stream.pendingWrite = undefined;
    });
    return { ok: true };
  }

  /**
   * NDJSON line never terminated within the byte cap — a defective/wedged
   * child. Kill it; the close handler registered in open() emits this
   * stream's normal error+closed frames and hands the terminal back to the
   * observe pool, same as any other control-child death.
   */
  private handleInboundOverflow(streamId: string): void {
    const active = this.streams.get(streamId);
    if (!active || active.overflowed) return;
    active.overflowed = true;
    this.emit({
      streamId,
      type: "error",
      message: "herdr control stream exceeded max NDJSON buffer — killing unresponsive child",
    });
    this.terminateControl(active);
  }

  private handleLine(streamId: string, line: string): void {
    // Drop late IO after detach/supersede so IPC does not fan-out unowned frames.
    if (!this.streams.has(streamId)) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON diagnostics (protocol nags) — surface without killing stream.
      if (/input ignored|invalid json|error/i.test(line)) {
        this.emit({ streamId, type: "error", message: line.slice(0, 400) });
      }
      return;
    }
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "terminal.frame") {
      // First live control frame: renderer has fresher pixels than the pool's
      // retained observe frames — clear that terminal's retention.
      const active = this.streams.get(streamId);
      if (active && !active.firstFrameSeen) {
        active.firstFrameSeen = true;
        this.pool.clearRetention(active.terminalId);
      }
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
      const closing = this.streams.get(streamId);
      if (closing) {
        this.removeStream(streamId, closing.terminalId);
        this.terminateControl(closing);
        // Host reported the terminal genuinely closed — do NOT re-observe a
        // dead terminal; drop its pooled entry and retention instead.
        if (!this.shutDown) this.pool.releaseObserve(closing.terminalId);
      }
      return;
    }
  }

  private emit(frame: HerdrStreamFrame): void {
    try {
      this.sink?.(frame);
    } catch {
      // Renderer/event delivery is outside the process-lifetime trust
      // boundary. A throwing subscriber cannot interrupt detach or cleanup.
    }
  }
}
