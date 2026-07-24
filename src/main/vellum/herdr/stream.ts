import type { HerdrPointerCell, HerdrRetainedPayload } from "@shared/ipc";
import {
  ControlIoPhase,
  controlPhaseIsLive,
  controlPhaseRefusesWrite,
  encodeHerdrControlLine,
  herdrControlWriteFailed,
  herdrControlWriteOk,
  herdrControlWriteWire,
  herdrInputBytes,
  herdrInputText,
  herdrRelease,
  herdrResize,
  herdrScroll,
  inactiveControlError,
  normalizeControlGeometry,
  parseHerdrControlInbound,
  pipeControlError,
  sessionRecoveryCodeFromReason,
  type ControlIoPhase as ControlIoPhaseT,
  type HerdrControlWriteResult,
} from "@shared/terminal-session-domain";
import { isKnownHerdrHost } from "./hosts";
import { feedNdjson } from "./ndjson";
import { pastePathPayload, stageImageOnHost, type StageRemoteImage } from "./stage-image";
import type { AppProcessSignalReceipt } from "../app-process-plane";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  herdrShutdownMessage,
  type HerdrComponentShutdownReceipt,
  type HerdrShutdownCause,
  validateHerdrShutdownTimeout,
} from "./shutdown";

/** IPC-stable write result (message string) from domain typed result. */
export type HerdrStreamWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type { HerdrControlWriteResult };

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
  /** Domain SessionRecoveryCode for product reconnect policy. */
  readonly code?: string;
}

export type StreamSink = (frame: HerdrStreamFrame) => void;

const CONTROL_CHILD_TERMINATION_GRACE_MS = 1_500;

type LocalControlLifecycle = {
  readonly kind: "local-process";
  readonly terminate: (reason: string) => AppProcessSignalReceipt;
  readonly forceTerminate: (reason: string) => AppProcessSignalReceipt;
  readonly closedPromise: Promise<void>;
  readonly resolveClosed: () => void;
  terminationRequested: boolean;
  closed: boolean;
  termReceipt?: AppProcessSignalReceipt;
  forceReceipt?: AppProcessSignalReceipt;
  signalFailures: HerdrShutdownCause[];
  terminationTimer?: ReturnType<typeof setTimeout>;
};

