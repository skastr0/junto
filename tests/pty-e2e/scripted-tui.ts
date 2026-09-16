/**
 * ScriptedTui — deterministic in-process model of a harness TUI that speaks
 * the REAL byte protocol captured in
 * the 2026-08 managed-terminal probe reports (claude-code, codex, grok)
 *
 * This is the OS-boundary fake the pty-e2e spec allows for drive scenarios:
 * instead of spawning a real PTY, the model consumes the drive's writes and
 * emits the byte stream a real harness would produce. Every byte the model
 * emits goes through a REAL SessionObserver (same read side as production),
 * so seat-state evaluation, idle gating and drive acknowledgement run against
 * real screens — never hand-built snapshot objects.
 *
 * Receipts implemented (all VERIFIED in the probe docs):
 *  - K3  : bracketed paste `ESC[200~…ESC[201~` renders into the composer;
 *          a CR that races paste-end collapses multi-line paste into a
 *          `[Pasted text #N +k lines]` chip that needs a SECOND CR to submit.
 *          K3 verified Claude's 0/50/200ms sweep; typing.ts documents the
 *          0–150ms chip window that the drive's settle (40/80ms) targets.
 *  - K8  : idle Ctrl+C (0x03) clears the composer (one press, no exit);
 *          a second idle Ctrl+C inside ~1s exits (title emptied per K9);
 *          mid-turn Ctrl+C interrupts and returns to the idle prompt.
 *  - K9  : OSC 9;4;3 + braille title frames while working, OSC 9;4;0 + ✳
 *          title while idle, empty title on exit. `ESC[?2004h` at boot.
 *  - C2  : Codex model — separate CR submits (0–150ms ok); a CR joined into
 *          the same write() as the payload is swallowed and never submits.
 */
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  promptHasPasteChip,
  promptStillPending,
  type ManagedTerminalDriveOptions,
} from "../../src/main/vellum-command/term/drive";
import { SeatStateRuntime } from "../../src/main/vellum-command/term/agent-state/runtime";
import { SessionObserver } from "../../src/main/vellum-command/term/observer";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { DriveAttentionReason } from "../../src/main/vellum-command/term/drive";

export type TuiHarness = "claude" | "codex" | "hermes" | "grok";

export type TimerHandle = { cancel(): void };

export type ScriptedTuiOptions = {
  /** Defaults to "claude". */
  readonly harness?: TuiHarness;
  /** Byte sink — the loop feeds these bytes into the real SessionObserver. */
  readonly emit: (data: string) => void;
  /** Clock for the exit-arm window (defaults to Date.now). */
  readonly now?: () => number;
  /** Timer scheduler (defaults to global setTimeout). */
  readonly schedule?: (fn: () => void, ms: number) => TimerHandle;
  /**
   * Claude model: multi-line paste renders a chip that needs a 2nd CR.
   * Single-line paste inserts into the composer (K3). Default true.
   */
  readonly chipOnMultilinePaste?: boolean;
  /**
   * Claude model: the 2nd CR while the chip is visible submits. Default
   * true. Stuck-chip scenarios (the "stuck forever" failure mode typing.ts
   * documents) set this false.
   */
  readonly secondCrSubmits?: boolean;
  /** Braille working-title frames before the idle restore (1s cadence, K9). */
  readonly workingFrames?: number;
  /**
   * DRV-4 seam: after the paste write is accepted, a subsequent CR write is
   * REFUSED by the PTY master (write() returns false — models a harness that
   * rejects the CR while the paste envelope is still settling). The drive
   * must still clear the chip it created. Default false.
   */
  readonly refuseCrWrite?: boolean;
  /**
   * Delay (ms) before the working repaint is delivered after a real submit.
   * 0 = delivered inline. D3 uses this to model a turn-start ack that is
   * emitted by the TUI at submit time but arrives at the observer after the
   * drive's 5s stall window.
   */
  readonly ackDelayMs?: number;
  readonly cols?: number;
  readonly rows?: number;
};

export type TuiPhase = "idle" | "working" | "exiting";

/** Static transcript history — must never match any claude/codex rule. */
const HISTORY: readonly string[] = [
  "Claude Code managed terminal session",
  "",
  "You can paste text, files, and images from your clipboard.",
  "Press esc to interrupt a running turn.",
  "Press ctrl+c at the empty prompt to exit.",
  "",
  "Junto drive loop owns this seat",
  "",
  "Session start",
  "",
  "ready",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
];

