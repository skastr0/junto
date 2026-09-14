/**
 * One headless xterm per live local terminal session.
 * Fed from LocalSessionHost.observeData — every PTY byte with a seq.
 *
 * @xterm/headless is CommonJS with no ESM export map. electron-vite externalizes
 * deps, so a named ESM import dies at app link time with
 * "Named export 'Terminal' not found". Load via createRequire (works in Node +
 * Electron main); Vite in-process interop hid this from unit tests.
 */

import { createRequire } from "node:module";
import {
  applyDecPrivateMode,
  buildMouseEncodingEscape,
  idleAttachModes,
  type TerminalAttachModes,
} from "@shared/term-attach-modes";
import { sanitizeTitle } from "./sanitize";
import {
  afterLastHorizontalRule,
  bottomNonEmptyLines,
  footerLine,
  promptBoxBody,
  abovePromptBox,
} from "./regions";
import type {
  ObserverGridSnapshot,
  ObserverListener,
  ObserverSignals,
  SessionObserverOptions,
} from "./types";

const require = createRequire(import.meta.url);
// CJS package: require() returns { Terminal }. Do not use ESM named import.
// Structural typing only — full @xterm/headless types are ESM-named and break
// the Electron main link when imported.
type HeadlessTerminal = {
  cols: number;
  rows: number;
  /** Live-writable option bag. `scrollback` is the retained-history cap. */
  options: { scrollback: number };
  unicode: { activeVersion: string; versions: string[] };
  buffer: {
    active: {
      baseY: number;
      cursorX: number;
      cursorY: number;
      viewportY: number;
      length: number;
      getLine: (y: number) =>
        | { translateToString: (trimRight?: boolean, start?: number, end?: number) => string }
        | undefined;
    };
  };
  parser: {
    registerOscHandler: (
      ident: number,
      cb: (data: string) => boolean,
    ) => { dispose: () => void };
    registerCsiHandler: (
      id: { prefix?: string; intermediates?: string; final: string },
      cb: (params: Array<number | number[]>) => boolean,
    ) => { dispose: () => void };
  };
  write: (data: string, cb?: () => void) => void;
  loadAddon: (addon: { activate: (terminal: HeadlessTerminal) => void; dispose: () => void }) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
};
const { Terminal } = require("@xterm/headless") as {
  Terminal: new (options?: Record<string, unknown>) => HeadlessTerminal;
};
type HeadlessSerializeAddon = {
  activate: (terminal: HeadlessTerminal) => void;
  serialize: (options?: {
    readonly scrollback?: number;
    readonly excludeModes?: boolean;
    readonly excludeAltBuffer?: boolean;
  }) => string;
  dispose: () => void;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => HeadlessSerializeAddon;
};

/**
 * Stock @xterm/headless ships only Unicode version "6". Version "11" requires
 * @xterm/addon-unicode11 on *both* headless and renderer grids. Pin to "6"
 * until that addon is loaded everywhere — a silent try/catch was a false
 * guarantee (assignment always threw for "11").
 */
const DEFAULT_UNICODE = "6" as const;

/**
 * Sampling floor for observer grid writes, in milliseconds.
 *
 * A headless `term.write` costs ~1.17ms of VT parse per call on a 200x50 grid
 * (measured), dominated by per-write overhead rather than byte count, while the
 * viewport snapshot that follows costs ~0.085ms. Batching the writes is
 * therefore the whole win: under load the grid is written at most once per
 * interval, ~5 parses/second/session, no matter how many chunks node-pty
 * delivers.
 *
 * Bytes are never dropped — VT is stateful, so a skipped chunk corrupts the
 * grid. The floor only decides *when* the queued bytes are written, always in
 * arrival order and always in full.
 */
export const DEFAULT_OBSERVER_WRITE_INTERVAL_MS = 200;

/**
 * Retained scrollback while a surface is attached — the depth an operator can
 * scroll back through in a node they have open. Unchanged from the value every
 * session used to carry all the time.
 */
export const OBSERVER_WATCHED_SCROLLBACK = 50_000;