type RemoteControlLifecycle = {
  readonly kind: "remote-scope";
  readonly close: () => Promise<RemoteScopeCloseReceipt>;
  closeRequested: boolean;
  closeFlight?: Promise<RemoteScopeCloseReceipt>;
  receipt?: RemoteScopeCloseReceipt;
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
   * Control I/O phase (domain). Live accepts stdin; Broken/Closed refuse writes
   * and suppress double emit on pipe/child races. Replaces writeBroken/ioFailed.
   */
  phase: ControlIoPhaseT;
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

/**
 * herdr `terminal session control|observe` child I/O surface.
 *
 * Grounded in herdr's client (`run_terminal_session_control` / `_observe`):
 * NDJSON commands on stdin, NDJSON frames on stdout, diagnostics on stderr.
 * Local spawns are real Node streams; remote Effect facades may omit optional
 * event hooks (treated as no-op attach).
 */
export interface HerdrClientIo {
  readonly stdin: {
    write(chunk: string): boolean;
    /** Real Node Writables (local spawn) and test PassThroughs support this;
     * the Effect-owned remote child does not — treated as never-backpressured. */
    once?(event: "drain", listener: () => void): unknown;
    /**
     * Async write failures (EPIPE after herdr control child exits) surface here,
     * not on ChildProcess "error". Optional so remote facades stay thin.
     */
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stdout: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
  readonly stderr: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Broken-pipe family on control child streams — never uncaught in main. */
export const isHerdrBrokenPipeError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "EPIPE" || code === "EIO" || code === "ERR_STREAM_DESTROYED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /EPIPE|broken pipe|ERR_STREAM_DESTROYED/i.test(message);
};

export type RemoteScopeCloseReceipt =
  | { readonly status: "closed" }
  | { readonly status: "timed-out"; readonly timeoutMs: number }
  | { readonly status: "failed"; readonly message: string };

export type HerdrSpawnedClient =
  | {
      readonly kind: "local-process";
      readonly child: HerdrClientIo;
      /** Exact central app-process capability, bound by the spawn factory. */
      readonly terminate: (reason: string) => AppProcessSignalReceipt;
      readonly forceTerminate: (reason: string) => AppProcessSignalReceipt;
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

export interface HerdrStreamManagerOptions {
  readonly terminationGraceMs?: number;
  readonly shutdownDrainTimeoutMs?: number;
  readonly manageObservePoolOnShutdown?: boolean;
}

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
  stopAll(): void | Promise<void | HerdrComponentShutdownReceipt>;
  drainOnQuit?(): Promise<HerdrComponentShutdownReceipt>;
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
 * Rejects on synchronous write failure (destroyed pipe); async EPIPE is
 * owned by the stdin "error" listener attached in open().
 */
export const writeChunked = (
  stdin: HerdrClientIo["stdin"],
  payload: string,
  chunkChars = DEFAULT_WRITE_CHUNK_CHARS,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let offset = 0;
    const pump = (): void => {
      try {
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
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
  private readonly localLifecycles = new Set<LocalControlLifecycle>();
  private readonly remoteLifecycles = new Set<RemoteControlLifecycle>();
  private readonly terminationGraceMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly manageObservePoolOnShutdown: boolean;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly operationFailures: HerdrShutdownCause[] = [];
  private drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  private cleanShutdownReceipt: HerdrComponentShutdownReceipt | undefined;
  /** Fires once a control stream is live for a terminal (message-delivery retry). */
  private openHook: ((terminalId: string) => void) | undefined;

  constructor(
    private readonly pool: ObservePoolHooks,
    private readonly spawnFn: HerdrSpawnFn,
    private readonly stageRemote: StageRemoteImage,
    opts: HerdrStreamManagerOptions = {},
  ) {
    this.terminationGraceMs = validateHerdrShutdownTimeout(
      opts.terminationGraceMs,
      CONTROL_CHILD_TERMINATION_GRACE_MS,
    );
    this.shutdownDrainTimeoutMs = validateHerdrShutdownTimeout(
      opts.shutdownDrainTimeoutMs,
      3_250,
    );
    this.manageObservePoolOnShutdown = opts.manageObservePoolOnShutdown ?? true;
  }

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
    const attachGeometry = normalizeControlGeometry(input.cols || 80, input.rows || 24);
    const args = [
      "terminal",
      "session",
      "control",
      input.terminalId,
      ...(input.takeover === false ? [] : ["--takeover"]),
      "--cols",
      String(attachGeometry.cols),
      "--rows",
      String(attachGeometry.rows),
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
        let resolveClosed!: () => void;
        const closedPromise = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        lifecycle = {
          kind: "local-process",
          terminate: spawned.terminate,
          forceTerminate: spawned.forceTerminate,
          closedPromise,
          resolveClosed,
          terminationRequested: false,
          closed: false,
          signalFailures: [],
        };
        this.localLifecycles.add(lifecycle);
      } else {
        lifecycle = {
          kind: "remote-scope",
          close: spawned.close,
          closeRequested: false,
        };
        this.remoteLifecycles.add(lifecycle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `failed to spawn control stream: ${message}` };
    }

    const geometry = normalizeControlGeometry(input.cols || 80, input.rows || 24);
    const active: ActiveStream = {
      streamId,
      hostId: input.hostId,
      session: input.session,
      terminalId: input.terminalId,
      child,
      lifetime: "session-owned",
      lifecycle,
      openedAt: Date.now(),
      cols: geometry.cols,
      rows: geometry.rows,
      firstFrameSeen: false,
      phase: ControlIoPhase.Live(),
    };
    try {
      // Control now provides frames: kill the terminal's observe child but keep
      // its retention until the first live control frame arrives (handleLine).
      this.pool.pauseForControl(input.terminalId);
      this.streams.set(streamId, active);
      this.byTerminal.set(input.terminalId, streamId);
      try {
        this.openHook?.(input.terminalId);
      } catch {
        // Presentation/message retry hooks cannot sink process ownership.
      }
    } catch (error) {
      this.removeStream(streamId, input.terminalId);
      this.terminateControl(active);
      return {
        ok: false,
        message: `failed to initialize control stream: ${herdrShutdownMessage(error)}`,
      };
    }

    try {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer = feedNdjson(buffer, chunk, (line) => this.handleLine(streamId, line), {
          onOverflow: () => this.handleInboundOverflow(streamId),
        });
      });
      // Async stream errors are not ChildProcess "error" events. Without sinks,
      // a late EPIPE after herdr exits paints Electron's main-process dialog.
      child.stdout.on("error", (error) => {
        this.handleControlIoError(streamId, active, "stdout", error);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (!this.streams.has(streamId)) return;
        // herdr often prints "herdr: … input ignored: …" on stderr (or stdout).
        // Stock client: `eprintln!("herdr: terminal session control input ignored: …")`.
        for (const text of chunk.split("\n").map((l) => l.trim()).filter(Boolean)) {
          this.emit({ streamId, type: "error", message: text.slice(0, 400) });
        }
      });
      child.stderr.on("error", (error) => {
        this.handleControlIoError(streamId, active, "stderr", error);
      });

      child.stdin.on?.("error", (error) => {
        this.handleControlIoError(streamId, active, "stdin", error);
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
        if (!closing) {
          // Detach / pipe path already removed + emitted closed — generation only.
          return;
        }
        // Overflow (and similar) leave the stream mapped until process exit so
        // the normal close frame still fires once — even though phase left Live.
        const reason =
          closing.phase._tag === "Broken" && closing.phase.reason === "overflow"
            ? "overflow"
            : code === 0
              ? "exit"
              : `exit_${code ?? "null"}`;
        closing.phase = ControlIoPhase.Closed({ reason });
        this.removeStream(streamId, closing.terminalId);
        this.handBackToObservePool(closing);
        this.emitClosed(streamId, reason);
      });

      child.on("error", (error) => {
        if (!controlPhaseIsLive(active.phase)) {
          this.terminateControl(active);
          return;
        }
        const closing = this.streams.get(streamId);
        if (!closing) {
          // Generic ChildProcess errors are not proof of exit (kill/send and
          // remote lease writes can fail). Preserve the already-retained exact
          // generation authority so its TERM grace can still reach SIGKILL.
          this.terminateControl(active);
          return;
        }
        closing.phase = ControlIoPhase.Broken({ reason: "child" });
        this.removeStream(streamId, closing.terminalId);
        this.terminateControl(active);
        this.handBackToObservePool(closing);
        this.emit({
          streamId,
          type: "error",
          message: error.message,
        });
        this.emitClosed(streamId, "child_error");
      });
    } catch (error) {
      this.removeStream(streamId, input.terminalId);
      this.terminateControl(active);
      return {
        ok: false,
        message: `failed to initialize control stream I/O: ${herdrShutdownMessage(error)}`,
      };
    }

    return { ok: true, streamId, retained };
  }

  /**
   * herdr control protocol (domain Schema + stock client):
   *   { type: "terminal.input", bytes: "<base64>" }
   *   { type: "terminal.input", text: "<utf8>" }
   * Field name `data` is IGNORED → empty write, silent no-op (not an error).
   */
  input(streamId: string, dataBase64: string): HerdrStreamWriteResult {
    return herdrControlWriteWire(this.writeCommand(streamId, herdrInputBytes(dataBase64)));
  }

  /** Plaintext path — herdr accepts `text` without base64. */
  inputText(streamId: string, text: string): HerdrStreamWriteResult {
    return herdrControlWriteWire(this.writeCommand(streamId, herdrInputText(text)));
  }


  /**
   * Vellum-owned image paste (stock herdr only):
   *   1. stage bytes as a temp file on the stream's host (local FS or ssh write)
   *   2. paste the absolute path via stock `terminal.input` (bracketed paste)
   * No herdr protocol extensions.
   */
  pasteImage(
    streamId: string,
    extension: string,
    dataBase64: string,
  ): Promise<HerdrStreamWriteResult & { readonly path?: string }> {
    if (this.shutDown) {
      return Promise.resolve(
        herdrControlWriteWire(
          herdrControlWriteFailed(
            inactiveControlError("herdr streams shut down (app quitting)"),
          ),
        ),
      );
    }
    return this.trackOperation(
      this.pasteImageOnce(streamId, extension, dataBase64),
      "control-operation-failed",
    );
  }

  private async pasteImageOnce(
    streamId: string,
    extension: string,
    dataBase64: string,
  ): Promise<HerdrStreamWriteResult & { readonly path?: string }> {
    const opened = this.require(streamId);
    if (!opened.ok) return herdrControlWriteWire(opened);
    // Capture host before await — stream may detach during remote stage.
    const hostId = opened.stream.hostId;
    const staged = await stageImageOnHost(hostId, extension, dataBase64, {
      stageRemote: this.stageRemote,
    });
    if (!staged.ok) return { ok: false, error: staged.error };
    // Re-bind after stage: close/takeover must not write a stale stdin.
    const live = this.require(streamId);
    if (!live.ok) return herdrControlWriteWire(live);
    const written = this.writeCommand(
      streamId,
      herdrInputText(pastePathPayload(staged.path)),
      live.stream,
    );
    if (!written.ok) return herdrControlWriteWire(written);
    return { ok: true, path: staged.path };
  }

  resize(streamId: string, cols: number, rows: number): HerdrStreamWriteResult {
    const stream = this.require(streamId);
    if (!stream.ok) return herdrControlWriteWire(stream);
    const next = normalizeControlGeometry(cols, rows);
    const written = this.writeCommand(
      streamId,
      herdrResize(next.cols, next.rows),
      stream.stream,
    );
    if (written.ok) {
      // Track last geometry so the post-detach observe re-attach matches.
      stream.stream.cols = next.cols;
      stream.stream.rows = next.rows;
    }
    return herdrControlWriteWire(written);
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
  ): HerdrStreamWriteResult {
    const stream = this.require(streamId);
    if (!stream.ok) return herdrControlWriteWire(stream);
    const rawDelta = Number.isFinite(delta) ? Math.round(delta) : 1;
    const ticks = Math.max(1, Math.min(20, Math.abs(rawDelta) || 1));
    // Browser wheel: deltaY > 0 → scroll down; herdr uses direction up/down.
    const direction = rawDelta < 0 ? "up" : "down";
    const line = encodeHerdrControlLine(
      herdrScroll({
        direction,
        lines: 1,
        ...(at
          ? {
              column: Math.max(0, Math.floor(Number.isFinite(at.column) ? at.column : 0)),
              row: Math.max(0, Math.floor(Number.isFinite(at.row) ? at.row : 0)),
              modifiers: (Number.isFinite(at.modifiers) ? at.modifiers : 0) & 0xff,
            }
          : {}),
      }),
    );
    // One command per wheel tick, batched into a single stdin write: stock
    // herdr emits one wheel report per command for mouse-reporting apps, so a
    // coalesced gesture keeps real per-tick semantics. Host scrollback apps
    // see the same total (N × 1 line). No patched binary required.
    // Routed through enqueueWrite (not a bare child.stdin.write) so a scroll
    // can never interleave into the middle of a paste's in-flight slices.
    return herdrControlWriteWire(this.enqueueWrite(stream.stream, line.repeat(ticks)));
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
  ): HerdrStreamWriteResult {
    const active = this.streams.get(streamId);
    if (!active) {
      return { ok: true };
    }
    try {
      // Protocol: release input ownership; PTY continues on host.
      if (controlPhaseIsLive(active.phase)) {
        void this.enqueueWrite(active, encodeHerdrControlLine(herdrRelease()));
      }
    } catch {
      // ignore
    }
    active.phase = ControlIoPhase.Closed({ reason });
    // Local clients use their sealed child capability; remote clients close
    // only their captured Effect scope. Neither branch accepts a bare pid.
    this.removeStream(streamId, active.terminalId);
    this.terminateControl(active);
    if (handBack) this.handBackToObservePool(active);
    this.emitClosed(streamId, reason);
    return { ok: true };
  }

  /**
   * App/launchd shutdown: detach every control stream. Idempotent.
   * Product lock: quitting Vellum must not mass-kill herdr sessions.
   */
  beginShutdown(): void {
    this.shutDown = true;
  }

  drainOnQuit(reason = "app_quit"): Promise<HerdrComponentShutdownReceipt> {
    this.beginShutdown();
    if (this.cleanShutdownReceipt) return Promise.resolve(this.cleanShutdownReceipt);
    if (this.drainFlight) return this.drainFlight;

    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      // Start every independent cleanup before awaiting any component.
      let poolDrain: Promise<HerdrComponentShutdownReceipt>;
      try {
        poolDrain = !this.manageObservePoolOnShutdown
          ? Promise.resolve(cleanHerdrComponentReceipt())
          : this.pool.drainOnQuit
            ? Promise.resolve(this.pool.drainOnQuit())
            : Promise.resolve(this.pool.stopAll()).then((receipt) =>
                receipt && typeof receipt === "object" && "clean" in receipt
                  ? receipt as HerdrComponentShutdownReceipt
                  : cleanHerdrComponentReceipt(),
              );
      } catch (error) {
        poolDrain = Promise.resolve(herdrComponentReceipt(1, [{
          code: "observe-pool-stop-failed",
          message: herdrShutdownMessage(error),
        }]));
      }

      const fanoutCauses: HerdrShutdownCause[] = [];
      for (const streamId of [...this.streams.keys()]) {
        try {
          this.detachControl(streamId, reason);
        } catch (error) {
          fanoutCauses.push({
            code: "control-detach-failed",
            message: herdrShutdownMessage(error),
          });
        }
      }

      // A prior bounded close may have timed out. Retry the same idempotent
      // scope closer so a later real Scope.close witness can converge clean.
      for (const lifecycle of this.remoteLifecycles) {
        this.trackRemoteClose(lifecycle);
      }

      const localWait = awaitHerdrPromiseFixedPoint(
        () => [...this.localLifecycles].map((lifecycle) => lifecycle.closedPromise),
        this.shutdownDrainTimeoutMs,
      );
      const remoteWait = awaitHerdrPromiseFixedPoint(
        () => [...this.remoteLifecycles]
          .flatMap((lifecycle) => lifecycle.closeFlight ? [lifecycle.closeFlight] : []),
        this.shutdownDrainTimeoutMs,
      );
      const operationWait = awaitHerdrPromiseFixedPoint(
        () => [...this.activeOperations],
        this.shutdownDrainTimeoutMs,
      );
      const [poolResult, localResult, remoteResult, operationResult] = await Promise.allSettled([
        poolDrain,
        localWait,
        remoteWait,
        operationWait,
      ]);

      const causes = [...fanoutCauses];
      let poolRetained = 0;
      if (poolResult.status === "rejected") {
        poolRetained = 1;
        causes.push({
          code: "observe-pool-drain-failed",
          message: herdrShutdownMessage(poolResult.reason),
        });
      } else {
        poolRetained = poolResult.value.retained;
        causes.push(...poolResult.value.causes.map((cause) => ({
          code: `observe-pool:${cause.code}`,
          message: cause.message,
        })));
      }

      for (const lifecycle of this.localLifecycles) {
        causes.push(...lifecycle.signalFailures);
        const refusal = lifecycle.forceReceipt ?? lifecycle.termReceipt;
        if (refusal?.attempted === false) {
          causes.push({
            code: "control-local-signal-refused",
            message: refusal.decision.ok
              ? "central process plane did not attempt the requested signal"
              : refusal.decision.reason,
          });
        }
      }
      if (localResult.status === "rejected") {
        causes.push({
          code: "control-local-close-wait-failed",
          message: herdrShutdownMessage(localResult.reason),
        });
      } else if (!localResult.value || this.localLifecycles.size > 0) {
        causes.push({
          code: "control-local-close-retained",
          message: `${this.localLifecycles.size} local control client(s) lack an exact close witness`,
        });
      }

      for (const lifecycle of this.remoteLifecycles) {
        const receipt = lifecycle.receipt;
        if (receipt?.status === "failed") {
          causes.push({ code: "control-remote-close-failed", message: receipt.message });
        } else if (receipt?.status === "timed-out") {
          causes.push({
            code: "control-remote-close-timed-out",
            message: `remote control scope did not close within ${receipt.timeoutMs}ms`,
          });
        } else if (receipt === undefined) {
          causes.push({
            code: "control-remote-close-retained",
            message: "remote control scope close did not produce a bounded receipt",
          });
        }
      }
      if (remoteResult.status === "rejected") {
        causes.push({
          code: "control-remote-close-wait-failed",
          message: herdrShutdownMessage(remoteResult.reason),
        });
      } else if (!remoteResult.value && this.remoteLifecycles.size > 0) {
        causes.push({
          code: "control-remote-close-retained",
          message: `${this.remoteLifecycles.size} remote control scope(s) remain retained`,
        });
      }

      causes.push(...this.operationFailures);
      if (operationResult.status === "rejected") {
        causes.push({
          code: "control-operation-wait-failed",
          message: herdrShutdownMessage(operationResult.reason),
        });
      } else if (!operationResult.value || this.activeOperations.size > 0) {
        causes.push({
          code: "control-operation-retained",
          message: `${this.activeOperations.size} admitted control operation(s) remain unsettled`,
        });
      }

      const retained = poolRetained + this.localLifecycles.size +
        this.remoteLifecycles.size + this.activeOperations.size;
      const receipt = retained === 0 && causes.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(retained, causes);
      if (receipt.clean) this.cleanShutdownReceipt = receipt;
      return receipt;
    })();
    this.drainFlight = flight;
    void flight.finally(() => {
      if (this.drainFlight === flight) this.drainFlight = undefined;
    });
    return flight;
  }

  detachAllOnQuit(reason = "app_quit"): Promise<HerdrComponentShutdownReceipt> {
    return this.drainOnQuit(reason);
  }

  /** @deprecated use drainOnQuit — kept for legacy callers. */
  closeAll(): Promise<HerdrComponentShutdownReceipt> {
    return this.drainOnQuit("shutdown");
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
  ):
    | { readonly ok: true; readonly stream: ActiveStream }
    | { readonly ok: false; readonly cause: ReturnType<typeof inactiveControlError> } {
    if (this.shutDown) {
      return {
        ok: false,
        cause: inactiveControlError("herdr streams shut down (app quitting)"),
      };
    }
    const stream = this.streams.get(streamId);
    if (!stream || controlPhaseRefusesWrite(stream.phase)) {
      return {
        ok: false,
        cause: inactiveControlError(
          !stream ? "stream not active" : "herdr control stdin is closed",
        ),
      };
    }
    return { ok: true, stream };
  }

  private trackOperation<T>(operation: Promise<T>, code: string): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      (error) => {
        this.activeOperations.delete(operation);
        if (this.shutDown) {
          this.operationFailures.push({ code, message: herdrShutdownMessage(error) });
        }
      },
    );
    return operation;
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
    lifecycle.resolveClosed();
    this.localLifecycles.delete(lifecycle);
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
      this.trackRemoteClose(lifecycle);
      return;
    }
    if (lifecycle.terminationRequested || lifecycle.closed) return;
    lifecycle.terminationRequested = true;
    try {
      lifecycle.termReceipt = lifecycle.terminate("herdr-control-detach");
    } catch (error) {
      lifecycle.signalFailures.push({
        code: "control-local-term-failed",
        message: herdrShutdownMessage(error),
      });
    }
    // Some test clients report close synchronously from termination.
    if (lifecycle.closed) return;
    const timer = setTimeout(() => {
      lifecycle.terminationTimer = undefined;
      if (lifecycle.closed) return;
      try {
        lifecycle.forceReceipt = lifecycle.forceTerminate("herdr-control-grace-expired");
      } catch (error) {
        lifecycle.signalFailures.push({
          code: "control-local-force-failed",
          message: herdrShutdownMessage(error),
        });
      }
    }, this.terminationGraceMs);
    lifecycle.terminationTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Normalize a structural remote closer into a contained receipt flight. */
  private trackRemoteClose(lifecycle: RemoteControlLifecycle): void {
    if (lifecycle.closeFlight) return;
    let closeFlight: Promise<RemoteScopeCloseReceipt>;
    try {
      closeFlight = Promise.resolve(lifecycle.close()).catch((error): RemoteScopeCloseReceipt => ({
        status: "failed",
        message: herdrShutdownMessage(error),
      }));
    } catch (error) {
      closeFlight = Promise.resolve<RemoteScopeCloseReceipt>({
        status: "failed",
        message: herdrShutdownMessage(error),
      });
    }
    lifecycle.closeFlight = closeFlight;
    void closeFlight.then((receipt) => {
      lifecycle.receipt = receipt;
      if (receipt.status === "closed") {
        this.remoteLifecycles.delete(lifecycle);
      } else if (lifecycle.closeFlight === closeFlight) {
        // Keep the lifecycle authority, but permit a later drain to ask the
        // same idempotent closer for an updated terminal receipt.
        lifecycle.closeFlight = undefined;
      }
    });
  }

  /**
   * Encode a domain outbound command and offer it to a live stream's stdin.
   * When `active` is provided, skip a second map lookup (paste re-bind path).
   */
  private writeCommand(
    streamId: string,
    command: Parameters<typeof encodeHerdrControlLine>[0],
    active?: ActiveStream,
  ): HerdrControlWriteResult {
    if (active) {
      return this.enqueueWrite(active, encodeHerdrControlLine(command));
    }
    const req = this.require(streamId);
    if (!req.ok) return herdrControlWriteFailed(req.cause);
    return this.enqueueWrite(req.stream, encodeHerdrControlLine(command));
  }

  /**
   * Single choke point for every write to a control child's stdin.
   * |- command order is preserved: a write issued while a prior (large,
   *    still-chunking) write is in flight queues behind it rather than
   *    racing straight through — a resize must never overtake a paste.
   * Small writes with nothing in flight take the exact synchronous path
   * writeJson always had (one write() call, try/catch around it).
   * |- refuses write when phase is not Live (domain).
   */
  private enqueueWrite(
    stream: ActiveStream,
    payload: string,
  ): HerdrControlWriteResult {
    if (controlPhaseRefusesWrite(stream.phase)) {
      return herdrControlWriteFailed(
        inactiveControlError("herdr control stdin is closed"),
      );
    }
    if (!stream.pendingWrite && payload.length <= DEFAULT_WRITE_CHUNK_CHARS) {
      try {
        stream.child.stdin.write(payload);
        return herdrControlWriteOk();
      } catch (error) {
        this.handleControlIoError(
          stream.streamId,
          stream,
          "stdin",
          error instanceof Error ? error : new Error(String(error)),
        );
        return herdrControlWriteFailed(
          pipeControlError(
            "stdin",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    const prior = stream.pendingWrite ?? Promise.resolve();
    const queued = prior
      .catch(() => undefined)
      .then(async () => {
        if (controlPhaseRefusesWrite(stream.phase)) return;
        try {
          await writeChunked(stream.child.stdin, payload);
        } catch (error) {
          this.handleControlIoError(
            stream.streamId,
            stream,
            "stdin",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    const tracked = this.trackOperation(queued, "control-write-failed");
    stream.pendingWrite = tracked;
    void tracked.finally(() => {
      if (stream.pendingWrite === tracked) stream.pendingWrite = undefined;
    });
    return herdrControlWriteOk();
  }

  /**
   * NDJSON line never terminated within the byte cap — a defective/wedged
   * child. Kill it; the close handler registered in open() emits this
   * stream's normal error+closed frames and hands the terminal back to the
   * observe pool, same as any other control-child death.
   */
  private handleInboundOverflow(streamId: string): void {
    const active = this.streams.get(streamId);
    if (!active || active.overflowed || !controlPhaseIsLive(active.phase)) return;
    active.overflowed = true;
    active.phase = ControlIoPhase.Broken({ reason: "overflow" });
    this.emit({
      streamId,
      type: "error",
      message: "herdr control stream exceeded max NDJSON buffer — killing unresponsive child",
    });
    this.terminateControl(active);
  }

  /**
   * Contain async stream I/O failures (especially stdin EPIPE after herdr
   * control exits mid-write). herdr's control client maps stdin NDJSON →
   * socket; when that process dies, Node emits "error" on the Writable, not
   * on ChildProcess — an unowned listener becomes Electron's main dialog.
   *
   * Idempotent with close/child-error: first path wins emit; later paths only
   * settle generation authority. Phase leaves Live so further writes fail closed.
   */
  private handleControlIoError(
    streamId: string,
    active: ActiveStream,
    channel: "stdin" | "stdout" | "stderr",
    error: Error,
  ): void {
    if (!controlPhaseIsLive(active.phase)) {
      this.terminateControl(active);
      return;
    }
    const closing = this.streams.get(streamId);
    if (!closing) {
      // Already detached (common: terminal.release write races child exit).
      // Swallow — do not re-emit; still drive generation teardown.
      active.phase = ControlIoPhase.Broken({ reason: "pipe" });
      this.terminateControl(active);
      return;
    }
    const pipe = isHerdrBrokenPipeError(error);
    closing.phase = ControlIoPhase.Broken({ reason: pipe ? "pipe" : "io" });
    this.removeStream(streamId, closing.terminalId);
    this.terminateControl(closing);
    this.handBackToObservePool(closing);
    this.emit({
      streamId,
      type: "error",
      message: pipe
        ? `herdr control ${channel} pipe broken: ${error.message}`
        : `herdr control ${channel}: ${error.message}`,
    });
    this.emitClosed(streamId, pipe ? "pipe_broken" : `${channel}_error`);
  }

  private handleLine(streamId: string, line: string): void {
    // Drop late IO after detach/supersede so IPC does not fan-out unowned frames.
    if (!this.streams.has(streamId)) return;
    const inbound = parseHerdrControlInbound(line);
    if (!inbound) {
      // Non-JSON diagnostics (protocol nags) — surface without killing stream.
      if (/input ignored|invalid json|error/i.test(line)) {
        this.emit({ streamId, type: "error", message: line.slice(0, 400) });
      }
      return;
    }
    if (inbound.type === "terminal.frame") {
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
        bytes: inbound.bytes,
        encoding: inbound.encoding ?? "ansi",
        full: inbound.full,
        width: inbound.width,
        height: inbound.height,
        seq: inbound.seq,
      });
      return;
    }
    if (inbound.type === "terminal.closed") {
      this.emitClosed(streamId, inbound.reason ?? "closed");
      const closing = this.streams.get(streamId);
      if (closing) {
        closing.phase = ControlIoPhase.Closed({ reason: inbound.reason ?? "closed" });
        this.removeStream(streamId, closing.terminalId);
        this.terminateControl(closing);
        // Host reported the terminal genuinely closed — do NOT re-observe a
        // dead terminal; drop its pooled entry and retention instead.
        if (!this.shutDown) this.pool.releaseObserve(closing.terminalId);
      }
      return;
    }
  }

  private emitClosed(streamId: string, reason: string): void {
    this.emit({
      streamId,
      type: "closed",
      reason,
      code: sessionRecoveryCodeFromReason(reason),
    });
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
