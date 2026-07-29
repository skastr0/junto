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

  constructor(opts: SessionObserverOptions) {
    this.bindingId = opts.bindingId;
    this.epoch = opts.epoch;
    const cols = Math.max(20, Math.min(300, opts.cols));
    const rows = Math.max(5, Math.min(120, opts.rows));
    // Long sessions: retain a deep scrollback in the headless terminal so the
    // canonical VT serializer can restore the complete terminal state.
    const scrollback = Math.max(
      opts.scrollback ?? 50_000,
      rows * 4,
      200,
    );
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback,
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

  /** Feed PTY bytes. seq is the plane's journal sequence. */
  feed(data: string, seq: bigint): void {
    if (this.disposed) return;
    // Pin seq to the write that applied it — not the latest enqueued feed —
    // so intermediate snapshots never claim a seq the grid has not absorbed.
    this.writeQueue = this.writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (this.disposed) {
              resolve();
              return;
            }
            this.term.write(data, () => {
              this.seq = seq;
              this.emitSnapshot();
              resolve();
            });
          }),
      )
      .catch(() => undefined);
  }

  /** Resize the headless grid to match the live PTY. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = Math.max(20, Math.min(300, cols));
    const r = Math.max(5, Math.min(120, rows));
    this.term.resize(c, r);
    this.emitSnapshot();
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

  /** Synchronous read of the current grid (after any pending writes settle). */
  async snapshot(): Promise<ObserverGridSnapshot> {
    await this.writeQueue;
    return this.buildSnapshot();
  }

  /** Best-effort sync snapshot — may lag the last unflushed write by one tick. */
  snapshotNow(): ObserverGridSnapshot {
    return this.buildSnapshot();
  }

  /**
   * Full-buffer dump for attach — all retained scrollback + viewport.
   * Prefer this over journal replay for long-lived sessions.
   */
  async attachScreen(): Promise<import("./types").AttachScreen> {
    await this.writeQueue;
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
      serialized: this.serializer.serialize(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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

  // Region helpers for state-machine consumers (no string copies from herdr).
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