const RULE = "─".repeat(60);
const FOOTER = "esc to interrupt";

export class ScriptedTui {
  readonly harness: TuiHarness;
  private readonly emit: (data: string) => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle;
  private readonly chipOnMultilinePaste: boolean;
  private readonly secondCrSubmits: boolean;
  private readonly workingFrames: number;
  private readonly ackDelayMs: number;
  private readonly refuseCrWrite: boolean;
  private readonly cols: number;
  private readonly rows: number;

  private phase: TuiPhase = "idle";
  private composer: string[] = [];
  private chip: { n: number; k: number } | null = null;
  /** CRs received while the current chip is visible (chip needs 2nd CR). */
  private chipCrCount = 0;
  private chipCounter = 0;
  /** Grok history footer after a multiline paste (`[Pasted:Nlines]`). */
  private grokPasteFooter: string | null = null;
  private exitArmedAt: number | null = null;
  private title = "✳ Claude Code";
  private osc9 = "4;0;";
  private readonly timers: TimerHandle[] = [];
  private ackTimer: TimerHandle | null = null;
  private readonly byteLog: string[] = [];
  private exited = false;

  constructor(options: ScriptedTuiOptions) {
    this.harness = options.harness ?? "claude";
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      });
    this.chipOnMultilinePaste = options.chipOnMultilinePaste ?? true;
    this.secondCrSubmits = options.secondCrSubmits ?? true;
    this.workingFrames = options.workingFrames ?? 2;
    this.ackDelayMs = options.ackDelayMs ?? 0;
    this.refuseCrWrite = options.refuseCrWrite ?? false;
    this.cols = options.cols ?? 60;
    this.rows = options.rows ?? 24;
    if (this.harness === "codex") this.title = "Codex";
    if (this.harness === "hermes") this.title = "✓ gpt-5.4-mini \u00b7 proj";
    if (this.harness === "grok") this.title = "vellum - grok";
  }

  /** Internal truth: is an unsubmitted chip currently held? */
  chipPending(): boolean {
    return this.chip !== null;
  }

  /** CRs the drive has sent while the current chip is visible. */
  chipCrSeen(): number {
    return this.chipCrCount;
  }

  getPhase(): TuiPhase {
    return this.phase;
  }

  /** All bytes the model emitted so far (for canonicality replay). */
  emittedBytes(): readonly string[] {
    return [...this.byteLog];
  }

  /**
   * Emit the spawn screen: bracketed-paste mode + idle paint as ONE feed.
   * (Under vitest fake timers an xterm flush scheduled during the same tick
   * as a prior feed is only picked up by a later positive advance; a single
   * feed per tick keeps delivery deterministic.)
   */
  boot(): void {
    if (this.harness === "hermes") {
      // E2 receipt (hermes/paste-chip.jsonl + capture report): idle title
      // `✓ <model> / <cwd>`, ready footer, `│` composer glyph.
      this.send(
        `\x1b[?2004h` +
          this.repaintBytes(
            "✓ gpt-5.4-mini \u00b7 proj",
            "",
            this.idleScreen(["│ "]),
          ),
      );
      return;
    }
    this.send(
      `\x1b[?2004h` +
        this.repaintBytes(
          this.harness === "codex"
            ? "Codex"
            : this.harness === "grok"
              ? "vellum - grok"
              : "✳ Claude Code",
          this.harness === "grok" ? "4;0;0" : "4;0;",
          this.idleScreen(["❯ "]),
        ),
    );
  }

  /**
   * Drive write side. Consumes raw bytes exactly as a PTY master would
   * deliver them to the harness process.
   */
  write(data: string): boolean {
    if (this.phase === "exiting") return false;
    if (this.refuseCrWrite && data.includes(CR)) return false;
    // Codex (C2): a CR joined into the same write as payload never submits.
    const joinedCr = this.harness === "codex" && data.includes(CR) && data.length > 1;
    let i = 0;
    while (i < data.length) {
      if (data.startsWith(BRACKETED_PASTE_START, i)) {
        const end = data.indexOf(
          BRACKETED_PASTE_END,
          i + BRACKETED_PASTE_START.length,
        );
        if (end < 0) {
          i += 1;
          continue;
        }
        this.onPaste(data.slice(i + BRACKETED_PASTE_START.length, end));
        i = end + BRACKETED_PASTE_END.length;
        continue;
      }
      if (data.charCodeAt(i) === 0x0d) {
        if (!joinedCr) this.onCr();
        i += 1;
        continue;
      }
      if (data.charCodeAt(i) === 0x03) {
        this.onCtrlC();
        i += 1;
        continue;
      }
      i += 1;
    }
    return true;
  }

  /**
   * False-working paint (Path A / R1 receipt): braille OSC title + OSC 9;4;3
   * while the composer paints EMPTY — the internal chip stays pending. Real
   * harnesses do this when the title flips to a spinner frame but the paste
   * chip was never submitted (observer receipt "working" on an unsubmitted
   * chip).
   */
  emitFalseWorking(): void {
    this.title = "⠂ Claude Code";
    this.osc9 = "4;3;";
    this.repaintWithComposer([]);
  }

  /**
   * R2 receipt: chip stays visible while the title flips to a braille frame.
   * composer_draft_idle (1150) outranks osc_title_working (1100), so the
   * seat must stay idle. Used as the sanity half of D2 before the false
   * working (empty composer + braille) is emitted.
   */
  emitBrailleTitleWithChip(): void {
    if (this.chip === null) return;
    this.title = "⠂ Claude Code";
    this.osc9 = "4;3;";
    this.repaintWithComposer([
      `❯ [Pasted text #${this.chip.n} +${this.chip.k} lines]`,
    ]);
  }

  /**
   * Restore the idle paint (K9: ✳ + 9;4;0 + prompt box) from a false-working
   * frame. POL-2 uses real working→idle title flips to drive the supervisor.
   */
  emitIdleRestore(): void {
    this.phase = "idle";
    this.repaintIdle();
  }

  /** Interrupt a working turn (K8: mid-turn 0x03 → back to the prompt). */
  private onCtrlC(): void {
    if (this.phase === "working") {
      this.cancelTimers();
      this.phase = "idle";
      this.title = "✳ Claude Code";
      this.osc9 = "4;0;";
      this.send(
        this.repaintBytes(
          "✳ Claude Code",
          "4;0;",
          [
            ...HISTORY.slice(0, 19),
            "⎿ Interrupted - What should Claude do instead?",
            RULE,
            "❯ ",
            RULE,
            FOOTER,
          ],
        ),
      );
      return;
    }
    // Idle path (K8): with text → clear composer + arm exit; empty → exit
    // when a second 0x03 arrives inside the ~1s window (0.509–1.009s).
    const hasText = this.chip !== null || this.composer.length > 0;
    const t = this.now();
    if (hasText) {
      this.chip = null;
      this.chipCrCount = 0;
      this.composer = [];
      this.exitArmedAt = t;
      this.repaintIdle();
      return;
    }
    if (this.exitArmedAt !== null && t - this.exitArmedAt < 1_000) {
      this.exit();
      return;
    }
    this.exitArmedAt = t;
  }

  private exit(): void {
    this.phase = "exiting";
    this.exited = true;
    this.cancelTimers();
    // K9 exit receipt: title emptied, progress cleared.
    this.send("\x1b]0;\x07\x1b]9;4;0;\x07");
  }

  private onPaste(payload: string): void {
    if (this.phase !== "idle") return;
    const lines = payload.split("\n");
    if (this.harness === "hermes") {
      // E2 (hermes/paste-chip.jsonl): the `[[ PASTE_LINE_00 PA.. [15 lines]
      // .. PASTE_LINE_13 PASTE_LINE_14 ]]` chip renders IMMEDIATELY on paste
      // and survives CR@40ms AND the slow 2nd CR — only Ctrl+C clears it
      // (capture report: chip40 present, afterCr40=True, submitted40=False,
      // submittedSlow=False, clearedByCtrlC=True).
      if (lines.length > 1) {
        this.chipCounter += 1;
        // E2 receipt: the chip count is the full payload width (`[15 lines]`
        // for PASTE_LINE_00..14) and the tail shows the last two lines.
        this.chip = { n: this.chipCounter, k: lines.length };
        this.chipCrCount = 0;
        this.composer = [];
        this.repaintIdle();
        return;
      }
      this.composer = lines;
      this.chip = null;
      this.repaintIdle();
      return;
    }
    if (this.harness === "codex" || this.harness === "grok") {
      // C2 / G2: paste renders into the composer; separate CR submits.
      // Grok also paints a history footer `[Pasted:Nlines]` — not composer chip.
      this.composer = lines;
      this.chip = null;
      if (this.harness === "grok" && lines.length > 1) {
        this.grokPasteFooter = `[Pasted:${lines.length}lines]`;
      }
      this.repaintIdle();
      return;
    }
    if (lines.length > 1 && this.chipOnMultilinePaste) {
      this.chipCounter += 1;
      this.chip = { n: this.chipCounter, k: lines.length - 1 };
      this.chipCrCount = 0; // the next CR is the one that races paste-end
      this.composer = [];
      this.repaintIdle();
      return;
    }
    this.composer = lines;
    this.chip = null;
    this.repaintIdle();
  }

  private onCr(): void {
    if (this.phase !== "idle") return;
    if (this.harness === "hermes") {
      // E2: the hermes chip NEVER collapses on a CR — not the racing CR and
      // not the retry. Count what the drive sends (chipCrSeen) but never
      // submit; only Ctrl+C clears.
      if (this.chip !== null) {
        this.chipCrCount += 1;
        return;
      }
      if (this.composer.length === 0) return;
      this.submit();
      return;
    }
    if (this.harness === "codex" || this.harness === "grok") {
      if (this.composer.length === 0) return;
      this.submit();
      return;
    }
    if (this.chip !== null) {
      this.chipCrCount += 1;
      // The first CR after the chip is the one that raced paste-end and
      // caused the collapse (it never submits). The SECOND CR is the retry
      // that collapses the chip — unless the harness is stuck.
      if (this.chipCrCount < 2) return;
      if (!this.secondCrSubmits) return; // stuck chip: 2nd CR does nothing
      this.submit();
      return;
    }
    if (this.composer.length === 0) return;
    this.submit();
  }

  /**
   * Real submission: working paint, braille frames, then idle restore.
   * With ackDelayMs > 0 the first working repaint is delivered late (bytes
   * the TUI emitted at submit time but that reach the observer after the
   * drive's stall window). That delayed ack is treated as in-flight bytes:
   * an interrupt cancels frame timers but not the ack itself.
   */
  private submit(): void {
    this.phase = "working";
    this.chip = null;
    this.chipCrCount = 0;
    this.composer = [];
    this.exitArmedAt = null;
    this.cancelTimers();
    this.ackTimer = this.schedule(
      () => this.deliverWorkingFrame(1, 0, true),
      this.ackDelayMs,
    );
  }

  private deliverWorkingFrame(
    frame: number,
    delayMs: number,
    ignorePhase = false,
  ): void {
    this.timers.push(
      this.schedule(() => {
        if (!ignorePhase && this.phase !== "working") return;
        this.title =
          this.harness === "hermes"
            ? "⏳ gpt-5.4-mini \u00b7 proj"
            : this.harness === "grok"
              ? "thinking"
              : frame % 2 === 1
                ? "⠂ Claude Code"
                : "⠐ Claude Code";
        this.osc9 =
          this.harness === "hermes"
            ? ""
            : this.harness === "grok"
              ? "4;1;-1"
              : "4;3;";
        this.send(this.repaintBytes(this.title, this.osc9, this.workingScreen()));
        if (frame < this.workingFrames) {
          this.deliverWorkingFrame(frame + 1, 1_000);
        } else {
          this.timers.push(
            this.schedule(() => {
              if (this.phase !== "working") return;
              this.phase = "idle";
              this.repaintIdle();
            }, 1_000),
          );
        }
      }, delayMs),
    );
  }

  private workingScreen(): string[] {
    if (this.harness === "hermes") {
      // E2 working-turn capture: `(´･_･`)musing…` + `Ctrl+C to interrupt…`.
      return [
        ...HISTORY.slice(0, 20),
        RULE,
        "(´･_･`)musing…",
        RULE,
        "Ctrl+C to interrupt…",
      ];
    }
    return [
      ...HISTORY.slice(0, 20),
      RULE,
      "Working on your request…",
      RULE,
      FOOTER,
    ];
  }

  private repaintIdle(): void {
    if (this.harness === "hermes") {
      const composer = this.chip
        ? [`│ [[ PASTE_LINE_00 PA.. [${this.chip.k} lines] .. PASTE_LINE_${String(this.chip.k - 2).padStart(2, "0")} PASTE_LINE_${String(this.chip.k - 1).padStart(2, "0")} ]]`]
        : this.composer.length > 0
          ? this.composer.map((line, i) => (i === 0 ? `│ ${line}` : `  ${line}`))
          : ["│ "];
      this.title = "✓ gpt-5.4-mini \u00b7 proj";
      this.osc9 = "";
      this.repaintWithComposer(composer);
      return;
    }
    const composer = this.chip
      ? [`❯ [Pasted text #${this.chip.n} +${this.chip.k} lines]`]
      : this.composer.length > 0
        ? this.composer.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`))
        : ["❯ "];
    this.title =
      this.harness === "codex"
        ? "Codex"
        : this.harness === "grok"
          ? "vellum - grok"
          : "✳ Claude Code";
    this.osc9 = this.harness === "grok" ? "4;0;0" : "4;0;";
    this.repaintWithComposer(composer);
  }

private idleScreen(composer: readonly string[]): string[] {
    if (this.harness === "hermes") {
      // Real hermes idle footer (E2 / startup-idle capture): the ready footer
      // is the harness's idle chrome.
      return [
        ...HISTORY.slice(0, 20),
        RULE,
        ...composer,
        RULE,
        "ready │ gpt 5.4 mini │ 1s │ voice off │ 1 session",
      ];
    }
    if (this.harness === "grok") {
      // Live Grok: history footer `[Pasted:Nlines]` sits under the box.
      // That is not `[Pasted text` composer chrome.
      return [
        ...HISTORY.slice(0, 14),
        RULE,
        ...composer,
        RULE,
        ...(this.grokPasteFooter !== null ? [this.grokPasteFooter] : []),
        "ctrl+.:shortcuts",
      ];
    }
    return [...HISTORY.slice(0, 20), RULE, ...composer, RULE, FOOTER];
  }

  private repaintWithComposer(composer: readonly string[]): void {
    this.send(this.repaintBytes(this.title, this.osc9, this.idleScreen(composer)));
  }

  private repaintBytes(title: string, osc9: string, lines: readonly string[]): string {
    const body = lines.slice(0, this.rows);
    while (body.length < this.rows) body.push("");
    return (
      `\x1b]0;${title}\x07` +
      `\x1b]9;${osc9}\x07` +
      "\x1b[H" +
      body.map((l, i) => l + (i < body.length - 1 ? "\r\n" : "")).join("")
    );
  }

  private send(data: string): void {
    this.byteLog.push(data);
    this.emit(data);
  }

  private cancelTimers(): void {
    if (this.ackTimer !== null) {
      this.ackTimer.cancel();
      this.ackTimer = null;
    }
    for (const t of this.timers.splice(0)) t.cancel();
  }

  dispose(): void {
    this.cancelTimers();
  }
}

export type LoopWrite = {
  readonly t: number;
  readonly data: string;
};

export type LoopAttention = {
  readonly t: number;
  readonly reason: DriveAttentionReason;
};

export type DriveLoopOptions = {
  readonly bindingId?: string;
  readonly epoch?: string;
  readonly harness?: TuiHarness;
  /** Called with every observer snapshot (supervisor wiring mirror). */
  readonly onSnapshot?: (snap: import("../../src/main/vellum-command/term/observer/types").ObserverGridSnapshot) => void;
  readonly now: () => number;
  readonly stallTimeoutMs?: number;
  readonly pasteToCrSettleMs?: number;
  readonly idleInterruptGapMs?: number;
  readonly tui?: Omit<
    ScriptedTuiOptions,
    "emit" | "now" | "schedule"
  >;
  readonly drive?: Omit<
    ManagedTerminalDriveOptions,
    "write" | "isSeatIdle" | "onAttention" | "now"
  >;
  /**
   * model (default): pendingText uses TUI chip/phase truth.
   * snapshot: pendingText + pasteChip are observer-grid only — the
   * production ipc.ts shape. Needed to prove Codex/Grok false chip-CR.
   */
  readonly pendingEvidence?: "model" | "snapshot";
  readonly cols?: number;
  readonly rows?: number;
};

/**
 * Full production loop (mirrors src/main/vellum-command/ipc.ts):
 *   drive.write → tui (byte model) → observer.feed(seq++)
 *   observer snapshots → seatStateRuntime.observe (same path as the global
 *   observer plane subscription)
 *   event.state === "working" → drive.onTurnStart
 *   event.state === "idle"    → drive.onSeatIdle
 *   isSeatIdle = () => runtime.isSeatIdle(bindingId)
 */
export class DriveLoop {
  readonly bindingId: string;
  readonly epoch: string;
  readonly observer: SessionObserver;
  readonly runtime: SeatStateRuntime;
  readonly tui: ScriptedTui;
  readonly drive: ManagedTerminalDrive;
  readonly writes: LoopWrite[] = [];
  readonly attention: LoopAttention[] = [];
  readonly events: AgentSeatStateEvent[] = [];

  private seq = 0n;
  private readonly now: () => number;
  private readonly unsub: () => void;
  /** Last prompt text the drive pasted per binding (pendingText evidence). */
  private readonly lastPromptText = new Map<string, string>();

  constructor(options: DriveLoopOptions) {
    this.bindingId = options.bindingId ?? "seat-b1";
    this.epoch = options.epoch ?? "gen-1";
    this.now = options.now;
    this.observer = new SessionObserver({
      bindingId: this.bindingId,
      epoch: this.epoch,
      cols: options.cols ?? 60,
      rows: options.rows ?? 24,
    });
    this.runtime = new SeatStateRuntime({ now: this.now });
    this.tui = new ScriptedTui({
      ...options.tui,
      harness: options.harness ?? options.tui?.harness ?? "claude",
      emit: (data) => {
        this.seq += 1n;
        this.observer.feed(data, this.seq);
      },
      now: this.now,
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
    });
    this.drive = new ManagedTerminalDrive({
      ...options.drive,
      write: (bindingId, data) => {
        this.writes.push({ t: this.now(), data });
        const ok = this.tui.write(data);
        // Record the payload of any paste envelope the drive sends so the
        // evidence callback can scan for it (mirrors ipc.ts lastPromptText).
        if (
          data.startsWith(BRACKETED_PASTE_START) &&
          data.endsWith(BRACKETED_PASTE_END)
        ) {
          this.lastPromptText.set(
            bindingId,
            data.slice(
              BRACKETED_PASTE_START.length,
              data.length - BRACKETED_PASTE_END.length,
            ),
          );
        }
        return ok;
      },
      isSeatIdle: () => this.runtime.isSeatIdle(this.bindingId),
      onAttention: (bindingId, reason) => {
        this.attention.push({ t: this.now(), reason });
      },
      pendingText: (bindingId) => {
        const text = this.lastPromptText.get(bindingId);
        if (text === undefined) return false;
        const snap = this.observer.snapshotNow();
        if (options.pendingEvidence === "snapshot") {
          return promptStillPending(snap, text);
        }
        // The model's internal composer truth: a held chip IS our "[Pasted
        // text" chip, even when a false-working repaint hides it from the
        // observer grid (R1 receipt: empty composer + braille title).
        if (this.tui.chipPending()) return true;
        // A non-idle phase means the model already consumed the composer: a
        // chip still on the stale grid is a repaint delay (D3 ackDelay), not
        // pending text — never clear into a working agent.
        if (this.tui.getPhase() !== "idle") return false;
        // Harnesses that render the payload inline (codex) have no chip:
        // scan the observer grid's prompt region for our text.
        return promptStillPending(snap, text);
      },
      pasteChip: (bindingId) => {
        if (options.pendingEvidence === "snapshot") {
          return promptHasPasteChip(this.observer.snapshotNow());
        }
        return this.tui.chipPending();
      },
      now: this.now,
      stallTimeoutMs: options.stallTimeoutMs,
      pasteToCrSettleMs: options.pasteToCrSettleMs,
      idleInterruptGapMs: options.idleInterruptGapMs,
    });
    this.unsub = this.observer.subscribe((snap) => {
      const event = this.runtime.observe(snap);
      if (event) {
        this.events.push(event);
        if (event.state === "working") this.drive.onTurnStart(event.bindingId);
        if (event.state === "idle") this.drive.onSeatIdle(event.bindingId);
      }
      options.onSnapshot?.(snap);
    });
    this.runtime.bindHarness(
      this.bindingId,
      options.harness ?? options.tui?.harness ?? "claude",
      this.epoch,
    );
    this.tui.boot();
  }

  /** Label a write for logs/assertions: paste / cr / ctrl-c / retry-cr. */
  labelWrite(data: string): string {
    if (data.includes(BRACKETED_PASTE_START)) return "paste";
    if (data === CR) return "cr";
    if (data === INTERRUPT_BYTE) return "ctrl-c";
    return JSON.stringify(data);
  }

  writeLog(): string {
    return this.writes
      .map((w) => `t=${w.t} ${this.labelWrite(w.data)}`)
      .join("\n");
  }

  dispose(): void {
    this.unsub();
    this.tui.dispose();
    this.runtime.stop();
    this.observer.dispose();
  }
}