/**
 * Retained scrollback while NO surface is attached.
 *
 * The seat signal never reads scrollback: `buildSnapshot` walks the viewport
 * (`rows` lines from `viewportY`), and every rule region — `whole_recent`,
 * `bottom_non_empty_lines`, `footer_line`, `prompt_box_body`,
 * `after_last_horizontal_rule` — is computed from those lines. Scrollback
 * exists solely so `attachScreen` can hand a reopened node its history.
 *
 * Retaining that history for a node nobody has open is what does not scale.
 * Measured on a 200x50 grid filled to its cap: ~180MB RSS per session at
 * 50,000 lines versus ~19MB at 2,000 — 48 carrying terminals is the
 * difference between ~8.6GB and ~0.9GB. Serializing it on attach is the same
 * curve: 234ms/1.27MB versus 18.5ms/87KB for the identical visible screen.
 *
 * 2,000 is `tmux`'s own `history-limit` default, and is three orders of
 * magnitude above what any rule region reads (largest `regionN` is 16).
 */
export const OBSERVER_UNWATCHED_SCROLLBACK = 2_000;

let processWriteIntervalMs: number = DEFAULT_OBSERVER_WRITE_INTERVAL_MS;

const clampInterval = (ms: number): number =>
  Number.isFinite(ms)
    ? Math.max(0, Math.min(2_000, Math.floor(ms)))
    : DEFAULT_OBSERVER_WRITE_INTERVAL_MS;

/** Current process-wide observer sampling floor (ms). */
export const getObserverWriteIntervalMs = (): number => processWriteIntervalMs;

/**
 * Set the process-wide observer sampling floor (ms, clamped to 0..2000).
 * Live observers read this on every flush decision, so raising it as the
 * session count grows takes effect immediately. Per-session overrides go
 * through `SessionObserver.setWriteIntervalMs`.
 */
export const setObserverWriteIntervalMs = (ms: number): void => {
  processWriteIntervalMs = clampInterval(ms);
};

/**
 * OSC introducer. OSC 0/2 (title) and OSC 9 (progress) are the primary seat
 * signal on every harness, and the seat state machine is edge-driven: holding
 * a title flip behind the sampling floor would turn a live factory signal into
 * a sampled one. Grid churn is sampled; signal bytes are not.
 */
const OSC_INTRODUCER = "\u001b]";

/**
 * DEC private mode set/reset introducer (CSI ? ... h|l). Carries alt-screen,
 * bracketed paste, and the negotiated mouse encoding — all seat-observation
 * state, all edge-driven.
 */
const DEC_PRIVATE_INTRODUCER = "\u001b[?";

const carriesSignal = (data: string): boolean =>
  data.includes(OSC_INTRODUCER) || data.includes(DEC_PRIVATE_INTRODUCER);

export class SessionObserver {
  readonly bindingId: string;
  readonly epoch: string;
  private readonly term: HeadlessTerminal;
  private readonly serializer: HeadlessSerializeAddon;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly listeners = new Set<ObserverListener>();
  private title = "";
  private osc9 = "";
  private modes: TerminalAttachModes = idleAttachModes();
  private seq = 0n;
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Bytes received while a write was in flight, oldest first. */
  private pending: string[] = [];
  /** Journal seq of the newest buffered chunk — pinned when that write lands. */
  private pendingSeq: bigint | undefined;
  private writeInFlight = false;
  /** Per-session override of the sampling floor; falls back to the process value. */
  private writeIntervalOverride: number | undefined;
  /** When the last write was handed to the grid. Undefined until the first one. */
  private lastWriteStartedAt: number | undefined;
  /** Armed only while buffered bytes are waiting out the sampling floor. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Buffered bytes carry an OSC / DEC-private edge — never hold those back. */
  private pendingSignal = false;
  /** Last time a chunk arrived while the grid was mid-write (producer > parser). */
  private lastBacklogAt: number | undefined;
  /** Retained scrollback while at least one surface is attached. */
  private readonly watchedScrollback: number;
  /** Retained scrollback while nobody is looking at this session. */
  private readonly unwatchedScrollback: number;
  /** Cap currently applied to the grid. */
  private currentScrollback: number;
  /** Attached surfaces (renderer leases). Zero means nobody is painting this. */
  private surfaces = 0;
  /** Set once if the grid refused a live scrollback write — warn once, not per attach. */
  private scrollbackTierFailed = false;

