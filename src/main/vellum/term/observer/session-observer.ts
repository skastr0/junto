/**
 * One headless xterm per live local terminal session.
 * Fed from LocalSessionHost.observeData — every PTY byte with a seq.
 */

import { Terminal } from "@xterm/headless";
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
  ObserverModes,
  ObserverSignals,
  SessionObserverOptions,
} from "./types";

const DEFAULT_UNICODE: "6" | "11" = "11";

export class SessionObserver {
  readonly bindingId: string;
  readonly epoch: string;
  private readonly term: Terminal;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly listeners = new Set<ObserverListener>();
  private title = "";
  private osc9 = "";
  private modes: ObserverModes = {
    bracketedPaste: false,
    synchronizedOutput: false,
  };
  private seq = 0n;
  private writeQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(opts: SessionObserverOptions) {
    this.bindingId = opts.bindingId;
    this.epoch = opts.epoch;
    const cols = Math.max(20, Math.min(300, opts.cols));
    const rows = Math.max(5, Math.min(120, opts.rows));
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: Math.max(rows * 4, 200),
    });
    // Pin unicode version so wide-char column math is stable across tests + prod.
    try {
      this.term.unicode.activeVersion = opts.unicodeVersion ?? DEFAULT_UNICODE;
    } catch {
      // Older headless builds may lack the API — leave default.
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
    this.disposables.push(
      this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (this.paramsInclude(params, 2004)) {
          this.modes = { ...this.modes, bracketedPaste: true };
        }
        if (this.paramsInclude(params, 2026)) {
          this.modes = { ...this.modes, synchronizedOutput: true };
        }
        return false; // let xterm also process
      }),
    );
    this.disposables.push(
      this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (this.paramsInclude(params, 2004)) {
          this.modes = { ...this.modes, bracketedPaste: false };
        }
        if (this.paramsInclude(params, 2026)) {
          this.modes = { ...this.modes, synchronizedOutput: false };
        }
        return false;
      }),
    );
  }

  private paramsInclude(
    params: ReadonlyArray<number | number[]>,
    mode: number,
  ): boolean {
    for (const p of params) {
      if (typeof p === "number" && p === mode) return true;
      if (Array.isArray(p) && p.includes(mode)) return true;
    }
    return false;
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
    this.modes = { bracketedPaste: false, synchronizedOutput: false };
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