  constructor(opts: SessionObserverOptions) {
    this.bindingId = opts.bindingId;
    this.epoch = opts.epoch;
    const cols = Math.max(20, Math.min(300, opts.cols));
    const rows = Math.max(5, Math.min(120, opts.rows));
    // Long sessions: retain a deep scrollback in the headless terminal so the
    // canonical VT serializer can restore the complete terminal state — but
    // only while a surface is actually attached. See
    // OBSERVER_UNWATCHED_SCROLLBACK for why the unwatched tier is bounded.
    this.watchedScrollback = Math.max(
      opts.scrollback ?? OBSERVER_WATCHED_SCROLLBACK,
      rows * 4,
      200,
    );
    this.unwatchedScrollback = Math.min(
      this.watchedScrollback,
      Math.max(OBSERVER_UNWATCHED_SCROLLBACK, rows * 4, 200),
    );
    this.currentScrollback = this.unwatchedScrollback;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: this.currentScrollback,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    const wanted = opts.unicodeVersion ?? DEFAULT_UNICODE;
    try {
      this.term.unicode.activeVersion = wanted;
    } catch (err) {
      // Never silent: false pin is worse than default.
      console.warn(
        `[term-observer] unicode.activeVersion=${JSON.stringify(wanted)} failed ` +
          `(active=${JSON.stringify(this.term.unicode?.activeVersion)}; ` +
          `versions=${JSON.stringify(this.term.unicode?.versions)}); ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.installHandlers();
  }

  private installHandlers(): void {
    // OSC 0 and OSC 2 — window / icon title (primary state feed on all harnesses).
    this.disposables.push(
      this.term.parser.registerOscHandler(0, (data) => {
        this.title = sanitizeTitle(data);
        return true;
      }),
    );
    this.disposables.push(
      this.term.parser.registerOscHandler(2, (data) => {
        this.title = sanitizeTitle(data);
        return true;
      }),
    );
    // OSC 9 — Claude 9;4;*, Codex ]9;<msg>, Grok 9;4 binary.
    this.disposables.push(
      this.term.parser.registerOscHandler(9, (data) => {
        this.osc9 = data.slice(0, 512);
        return true;
      }),
    );
    // CSI ? Pm h / l — DEC private modes (prefix `?`).
    // Track paste/sync/alt-screen/mouse for seat-state observation. Reopen
    // state itself is restored by the canonical VT serializer.
    this.disposables.push(
      this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        for (const mode of this.flatParams(params)) {
          this.modes = applyDecPrivateMode(this.modes, mode, true);
        }
        return false; // let xterm also process
      }),
    );
    this.disposables.push(
      this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        for (const mode of this.flatParams(params)) {
          this.modes = applyDecPrivateMode(this.modes, mode, false);
        }
        return false;
      }),
    );
  }

  private flatParams(
    params: ReadonlyArray<number | number[]>,
  ): readonly number[] {
    const out: number[] = [];
    for (const p of params) {
      if (typeof p === "number" && Number.isFinite(p)) out.push(p);
      else if (Array.isArray(p)) {
        for (const n of p) {
          if (typeof n === "number" && Number.isFinite(n)) out.push(n);
        }
      }
    }
    return out;
  }

  /**
   * Feed PTY bytes. seq is the plane's journal sequence.
   *
   * Writes are self-clocking: a chunk arriving with no write in flight goes
   * straight through, and anything arriving behind an in-flight write is
   * coalesced into a single follow-up write. node-pty hands over ~50k
   * chunks/sec on dense output (build logs, test runs) with no read batching,
   * while a write + snapshot per chunk drains at ~800/sec — so one second of
   * that output took ~65s to absorb and pinned a main-process core long after
   * the child went quiet. Coalescing makes the batch grow with the load
   * instead, with no added latency on a quiet seat.
   *
   * On top of that, a sampling floor (`DEFAULT_OBSERVER_WRITE_INTERVAL_MS`)
   * bounds how often the grid is written while the producer outruns the
   * parser. Without it the write-callback loop re-writes the moment the last
   * parse lands, ~800/sec; with it the follow-up waits out the interval and
   * absorbs the whole window as one batch, ~5 parses/sec. Held bytes are
   * always written in full and in order — VT is stateful, so skipping a chunk
   * would corrupt the grid.
   *
   * The floor is deliberately narrow. It engages only while chunks are landing
   * mid-write; a quiet seat, and the first chunk after a stream stops, are
   * written immediately, and bytes carrying a seat signal (OSC title / OSC 9 /
   * DEC private mode) are never held at all. The seat state machine is
   * edge-driven and is a live factory signal, so grid churn is what gets
   * sampled — never a state edge.
   *
   * The same bytes are written in the same order, so the grid is
   * byte-identical — only the number of write callbacks and snapshots
   * changes. This observer exists to derive seat status (idle / working /
   * attention), which no human reads faster than a few times a second, so
   * per-chunk granularity bought nothing. Display is a separate path with
   * its own coalescer; nothing here affects what the operator sees typed.
   */
  feed(data: string, seq: bigint): void {
    if (this.disposed) return;
    this.pending.push(data);
    this.pendingSeq = seq;
    if (!this.pendingSignal && carriesSignal(data)) this.pendingSignal = true;
    // Bytes landing mid-write mean the producer is outrunning the parser —
    // the regime the sampling floor exists for.
    if (this.writeInFlight) {
      this.lastBacklogAt = Date.now();
      return;
    }
    // Idle seat: write straight through, no added latency.
    this.maybeFlush();
  }

  /** Sampling floor in effect for this session (ms). */
  get writeIntervalMs(): number {
    return this.writeIntervalOverride ?? processWriteIntervalMs;
  }

  /**
   * Override the sampling floor for this session (ms, clamped to 0..2000).
   * Pass `undefined` to fall back to the process-wide value. Takes effect on
   * the bytes already waiting, so lowering it releases them immediately.
   */
  setWriteIntervalMs(ms: number | undefined): void {
    this.writeIntervalOverride = ms === undefined ? undefined : clampInterval(ms);
    this.clearFlushTimer();
    this.maybeFlush();
  }

  /**
   * Flush now if the sampling floor has elapsed since the last write; otherwise
   * arm a single timer for the remainder. Bytes only ever wait — they are
   * never dropped, and they keep their arrival order.
   */
  private maybeFlush(): void {
    if (this.disposed || this.writeInFlight || this.pending.length === 0) return;
    const wait = this.floorWaitMs();
    if (wait <= 0) {
      this.flushPending();
      return;
    }
    if (this.flushTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.flushTimer = undefined;
      this.maybeFlush();
    }, wait);
    // Never hold the process (or a test runner) open for a grid write.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.flushTimer = timer;
  }

  /**
   * How long the buffered bytes must wait, in ms. Zero means write now.
   *
   * The floor engages only in the regime it was measured for: a stream dense
   * enough that chunks land while the grid is still parsing the last batch.
   * A quiet seat, and the first chunk after a stream stops, never wait — and
   * seat-signal bytes never wait at all.
   */
  private floorWaitMs(): number {
    if (this.pendingSignal) return 0;
    if (this.lastWriteStartedAt === undefined) return 0;
    const now = Date.now();
    const hot =
      this.lastBacklogAt !== undefined &&
      now - this.lastBacklogAt <= this.writeIntervalMs;
    if (!hot) return 0;
    return this.writeIntervalMs - (now - this.lastWriteStartedAt);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /**
   * Write buffered bytes to the grid as one write. Seq is pinned when that
   * write lands — not at enqueue — so a snapshot never claims a seq the grid
   * has not absorbed.
   */
  private flushPending(): void {
    this.clearFlushTimer();
    if (this.disposed || this.pending.length === 0) return;
    this.lastWriteStartedAt = Date.now();
    const data = this.pending.join("");
    const seq = this.pendingSeq;
    this.pending = [];
    this.pendingSeq = undefined;
    this.pendingSignal = false;
    this.writeInFlight = true;
    this.writeQueue = this.writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (this.disposed) {
              this.writeInFlight = false;
              resolve();
              return;
            }
            this.term.write(data, () => {
              if (seq !== undefined) this.seq = seq;
              this.writeInFlight = false;
              this.emitSnapshot();
              // Everything that arrived during this write goes out as one
              // follow-up write, so the batch grows with the load — but no
              // sooner than the sampling floor allows.
              this.maybeFlush();
              resolve();
            });
          }),
      )
      .catch(() => {
        this.writeInFlight = false;
      });
  }

  /**
   * Flush buffered bytes and wait for the grid to absorb them.
   *
   * This deliberately bypasses the sampling floor: a caller awaiting settled
   * state must observe every byte fed so far, and must never block on a timer
   * (a settle that waits for its own scheduled write deadlocks under fake
   * timers).
   */
  private async settled(): Promise<void> {
    this.clearFlushTimer();
    this.flushPending();
    await this.writeQueue;
  }

  /** Resize the headless grid to match the live PTY. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = Math.max(20, Math.min(300, cols));
    const r = Math.max(5, Math.min(120, rows));
    // Buffered bytes belong to the pre-resize geometry — queue them first.
    this.flushPending();
    this.term.resize(c, r);
    this.emitSnapshot();
  }

  /**
   * A surface (renderer lease) started painting this session — retain the full
   * scrollback from here on. Refcounted: two viewers on one binding do not
   * fight, and the tier only drops when the last one leaves.
   *
   * Raising the cap does not resurrect lines already trimmed; it only stops
   * trimming from now on. That is the deliberate trade — a node nobody has
   * open keeps the bounded window, and opening it starts keeping everything.
   */
  retainSurface(): void {
    if (this.disposed) return;
    this.surfaces += 1;
    this.applyScrollbackTier();
  }

  /** A surface stopped painting. At zero, fall back to the bounded window. */
  releaseSurface(): void {
    if (this.disposed || this.surfaces === 0) return;
    this.surfaces -= 1;
    this.applyScrollbackTier();
  }

  /** Attached surfaces. Zero means the bounded retention tier is in force. */
  get surfaceCount(): number {
    return this.surfaces;
  }

  /** Scrollback lines the grid is currently retaining. */
  get scrollbackLines(): number {
    return this.currentScrollback;
  }

  private applyScrollbackTier(): void {
    const want =
      this.surfaces > 0 ? this.watchedScrollback : this.unwatchedScrollback;
    if (want === this.currentScrollback) return;
    try {
      this.term.options.scrollback = want;
    } catch (err) {
      // Never silent, never per-attach spam: a grid that refuses a live
      // scrollback write keeps the tier it has, which is the pre-tier
      // behaviour for a watched session and a bounded one otherwise.
      if (!this.scrollbackTierFailed) {
        this.scrollbackTierFailed = true;
        console.warn(
          `[term-observer] live scrollback write refused for ${this.bindingId}` +
            `@${this.epoch} (want=${want}, have=${this.currentScrollback}); ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    this.currentScrollback = want;
  }

  /** Drop retained title/osc evidence (session change / cold wake). */
  clearSignals(): void {
    this.title = "";
    this.osc9 = "";
    this.modes = idleAttachModes();
  }

  subscribe(listener: ObserverListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Read of the current grid, after buffered bytes are absorbed. */
  async snapshot(): Promise<ObserverGridSnapshot> {
    await this.settled();
    return this.buildSnapshot();
  }

  /**
   * Sync read of the grid as of the last settled write. Bytes fed but not yet
   * parsed are absent, and so is their seq: writes are serialized here, and
   * xterm parses one queued chunk in full before running its callback, so a
   * sync read never sees a half-applied write and the seq it carries is
   * always the seq of the grid it shows. Callers that need every byte fed so
   * far must await `snapshot()` / `attachScreen()`; `isSettled()` says
   * whether such bytes exist.
   */
  snapshotNow(): ObserverGridSnapshot {
    return this.buildSnapshot();
  }

  /**
   * True when every byte fed so far is on the grid. False while a write is in
   * flight or bytes wait out the sampling floor — a sync snapshot taken then
   * is exact for the seq it names, but behind the PTY.
   */
  isSettled(): boolean {
    return !this.writeInFlight && this.pending.length === 0;
  }

  /**
   * Full-buffer dump for attach — all retained scrollback + viewport.
   * Prefer this over journal replay for long-lived sessions.
   */
  async attachScreen(): Promise<import("./types").AttachScreen> {
    // Attach is the renderer's starting truth — it must never omit bytes
    // still sitting in the flush window.
    await this.settled();
    return this.buildAttachScreen();
  }

  attachScreenNow(): import("./types").AttachScreen {
    return this.buildAttachScreen();
  }

  private buildAttachScreen(): import("./types").AttachScreen {
    const buf = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    return {
      bindingId: this.bindingId,
      epoch: this.epoch,
      cols,
      rows,
      seq: this.seq,
      // Official xterm serializer emits VT sequences for cells, colors,
      // cursor, modes, normal buffer, and alternate buffer. Replaying this
      // into another same-sized xterm restores terminal state instead of a
      // plain-text approximation.
      //
      // It does not restore the mouse report *encoding*, so the tracked
      // DEC state supplies it — otherwise a TUI that negotiated SGR gets
      // X10 reports and every wheel tick is dropped.
      serialized:
        this.serializer.serialize() + buildMouseEncodingEscape(this.modes),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFlushTimer();
    this.pending = [];
    this.pendingSeq = undefined;
    this.pendingSignal = false;
    this.listeners.clear();
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    try {
      this.serializer.dispose();
    } catch {
      // ignore
    }
    try {
      this.term.dispose();
    } catch {
      // ignore
    }
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snap = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error(
          `[term-observer] listener failed for ${this.bindingId}@${this.epoch}:`,
          err,
        );
      }
    }
  }

  private buildSnapshot(): ObserverGridSnapshot {
    const buf = this.term.buffer.active;
    const cols = this.term.cols;
    const rows = this.term.rows;
    // Bottom `rows` lines of the buffer (viewport-sized tail) — stable under scroll.
    const lines: string[] = [];
    const base = Math.max(0, buf.baseY + buf.cursorY - rows + 1);
    // Prefer the visible viewport when available.
    const startY = buf.viewportY;
    const from = Math.max(0, Math.min(startY, buf.length));
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(from + i);
      if (!line) {
        lines.push("");
        continue;
      }
      // translateToString(true) trims right; false keeps full width.
      // Cap cell walk to cols to avoid post-resize length > columns trap.
      lines.push(line.translateToString(true, 0, cols));
    }
    // If viewport is empty/stale at spawn, fall back to baseY window.
    if (lines.every((l) => l.length === 0) && buf.length > 0) {
      lines.length = 0;
      for (let i = 0; i < rows; i++) {
        const line = buf.getLine(base + i);
        lines.push(line ? line.translateToString(true, 0, cols) : "");
      }
    }

    const signals: ObserverSignals = {
      title: this.title,
      osc9: this.osc9,
      modes: this.modes,
    };

    return {
      cols,
      rows,
      lines,
      text: lines.join("\n"),
      signals,
      seq: this.seq,
      epoch: this.epoch,
      bindingId: this.bindingId,
    };
  }

  // Region helpers for state-machine consumers.
  regionWhole(lines: readonly string[] = this.snapshotNow().lines): readonly string[] {
    return lines;
  }
  regionBottomNonEmpty(n: number, lines?: readonly string[]): readonly string[] {
    return bottomNonEmptyLines(lines ?? this.snapshotNow().lines, n);
  }
  regionFooter(lines?: readonly string[]): string {
    return footerLine(lines ?? this.snapshotNow().lines);
  }
  regionAfterLastRule(lines?: readonly string[]): readonly string[] {
    return afterLastHorizontalRule(lines ?? this.snapshotNow().lines);
  }
  regionPromptBox(lines?: readonly string[]): readonly string[] {
    return promptBoxBody(lines ?? this.snapshotNow().lines);
  }
  regionAbovePrompt(lines?: readonly string[]): readonly string[] {
    return abovePromptBox(lines ?? this.snapshotNow().lines);
  }
}
