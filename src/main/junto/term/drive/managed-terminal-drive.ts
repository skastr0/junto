/**
 * Managed-terminal drive — state-gated typing transport for agent seats.
 *
 * Owns: paste+CR recipe, seat and screen gates, mid-turn queue, interrupt
 * spacing, submission acknowledgement.
 * Does not own: PTY leases, seat state machine (injected lookups).
 *
 * Fail-closed: an unwritable seat or screen → bounded queue or immediate
 * refusal by caller policy. Mail (`whileWorking`) also writes into a working
 * seat and lets the harness queue or steer it.
 */

import {
  OPERATOR_INPUT_LATCH_MS,
  OperatorInterlock,
  seatOperatorInterlock,
} from "./operator-interlock";
import {
  buildPromptWriteSequence,
  canSendIdleInterrupt,
  CR,
  DEFAULT_PROMPT_STALL_MS,
  INTERRUPT_BYTE,
  MIN_IDLE_INTERRUPT_GAP_MS,
  PASTE_TO_CR_SETTLE_MS,
  hermesRefusesMultilinePaste,
  payloadMayChip,
} from "./typing";
import {
  createPtyDeliveryTracer,
  type PtyDeliveryTraceContext,
  type PtyDeliveryTraceSink,
  type PtyDeliveryTracer,
  type PtyTraceFields,
} from "./pty-delivery-trace";
import type {
  ManagedPromptOutcome,
  ManagedPromptRefusalReason,
  ManagedPromptUnresolvedReason,
} from "@shared/managed-prompt";

export type {
  MailDisplayState,
  MailEvidenceRef,
  MailKind,
  ManagedPromptOutcome,
  ManagedPromptOutcomeFacts,
  ManagedPromptRefusalReason,
  ManagedPromptUnresolvedReason,
} from "@shared/managed-prompt";

/** Returns true when the managed seat may accept a typed prompt. */
export type SeatIdleLookup = (bindingId: string) => boolean;

/** Harness id for a binding — used at the paste boundary (Hermes multiline refuse). */
export type SeatHarnessLookup = (bindingId: string) => string | undefined;

/**
 * Write raw bytes to a managed terminal PTY.
 * Synchronous or async; false = write refused (no lease / dead session).
 */
export type TerminalWriter = (
  bindingId: string,
  data: string,
) => boolean | Promise<boolean>;

export type DriveAttentionReason =
  | "clipboard-unsafe"
  | "prompt-stalled"
  | "write-failed"
  | "not-ready"
  | "composer-unreadable"
  | "queue-timeout"
  | "multiline-refused"
  | "operator-active";

/** Default max wait for a mid-turn queued prompt before resolving false. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

export type DriveAttentionCallback = (
  bindingId: string,
  reason: DriveAttentionReason,
) => void;

/**
 * Optional Grok preflight: return false when the clipboard holds an image
 * (or otherwise unsafe paste surface). Drive aborts to attention and does
 * NOT clear the operator's clipboard.
 */
export type ClipboardSafeAssert = (
  bindingId: string,
) => boolean | Promise<boolean>;

/**
 * Optional prompt-pending evidence: does the seat's prompt box STILL hold
 * text this drive pasted (harness chip, marker, or payload head)? Consumed
 * from the terminal observer snapshot through promptStillPending.
 *
 * When configured, acknowledgement becomes evidence-gated:
 *  - onTurnStart only resolves a pending turn while evidence says the text
 *    is GONE (a false-working repaint on an unsubmitted chip must not ack);
 *  - an unresolved write remains unreceipted and stops further automation
 *    for that binding; the drive never clears a composer with Ctrl+C;
 *  - the awaitTurnStart:false fast path refuses to receipt a prompt whose
 *    text is still in the composer.
 */
export type PromptPendingLookup = (bindingId: string) => boolean;

/**
 * Pending-text evidence lookup. Receives the exact text the drive last put
 * on the wire for this binding — the drive owns that record so no delivery
 * path can produce a paste the evidence layer cannot see. (The pulse path
 * once bypassed the ipc-side text map: pendingText answered vacuously, a
 * stuck chip receipted as submitted.)
 */
export type PromptTextLookup = (
  bindingId: string,
  promptText: string,
) => boolean;

/**
 * Screen-derived composer verdict (agent-state/composer.ts).
 *
 * An idle seat is NOT a free composer: the agent can be done while the
 * operator is mid-sentence. Pasting there appends to their draft and the CR
 * submits it. The verdict is read from the live grid by each harness's
 * composer probes: "empty" is the ONLY state that authorizes typing; "draft"
 * means visible unsubmitted text sits in the box; null means the probes
 * matched nothing (dialog up, mid-transition, or an ungrounded harness) and
 * typing refuses — an unreadable composer is never a writable one. Queueing
 * callers park until the box is proven clear; non-queueing callers are
 * refused and retry from their own source.
 */
export type ComposerVerdictLookup = (
  bindingId: string,
) => "empty" | "draft" | null;

export type WritePromptOptions = {
  /** Cancel this request before any later paste, submit, or recovery write. */
  readonly signal?: AbortSignal;
  /**
   * Positive UI readiness (not a quiet-gap). When false, abort to attention
   * without writing — Hermes install window swallows Ctrl+C and kills the session.
   * Default true when omitted (caller responsibility to pass false when unready).
   */
  readonly ready?: boolean;
  /** Override queue wait when seat is busy (default DEFAULT_QUEUE_TIMEOUT_MS). */
  readonly queueTimeoutMs?: number;
  /**
   * Whether a busy/not-yet-writeable seat may retain the raw prompt for a
   * later idle transition. Scheduled kernel pulses set false so their source
   * identity stays in the kernel and every retry re-checks current edges.
   * Defaults true for operator-authored and work-message prompts.
   */
  readonly queueIfBusy?: boolean;
  /**
   * Earliest epoch-ms at which paste is allowed (Grok ≥1.5s post-spawn).
   * When now < readyAfterMs, wait only when queueIfBusy permits retention.
   */
  readonly readyAfterMs?: number;
  /**
   * Mail: a WORKING seat is as writable as an idle one. The harness queues or
   * steers text typed mid-turn by its own rules; Junto adds no wait of its
   * own. Acceptance is the harness taking the text out of the composer, since
   * a queued message starts no turn. Every screen guard still applies: a
   * draft, an unreadable composer, or an attention state (an approval
   * dialog) is never typed into.
   */
  readonly whileWorking?: boolean;
  /**
   * When false, retain the extra firstTyped paint settles after paste+CR.
   * Every accepted paste still needs positive submission evidence within
   * the bounded acknowledgement wait; an empty composer alone proves none.
   * Defaults to the drive-level stallWatch constructor option.
   */
  readonly awaitTurnStart?: boolean;
};

/**
 * A working seat takes a write into its own queue or steer, so no turn starts.
 * Its composer letting go of our text is the acceptance evidence, trusted only
 * after this floor so observer paint lag cannot read a pre-paste empty box as
 * taken.
 */
export const WORKING_WRITE_ACCEPT_FLOOR_MS = 250;
const WORKING_WRITE_POLL_MS = 50;

/** Grok TUI trap: paste before ~1.5s post-spawn is swallowed. */
export const GROK_MIN_POST_SPAWN_MS = 1_500;

type QueuedPrompt = {
  readonly text: string;
  readonly signal: AbortSignal | undefined;
  readonly awaitTurnStart: boolean;
  readonly trace: PtyDeliveryTraceContext | undefined;
  readonly resolve: (outcome: ManagedPromptOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type PendingTurn = {
  readonly generation: number;
  readonly bindingGeneration: number;
  readonly signal: AbortSignal | undefined;
  readonly text: string;
  readonly resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type ManagedTerminalDriveOptions = {
  readonly write: TerminalWriter;
  readonly isSeatIdle: SeatIdleLookup;
  /**
   * Seat is mid-turn on a readable screen (working, not attention). Only
   * `whileWorking` writes consult it. Absent = no working seat is writable.
   */
  readonly isSeatWorking?: SeatIdleLookup;
  /** Continue an accepted paste despite its draft replacing idle chrome. */
  readonly canContinueSubmission?: (bindingId: string, text: string) => boolean;
  readonly onAttention?: DriveAttentionCallback;
  readonly assertClipboardSafe?: ClipboardSafeAssert;
  readonly now?: () => number;
  readonly stallTimeoutMs?: number;
  readonly idleInterruptGapMs?: number;
  readonly queueTimeoutMs?: number;
  /**
   * Default recipe selection for awaitTurnStart. Both recipes require
   * positive submission evidence. Missing acknowledgement resolves
   * unresolved and holds later automatic delivery on this binding.
   */
  readonly stallWatch?: boolean;
  /**
   * Delay after paste-end before the first CR (default PASTE_TO_CR_SETTLE_MS).
   * Tests set 0 so write counts stay paste+CR without fake timers.
   */
  readonly pasteToCrSettleMs?: number;
  /** Evidence-gated acknowledgement (see PromptTextLookup). */
  readonly pendingText?: PromptTextLookup;
  /**
   * Composer paste-chip chrome only (`[Pasted text`). Chip-submit CR reads
   * this when set so Codex payload-head leftovers and Grok `[Pasted:Nlines]`
   * footers cannot queue a second turn. Absent → fall back to pendingText
   * (unit tests that only wire pending).
   */
  readonly pasteChip?: PromptPendingLookup;
  /** Composer typing gate (see ComposerVerdictLookup). */
  readonly composerVerdict?: ComposerVerdictLookup;
  /** Binding → harness id. Absent lookup = no Hermes multiline refuse. */
  readonly harnessFor?: SeatHarnessLookup;
  /**
   * Operator-input interlock shared with the PTY write boundary. Latches
   * block admission while operator keystrokes are too fresh for the screen
   * to prove a draft; holds park operator bytes for the physical paste→CR
   * unit so they can never interleave inside the envelope. Defaults to the
   * process singleton; tests inject an isolated instance.
   */
  readonly operatorInput?: OperatorInterlock;
  /** Diagnostic sink; production defaults to JUNTO_PTY_TRACE=1. */
  readonly onTrace?: PtyDeliveryTraceSink;
};

export class ManagedTerminalDrive {
  private readonly writeFn: TerminalWriter;
  private readonly isSeatIdle: SeatIdleLookup;
  private readonly isSeatWorking: SeatIdleLookup;
  private readonly canContinueSubmission: SeatIdleLookup;
  private readonly onAttention: DriveAttentionCallback | undefined;
  private readonly assertClipboardSafe: ClipboardSafeAssert | undefined;
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly idleInterruptGapMs: number;
  private readonly queueTimeoutMs: number;
  private readonly stallWatch: boolean;
  private readonly pasteToCrSettleMs: number;
  private readonly pendingText: PromptTextLookup | undefined;
  private readonly pasteChip: PromptPendingLookup | undefined;
  private readonly composerVerdict: ComposerVerdictLookup | undefined;
  private readonly harnessFor: SeatHarnessLookup | undefined;
  private readonly interlock: OperatorInterlock;
  private readonly tracer: PtyDeliveryTracer | undefined;

  private readonly queues = new Map<string, QueuedPrompt[]>();
  /**
   * The exact text the drive last put on the wire per binding — set when a
   * paste write succeeds, cleared with the generation. Feeds pendingText so
   * every delivery path (prompts, pulses, doctrine) carries evidence.
   */
  private readonly lastWrittenText = new Map<string, string>();
  private readonly writing = new Set<string>();
  private readonly lastIdleInterruptAt = new Map<string, number>();
  /**
   * One in-flight idle 0x03 per binding. Generation-owned: cuts clear it,
   * and only the completion that reserved it may release it, so a stale
   * failure can never free a replacement generation's reservation.
   */
  private readonly idleInterrupts = new Map<string, symbol>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly turnStartCounts = new Map<string, number>();
  private readonly compactNoopCounts = new Map<string, number>();
  /** bindingId → earliest write time (Grok post-spawn, etc.). */
  private readonly readyAfter = new Map<string, number>();
  /** Per-binding generation cut: terminal epoch changes invalidate old writes. */
  private readonly bindingGenerations = new Map<string, number>();
  /**
   * Monotonic count of paste envelopes that actually reached the PTY writer.
   * The delivery layer compares it around a failed attempt: an attempt that
   * wrote NOTHING (refused at a gate or race) must not burn at-most-once
   * bookkeeping that exists to stop re-pasting text already on the PTY.
   */
  private readonly pasteWrites = new Map<string, number>();
  /** A paste landed without submission proof. Only a new binding generation clears it. */
  private readonly writtenUnresolved = new Set<string>();
  private suspended = false;
  private lifecycleGeneration = 0;

  constructor(options: ManagedTerminalDriveOptions) {
    this.tracer = createPtyDeliveryTracer(options.onTrace);
    this.writeFn = options.write;
    this.isSeatWorking = options.isSeatWorking ?? (() => false);
    this.isSeatIdle = (bindingId) => {
      const idle = options.isSeatIdle(bindingId);
      this.tracer?.event(bindingId, "evidence", { probe: "idle", value: idle });
      return idle;
    };
    this.canContinueSubmission = (bindingId) => {
      const text = this.lastWrittenText.get(bindingId);
      const allowed = text !== undefined && (
        options.canContinueSubmission?.(bindingId, text) ?? this.isSeatIdle(bindingId)
      );
      this.tracer?.event(bindingId, "evidence", { probe: "submission-continuation", value: allowed });
      return allowed;
    };
    this.onAttention = (bindingId, reason) => {
      this.traceState(bindingId, "attention", { reason });
      options.onAttention?.(bindingId, reason);
    };
    this.assertClipboardSafe = options.assertClipboardSafe;
    this.now = options.now ?? (() => Date.now());
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_PROMPT_STALL_MS;
    this.idleInterruptGapMs = options.idleInterruptGapMs ?? MIN_IDLE_INTERRUPT_GAP_MS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.stallWatch = options.stallWatch ?? true;
    this.pasteToCrSettleMs = options.pasteToCrSettleMs ?? PASTE_TO_CR_SETTLE_MS;
    this.pendingText = options.pendingText === undefined ? undefined : (bindingId, text) => {
      const pending = options.pendingText!(bindingId, text);
      this.tracer?.event(bindingId, "evidence", { probe: "pending-text", value: pending });
      return pending;
    };
    this.pasteChip = options.pasteChip === undefined ? undefined : (bindingId) => {
      const chip = options.pasteChip!(bindingId);
      this.tracer?.event(bindingId, "evidence", { probe: "paste-chip", value: chip });
      return chip;
    };
    this.composerVerdict = options.composerVerdict === undefined ? undefined : (bindingId) => {
      const verdict = options.composerVerdict!(bindingId);
      this.tracer?.event(bindingId, "evidence", { probe: "composer", value: verdict });
      return verdict;
    };
    this.harnessFor = options.harnessFor;
    this.interlock = options.operatorInput ?? seatOperatorInterlock;
  }

  /** Hermes never receives a multiline paste — chip never collapses on CR. */
  private refuseHermesMultiline(bindingId: string, text: string): boolean {
    if (!hermesRefusesMultilinePaste(this.harnessFor?.(bindingId), text)) {
      return false;
    }
    this.onAttention?.(bindingId, "multiline-refused");
    return true;
  }

  /**
   * Attempt facts for one outcome: the terminal-epoch cut the attempt ran
   * under, this attempt's own paste envelopes, and whether any prompt byte
   * it wrote reached the PTY. Attempt-owned by construction: the after-count
   * derives from the entry basis plus this attempt's own single envelope,
   * never from the live binding counter — a generation cut plus replacement
   * writes must not inflate another generation's evidence, and an
   * interleaved attempt must not borrow this one's. Pre-write refusals
   * always report zero writes — retryable without replay risk.
   */
  private promptFacts(
    bindingGeneration: number,
    writesBefore: number,
    wrotePhysicalBytes: boolean,
  ): {
    readonly bindingGeneration: number;
    readonly writesBefore: number;
    readonly writesAfter: number;
    readonly pasteWrites: number;
    readonly wrotePhysicalBytes: boolean;
  } {
    const writesAfter = writesBefore + (wrotePhysicalBytes ? 1 : 0);
    return {
      bindingGeneration,
      writesBefore,
      writesAfter,
      pasteWrites: writesAfter - writesBefore,
      wrotePhysicalBytes,
    };
  }

  private refusePrompt(
    bindingId: string,
    bindingGeneration: number,
    writesBefore: number,
    reason: ManagedPromptRefusalReason,
  ): ManagedPromptOutcome {
    return {
      status: "refused",
      reason,
      ...this.promptFacts(bindingGeneration, writesBefore, false),
    };
  }

  private submitPrompt(
    bindingId: string,
    bindingGeneration: number,
    writesBefore: number,
  ): ManagedPromptOutcome {
    return {
      status: "submitted",
      ...this.promptFacts(bindingGeneration, writesBefore, true),
    };
  }

  private strandPrompt(
    bindingId: string,
    bindingGeneration: number,
    writesBefore: number,
  ): ManagedPromptOutcome {
    const reason: ManagedPromptUnresolvedReason =
      this.pendingText !== undefined && this.pendingOnScreen(bindingId)
        ? "chip-pending"
        : "no-turn-start";
    return {
      status: "unresolved",
      reason,
      ...this.promptFacts(bindingGeneration, writesBefore, true),
    };
  }

  /**
   * Generation cut, shutdown, or abort — preserving physical truth. A cut
   * after this attempt's paste envelope reached the writer is written
   * uncertainty (unresolved/no-turn-start: no submission proof exists for
   * these bytes and the dead generation cannot supply it), never a pre-write
   * refusal. Only a cut before any write of this attempt refuses
   * cancelled/suspended.
   */
  private inactivePrompt(
    bindingId: string,
    bindingGeneration: number,
    writesBefore: number,
    wrotePhysicalBytes = false,
  ): ManagedPromptOutcome {
    if (wrotePhysicalBytes) {
      return {
        status: "unresolved",
        reason: "no-turn-start",
        ...this.promptFacts(bindingGeneration, writesBefore, true),
      };
    }
    return this.refusePrompt(
      bindingId,
      bindingGeneration,
      writesBefore,
      this.suspended ? "suspended" : "cancelled",
    );
  }

  /**
   * Map the live gate to the refusal reason without writing: busy seats
   * (mid-turn, in-flight, or awaiting ack) refuse seat-busy; a visible
   * draft holds the box; an unreadable composer is never writable; fresh
   * operator input holds the write until the screen can prove a draft.
   */
  private gatePromptRefusal(
    bindingId: string,
    bindingGeneration: number,
    writesBefore: number,
    whileWorking = false,
  ): ManagedPromptRefusalReason {
    if (this.writtenUnresolved.has(bindingId)) return "written-unresolved";
    if (
      !this.admitsWrite(bindingId, whileWorking) ||
      this.writing.has(bindingId) ||
      this.pendingTurns.has(bindingId)
    ) {
      return "seat-busy";
    }
    if (this.composerBlocked(bindingId)) {
      return this.composerVerdict?.(bindingId) === "draft"
        ? "composer-not-empty"
        : "composer-unreadable";
    }
    if (this.interlock.gateActive(bindingId)) return "operator-active";
    return "seat-busy";
  }

  /**
   * True while a factory write must wait: the agent is mid-turn, a write is
   * already in flight, a turn is pending acknowledgement, the screen does
   * not prove an empty composer — or operator input arrived too recently for
   * the screen to prove anything at all. The interlock latches cover the
   * observer's blind window between keystroke and repaint.
   */
  private mustWait(bindingId: string, whileWorking = false): boolean {
    const waiting = (
      !this.admitsWrite(bindingId, whileWorking) ||
      this.writing.has(bindingId) ||
      this.pendingTurns.has(bindingId) ||
      this.composerBlocked(bindingId) ||
      this.interlock.gateActive(bindingId)
    );
    this.traceState(bindingId, "gate", { gate: "must-wait", waiting });
    return waiting;
  }

  /**
   * The seat state a write may land in: idle, or mid-turn for a
   * `whileWorking` write. Attention (an approval or other dialog), unknown,
   * and gone are never writable.
   */
  private admitsWrite(bindingId: string, whileWorking: boolean): boolean {
    return this.isSeatIdle(bindingId) || (whileWorking && this.isSeatWorking(bindingId));
  }

  /**
   * Fail closed on the screen: only a proven-empty composer is typeable.
   * "draft" holds for the operator; null holds because the box is unreadable
   * (dialog, transition, ungrounded harness). Absent lookup = test seam.
   */
  private composerBlocked(bindingId: string): boolean {
    if (this.composerVerdict === undefined) return false;
    return this.composerVerdict(bindingId) !== "empty";
  }

  /** Mark a binding as just spawned — enforces min delay before first paste. */
  markSpawned(bindingId: string, minDelayMs: number = GROK_MIN_POST_SPAWN_MS): void {
    if (this.suspended) return;
    this.readyAfter.set(bindingId, this.now() + Math.max(0, minDelayMs));
  }

  /**
   * Cut all transport state retained for one terminal generation.
   *
   * A binding id is stable across PTY replacement, so queued prompts, an
   * in-flight paste→CR pair, and stall retries must not survive an epoch
   * change and land in the replacement process.
   */
  invalidateBinding(bindingId: string): void {
    this.traceState(bindingId, "binding.invalidated");
    this.bindingGenerations.set(
      bindingId,
      (this.bindingGenerations.get(bindingId) ?? 0) + 1,
    );
    this.interlock.dropBinding(bindingId);
    this.clearBindingTransientState(bindingId);
    this.writtenUnresolved.delete(bindingId);
    this.tracer?.forget(bindingId);
  }

  /**
   * Monotonic shutdown cut for product automation.
   *
   * Existing PTY processes and their host generations remain alive. This
   * drive only drops its Junto-owned write authority: queued text resolves
   * refused, stall retries are canceled, delayed preflight continuations
   * become stale, and no later paste/CR/interrupt reaches the writer.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.lifecycleGeneration += 1;
    this.clearTransientState("suspended");
  }

  private active(generation: number): boolean {
    return !this.suspended && generation === this.lifecycleGeneration;
  }

  private activeBinding(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): boolean {
    const active = (
      !signal?.aborted &&
      this.active(generation) &&
      (this.bindingGenerations.get(bindingId) ?? 0) === bindingGeneration
    );
    if (!active) {
      this.tracer?.event(bindingId, "gate", {
        gate: "active-binding", allowed: false,
        aborted: signal?.aborted ?? false,
        suspended: this.suspended,
        generation,
        currentGeneration: this.lifecycleGeneration,
        bindingGeneration,
        currentBindingGeneration: this.bindingGenerations.get(bindingId) ?? 0,
      });
    }
    return active;
  }

  /**
   * Deliver one submitted prompt when idle. Queues when the seat is busy;
   * The promise resolves submitted only after an explicit turn-start
   * acknowledgement or a recognized command-specific acceptance event.
   * It resolves refused on a pre-write failure, shutdown, or queue timeout; a
   * generation change after the paste landed resolves unresolved (written
   * uncertainty, never a pre-write refusal); and unresolved when bytes
   * reached the PTY without submission proof. Pre-write refusals carry zero
   * physical writes; immediate not-ready / clipboard-unsafe / write failures
   * refuse the same way.
   */
  writePrompt(
    bindingId: string,
    text: string,
    opts: WritePromptOptions = {},
  ): Promise<ManagedPromptOutcome> {
    // Attempt-owned write evidence: bumped only by this attempt's own paste
    // accept, read by every outcome this attempt constructs — a cut plus
    // replacement writes can never rewrite it.
    const evidence = { wrote: false };
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    const writesBefore = this.pasteWrites.get(bindingId) ?? 0;
    if (this.tracer === undefined) {
      return this.writePromptInternal(bindingId, text, opts, evidence);
    }
    // The trace envelope still records a submitted boolean for continuity;
    // the caller receives the full discriminated outcome.
    let captured: ManagedPromptOutcome | undefined;
    const body = (): Promise<boolean> =>
      this.writePromptInternal(bindingId, text, opts, evidence).then((outcome) => {
        captured = outcome;
        return outcome.status === "submitted";
      });
    const traced = this.tracer.prompt(bindingId, text, () => this.harnessFor?.(bindingId), {
      ready: opts.ready ?? true,
      queueIfBusy: opts.queueIfBusy ?? true,
      awaitTurnStart: opts.awaitTurnStart ?? this.stallWatch,
    }, body);
    return traced.then(() => captured ?? this.inactivePrompt(
      bindingId,
      bindingGeneration,
      writesBefore,
      evidence.wrote,
    ));
  }

  private async writePromptInternal(
    bindingId: string,
    text: string,
    opts: WritePromptOptions = {},
    evidence: { wrote: boolean },
  ): Promise<ManagedPromptOutcome> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    const writesBefore = this.pasteWrites.get(bindingId) ?? 0;
    const signal = opts.signal;
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return this.inactivePrompt(
        bindingId,
        bindingGeneration,
        writesBefore,
        evidence.wrote,
      );
    }
    if (this.refuseWrittenUnresolved(bindingId)) {
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "written-unresolved");
    }
    const ready = opts.ready ?? true;
    const whileWorking = opts.whileWorking === true;
    // A working-seat write never parks raw text in the drive: its caller
    // owns the retry, so a queued entry cannot outlive the seat state that
    // admitted it.
    const queueIfBusy = whileWorking ? false : (opts.queueIfBusy ?? true);
    const awaitTurnStart = opts.awaitTurnStart ?? this.stallWatch;
    if (this.refuseHermesMultiline(bindingId, text)) {
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "multiline-refused");
    }
    if (!ready) {
      this.onAttention?.(bindingId, "not-ready");
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "not-ready");
    }

    if (!queueIfBusy && this.mustWait(bindingId, whileWorking)) {
      return this.refusePrompt(
        bindingId,
        bindingGeneration,
        writesBefore,
        this.gatePromptRefusal(bindingId, bindingGeneration, writesBefore, whileWorking),
      );
    }

    const readyAfter =
      opts.readyAfterMs ?? this.readyAfter.get(bindingId) ?? 0;
    const waitMs = readyAfter - this.now();
    if (waitMs > 0) {
      this.traceState(bindingId, "gate", { gate: "ready-after", allowed: false, waitMs });
      // A non-queuing caller retains authorization context outside this
      // transport and will retry later. Never park its raw text in the drive.
      if (!queueIfBusy) {
        return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "not-ready");
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, waitMs);
        t.unref?.();
      });
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      this.readyAfter.delete(bindingId);
    }

    if (this.assertClipboardSafe) {
      let safe = false;
      try {
        safe = await Promise.resolve(this.assertClipboardSafe(bindingId));
      } catch {
        safe = false;
      }
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      if (!safe) {
        this.onAttention?.(bindingId, "clipboard-unsafe");
        return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "clipboard-unsafe");
      }
    }

    // Readiness and clipboard preflight can outlive an earlier delivery.
    // Re-check before this call can interrupt a turn or retain more text.
    if (this.refuseWrittenUnresolved(bindingId)) {
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "written-unresolved");
    }
    if (this.mustWait(bindingId, whileWorking)) {
      if (!queueIfBusy) {
        return this.refusePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          this.gatePromptRefusal(bindingId, bindingGeneration, writesBefore, whileWorking),
        );
      }
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      if (this.refuseWrittenUnresolved(bindingId)) {
        return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "written-unresolved");
      }
      // Preflight awaits can outlive the seat's idle transition. Do not miss
      // that boundary and strand the prompt in a queue that was drained just
      // before this call resumed.
      if (!this.mustWait(bindingId, whileWorking)) {
        return this.executePrompt(
          bindingId,
          text,
          generation,
          bindingGeneration,
          awaitTurnStart,
          signal,
          evidence,
          whileWorking,
        );
      }
      const timeoutMs = opts.queueTimeoutMs ?? this.queueTimeoutMs;
      return new Promise<ManagedPromptOutcome>((resolve) => {
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          resolve(this.inactivePrompt(bindingId, bindingGeneration, writesBefore));
          return;
        }
        const entry: QueuedPrompt = {
          text,
          signal,
          awaitTurnStart,
          trace: this.tracer?.capture(),
          resolve: (outcome) => {
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined;
            signal?.removeEventListener("abort", cancel);
            resolve(outcome);
          },
          timer: undefined,
        };
        // Drop this entry from the queue if still waiting.
        const remove = () => {
          const q = this.queues.get(bindingId);
          if (q) {
            const idx = q.indexOf(entry);
            if (idx >= 0) {
              q.splice(idx, 1);
              if (q.length === 0) this.queues.delete(bindingId);
              else this.queues.set(bindingId, q);
            }
          }
        };
        const cancel = () => {
          remove();
          entry.resolve(this.refusePrompt(bindingId, bindingGeneration, writesBefore, "cancelled"));
        };
        entry.timer = setTimeout(() => {
          if (this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
            this.onAttention?.(bindingId, "queue-timeout");
          }
          remove();
          entry.resolve(this.refusePrompt(bindingId, bindingGeneration, writesBefore, "queue-timeout"));
        }, timeoutMs);
        entry.timer.unref?.();
        const q = this.queues.get(bindingId) ?? [];
        q.push(entry);
        this.queues.set(bindingId, q);
        this.traceState(bindingId, "delivery.queued", { timeoutMs, depth: q.length });
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }

    return this.executePrompt(
      bindingId,
      text,
      generation,
      bindingGeneration,
      awaitTurnStart,
      signal,
      evidence,
      whileWorking,
    );
  }

  /**
   * Interrupt the seat with Ctrl+C (0x03).
   * Mid-turn: always allowed. Idle: enforces min gap between consecutive 0x03.
   *
   * Idle admission is a reservation, not a timestamp. One idle 0x03 per
   * binding is in flight at a time, however long the writer takes, and the
   * spacing gap runs from the accepted landing, so a late first byte is never
   * followed at once by a second. A write that lands nothing releases only
   * its own reservation and stamps no spacing; a generation cut already
   * cleared the reservation and a stale completion never touches the new one.
   */
  async interrupt(bindingId: string): Promise<boolean> {
    this.traceState(bindingId, "interrupt.begin");
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    // A Ctrl+C can never land inside a live submission span — it would
    // interleave into the paste envelope exactly like operator bytes.
    if (this.interlock.holding(bindingId)) {
      this.traceState(bindingId, "gate", { gate: "interrupt-hold", allowed: false });
      return false;
    }
    const idle = this.isSeatIdle(bindingId);
    if (idle && this.idleInterrupts.has(bindingId)) {
      this.traceState(bindingId, "gate", { gate: "interrupt-in-flight", allowed: false });
      return false;
    }
    if (
      idle &&
      !canSendIdleInterrupt(
        this.lastIdleInterruptAt.get(bindingId),
        this.now(),
        this.idleInterruptGapMs,
      )
    ) {
      this.traceState(bindingId, "gate", { gate: "interrupt-spacing", allowed: false });
      return false;
    }
    const reservation = idle ? Symbol("idle-interrupt") : undefined;
    if (reservation !== undefined) {
      this.idleInterrupts.set(bindingId, reservation);
    }
    let ok = false;
    try {
      ok = await Promise.resolve(this.writeTraced(bindingId, INTERRUPT_BYTE, "interrupt"));
    } finally {
      if (reservation !== undefined && this.idleInterrupts.get(bindingId) === reservation) {
        this.idleInterrupts.delete(bindingId);
      }
    }
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    if (ok && idle) {
      this.lastIdleInterruptAt.set(bindingId, this.now());
    }
    return ok;
  }

  /**
   * Bare recovery submit for harness-owned selectors (Claude resume-summary
   * choice). Startup navigation, not a prompt: no paste envelope, no turn
   * acknowledgement, no evidence record.
   *
   * Refuses while a submission is in flight or a paste is unresolved, so
   * recovery can never submit a stuck chip the drive has not receipted.
   * Never requires seat idle: recovery fires from the attention state.
   */
  async submitRecoveryCr(bindingId: string): Promise<boolean> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) {
      return false;
    }
    if (this.writing.has(bindingId) || this.pendingTurns.has(bindingId)) {
      return false;
    }
    if (this.refuseWrittenUnresolved(bindingId)) return false;
    if (this.interlock.holding(bindingId) || this.interlock.gateActive(bindingId)) {
      return false;
    }
    return this.writeSubmitCr(bindingId, generation, bindingGeneration, undefined, "recovery-cr");
  }

  /**
   * Seat became idle — drain at most one queued prompt (one turn at a time).
   * Phase 2 state machine calls this on working→idle.
   */
  onSeatIdle(bindingId: string): void {
    if (this.suspended) return;
    void this.drainOne(bindingId);
  }

  /**
   * The operator's prompt box went empty (submitted or cleared). Queued
   * factory prompts waited for exactly this boundary.
   */
  onComposerClear(bindingId: string): void {
    if (this.suspended) return;
    void this.drainOne(bindingId);
  }

  /**
   * Turn-start ack (title flip, hook event, OSC). Clears stall watch for the seat.
   */
  onTurnStart(bindingId: string): void {
    this.traceState(bindingId, "turn.start", { pendingTurn: this.pendingTurns.has(bindingId) });
    if (this.suspended) return;
    if (this.pendingOnScreen(bindingId)) {
      this.traceState(bindingId, "turn.start.refused", { reason: "text-pending" });
      // Evidence: our text is still in the prompt box. A working repaint on
      // an unsubmitted chip is a FALSE turn-start — never receipt it.
      return;
    }
    // The physical writer can observe an acknowledgement before its promise
    // settles. Preserve only accepted events for that fast path: a refused
    // repaint must not later become a receipt through a changed counter.
    this.turnStartCounts.set(
      bindingId,
      (this.turnStartCounts.get(bindingId) ?? 0) + 1,
    );
    this.traceState(bindingId, "turn.start.accepted");
    this.resolvePendingTurn(bindingId, true);
  }

  /** Claude accepted `/compact` but the session was already too fresh to compact. */
  onCompactNoop(bindingId: string): void {
    if (this.suspended) return;
    this.compactNoopCounts.set(
      bindingId,
      (this.compactNoopCounts.get(bindingId) ?? 0) + 1,
    );
    if (this.pendingTurns.get(bindingId)?.text === "/compact") {
      this.resolvePendingTurn(bindingId, true);
    }
  }

  private clearTransientState(reason: "suspended" | "cancelled"): void {
    for (const [bindingId] of this.pendingTurns) {
      this.resolvePendingTurn(bindingId, false);
    }
    for (const [bindingId, q] of this.queues) {
      for (const item of q) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.resolve({
          status: "refused",
          reason,
          bindingGeneration: this.bindingGenerations.get(bindingId) ?? 0,
          writesBefore: 0,
          writesAfter: 0,
          pasteWrites: 0,
          wrotePhysicalBytes: false,
        });
      }
    }
    this.queues.clear();
    this.writing.clear();
    this.lastIdleInterruptAt.clear();
    this.idleInterrupts.clear();
    this.turnStartCounts.clear();
    this.compactNoopCounts.clear();
    this.readyAfter.clear();
    this.lastWrittenText.clear();
    this.interlock.clearAll();
  }

  private clearBindingTransientState(bindingId: string): void {
    this.resolvePendingTurn(bindingId, false);
    const queue = this.queues.get(bindingId);
    if (queue !== undefined) {
      this.queues.delete(bindingId);
      for (const item of queue) {
        if (item.timer !== undefined) clearTimeout(item.timer);
        item.resolve({
          status: "refused",
          reason: "cancelled",
          bindingGeneration: this.bindingGenerations.get(bindingId) ?? 0,
          writesBefore: 0,
          writesAfter: 0,
          pasteWrites: 0,
          wrotePhysicalBytes: false,
        });
      }
    }
    this.writing.delete(bindingId);
    this.lastIdleInterruptAt.delete(bindingId);
    this.idleInterrupts.delete(bindingId);
    this.turnStartCounts.delete(bindingId);
    this.compactNoopCounts.delete(bindingId);
    this.readyAfter.delete(bindingId);
    this.lastWrittenText.delete(bindingId);
  }

  /** Test seam — reset scheduling; unresolved writes still require a generation cut. */
  resetForTest(): void {
    this.lifecycleGeneration += 1;
    this.clearTransientState("cancelled");
    this.suspended = false;
  }

  /** Queued prompt count for one binding (tests / diagnostics). */
  queuedCount(bindingId: string): number {
    return this.queues.get(bindingId)?.length ?? 0;
  }

  /** Paste envelopes that actually reached the PTY writer (see pasteWrites). */
  pasteWriteCount(bindingId: string): number {
    return this.pasteWrites.get(bindingId) ?? 0;
  }

  private async drainOne(bindingId: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    const bindingGeneration = this.bindingGenerations.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration)) return;
    if (this.mustWait(bindingId)) {
      // Latch-only blocks never get a screen event to re-fire the drain —
      // re-arm once the interlock goes quiet so a fresh keystroke cannot
      // strand a queued prompt until queue-timeout.
      if (
        (this.queues.get(bindingId)?.length ?? 0) > 0 &&
        this.interlock.gateActive(bindingId)
      ) {
        void this.interlock.waitQuiet(bindingId).then(() => {
          void this.drainOne(bindingId);
        });
      }
      return;
    }
    const q = this.queues.get(bindingId);
    if (!q || q.length === 0) return;
    const next = q.shift()!;
    // This deadline admits work to the writer. Once dequeued, submission owns
    // the result; queue expiry must not report false after bytes have landed.
    if (next.timer !== undefined) clearTimeout(next.timer);
    next.timer = undefined;
    if (q.length === 0) this.queues.delete(bindingId);
    else this.queues.set(bindingId, q);
    const execute = () => this.executePrompt(
      bindingId,
      next.text,
      generation,
      bindingGeneration,
      next.awaitTurnStart,
      next.signal,
      // Attempt-owned evidence for the dequeued attempt: the queue never
      // holds an in-flight write, so this starts unwritten.
      { wrote: false },
    );
    const outcome = await (this.tracer === undefined ? execute() : this.tracer.run(next.trace, execute));
    next.resolve(outcome);
  }

  private async executePrompt(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
    awaitTurnStart: boolean = this.stallWatch,
    signal?: AbortSignal,
    evidence: { wrote: boolean } = { wrote: false },
    whileWorking = false,
  ): Promise<ManagedPromptOutcome> {
    const writesBefore = this.pasteWrites.get(bindingId) ?? 0;
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return this.inactivePrompt(
        bindingId,
        bindingGeneration,
        writesBefore,
        evidence.wrote,
      );
    }
    if (this.refuseWrittenUnresolved(bindingId)) {
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "written-unresolved");
    }
    // Re-check the seat immediately before paste — observer can flip to a
    // dialog after the outer gate and before the physical write.
    if (!this.admitsWrite(bindingId, whileWorking)) {
      this.onAttention?.(bindingId, "not-ready");
      return this.refusePrompt(bindingId, bindingGeneration, writesBefore, "seat-busy");
    }
    this.writing.add(bindingId);
    const endTrace = this.tracer?.activate(bindingId);
    this.traceState(bindingId, "submission.begin");
    let pasteAccepted = false;
    let submitted = false;
    const confirmSubmitted = (): ManagedPromptOutcome => {
      submitted = true;
      return this.submitPrompt(bindingId, bindingGeneration, writesBefore);
    };
    const refuseNow = (reason: ManagedPromptRefusalReason): ManagedPromptOutcome =>
      this.refusePrompt(bindingId, bindingGeneration, writesBefore, reason);
    const strandNow = (): ManagedPromptOutcome =>
      this.strandPrompt(bindingId, bindingGeneration, writesBefore);
    try {
      // Second check under the writing lock: still refuse if the seat left a
      // writable state or the composer stopped being provably empty (operator
      // typing burst, dialog repaint). Only BEFORE our own paste — after it,
      // our chip is legitimately in the box.
      if (!this.admitsWrite(bindingId, whileWorking)) {
        this.onAttention?.(bindingId, "not-ready");
        return refuseNow("seat-busy");
      }
      if (this.composerBlocked(bindingId)) {
        const draft = this.composerVerdict?.(bindingId) === "draft";
        this.onAttention?.(bindingId, draft ? "not-ready" : "composer-unreadable");
        return refuseNow(draft ? "composer-not-empty" : "composer-unreadable");
      }
      // The screen gates above can only see what has painted. Operator
      // keystrokes younger than the repaint live only in the interlock
      // latches — wait out the blind window rather than paste onto a draft
      // the grid has not shown us yet. Synchronous fast path when no latch
      // is active: the write boundary stays tick-free for callers that
      // assert the paste landed before yielding.
      if (
        this.interlock.gateActive(bindingId) &&
        !(await this.awaitOperatorQuiet(
          bindingId,
          generation,
          bindingGeneration,
          signal,
        ))
      ) {
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          return this.inactivePrompt(
            bindingId,
            bindingGeneration,
            writesBefore,
            evidence.wrote,
          );
        }
        if (this.composerBlocked(bindingId)) {
          return refuseNow(
            this.composerVerdict?.(bindingId) === "draft"
              ? "composer-not-empty"
              : "composer-unreadable",
          );
        }
        return refuseNow("operator-active");
      }
      // Admitted into a live turn: the harness will queue or steer this text,
      // so acceptance is read from the composer, not from a turn start.
      const admittedWorking = whileWorking && !this.isSeatIdle(bindingId);
      const turnStartCount = this.turnStartCounts.get(bindingId) ?? 0;
      const compactNoopCount = this.compactNoopCounts.get(bindingId) ?? 0;
      const inputVersion = this.interlock.inputVersion(bindingId);
      // The physical unit (gates → paste → settle → CR → chip CR → firstTyped
      // evidence settles) runs under one interlock
      // hold. Operator bytes arriving mid-span park and replay only after
      // the span resolves, so they can never interleave inside the paste
      // envelope or land between paste-end and CR — the modal-focus race.
      const physical = await this.withOperatorHold(
        bindingId,
        async (): Promise<
          | { readonly kind: "inactive" }
          | { readonly kind: "failed" }
          | { readonly kind: "written"; readonly sentChipCr: boolean }
        > => {
          const ok = await this.writePasteAndCr(
            bindingId,
            text,
            generation,
            bindingGeneration,
            signal,
            () => {
              pasteAccepted = true;
              // Attempt-owned: only this attempt's own accept flips this.
              // A cut plus replacement writes can never rewrite it.
              evidence.wrote = true;
            },
            admittedWorking,
          );
          if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
            return { kind: "inactive" };
          }
          if (!ok) {
            this.onAttention?.(bindingId, "write-failed");
            return { kind: "failed" };
          }
          // Multiline paste chips on Claude/Devin. The second CR is the
          // submit, not a 5s stall recovery — send it as soon as the
          // composer still holds our text and the seat is idle.
          const sentChipCr = await this.writeChipSubmitCrIfNeeded(
            bindingId,
            text,
            generation,
            bindingGeneration,
            signal,
            admittedWorking,
          );
          if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
            return { kind: "inactive" };
          }
          // awaitTurnStart false (firstTyped) retains extra paint settles. The
          // observer snapshot on this tick still shows the text we just
          // pasted — wait after the recipe CR before deciding. Multiline
          // chips can paint one frame late: two settles, not one, so a
          // clean first look cannot receipt a chip that arrives on the
          // next paint. Same-tick Ctrl+C would interrupt a submit that
          // has not painted yet (and raise prompt-stalled on doctrine).
          const firstTypedSettles = payloadMayChip(text) ? 2 : 1;
          if (!awaitTurnStart && this.pendingText && this.pasteToCrSettleMs > 0) {
            for (let i = 0; i < firstTypedSettles; i += 1) {
              if (!(await this.settle(bindingId, generation, bindingGeneration, signal))) {
                return { kind: "inactive" };
              }
            }
          }
          return { kind: "written", sentChipCr };
        },
      );
      if (physical.kind === "inactive") {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      if (physical.kind === "failed") {
        // The paste envelope never completed: without an accepted paste
        // nothing reached the PTY (retryable); with one, the text sits
        // unsubmitted on screen (unresolved, same generation must not replay).
        return pasteAccepted ? strandNow() : refuseNow("not-ready");
      }
      const sentChipCr = physical.sentChipCr;
      // awaitTurnStart — observer delivery can race the CR writer's promise
      // resolution. Preserve a turn-start seen anywhere during the physical
      // sequence. The hold is released: the seat is submitting or working,
      // and operator input must flow normally through the stall watch.
      if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) {
        return confirmSubmitted();
      }
      if (
        text === "/compact" &&
        (this.compactNoopCounts.get(bindingId) ?? 0) !== compactNoopCount
      ) {
        return confirmSubmitted();
      }
      const started = admittedWorking
        ? await this.awaitWorkingWriteTaken(
            bindingId,
            turnStartCount,
            generation,
            bindingGeneration,
            signal,
          )
        : await this.awaitTurnStart(
            bindingId,
            text,
            generation,
            bindingGeneration,
            signal,
          );
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      if (started) return confirmSubmitted();
      this.traceState(bindingId, "recovery.evaluate", { sentChipCr });
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return this.inactivePrompt(
          bindingId,
          bindingGeneration,
          writesBefore,
          evidence.wrote,
        );
      }
      // Text absence cannot distinguish a submitted prompt from swallowed
      // input. Without positive acknowledgement this remains written
      // uncertainty; the binding hold prevents any automatic re-paste.
      // One bounded recovery belongs to this accepted paste, for literal text
      // as well as chips. Even an earlier chip CR can have been eaten. Never
      // re-paste, and never submit across operator input since the paste:
      // its short activity latch may have expired during the ACK wait.
      if (
        this.interlock.resizeActive(bindingId) &&
        !(await this.awaitResizeQuiet(bindingId, generation, bindingGeneration, signal))
      ) {
        // The accepted paste is already on the PTY; without submission
        // proof the attempt is unresolved, never a silent retryable false.
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          return this.inactivePrompt(
            bindingId,
            bindingGeneration,
            writesBefore,
            evidence.wrote,
          );
        }
        return strandNow();
      }
      if (
        this.mayContinueSubmission(bindingId, admittedWorking) &&
        this.pendingOnScreen(bindingId) &&
        this.interlock.inputVersion(bindingId) === inputVersion &&
        !this.interlock.inputActive(bindingId)
      ) {
        if (
          !(await this.writeSubmitCr(bindingId, generation, bindingGeneration, signal, "recovery-cr"))
        ) {
          if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
            return this.inactivePrompt(
              bindingId,
              bindingGeneration,
              writesBefore,
              evidence.wrote,
            );
          }
          return strandNow();
        }
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          return this.inactivePrompt(
            bindingId,
            bindingGeneration,
            writesBefore,
            evidence.wrote,
          );
        }
        if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) {
          return confirmSubmitted();
        }
        const startedRetry = admittedWorking
          ? await this.awaitWorkingWriteTaken(
              bindingId,
              turnStartCount,
              generation,
              bindingGeneration,
              signal,
            )
          : await this.awaitTurnStart(
              bindingId,
              text,
              generation,
              bindingGeneration,
              signal,
            );
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          return this.inactivePrompt(
            bindingId,
            bindingGeneration,
            writesBefore,
            evidence.wrote,
          );
        }
        if (startedRetry) return confirmSubmitted();
      }
      this.traceState(bindingId, "recovery.exhausted", { sentChipCr });
      return strandNow();
    } finally {
      const verdict = submitted ? "submitted" : pasteAccepted ? "written-unresolved" : "refused-before-write";
      this.traceState(bindingId, "delivery.verdict", { verdict });
      if (
        pasteAccepted && !submitted &&
        (this.bindingGenerations.get(bindingId) ?? 0) === bindingGeneration
      ) {
        // Install the guard before releasing the writing lock. An idle event
        // cannot race a queued follower into this unresolved composer.
        this.writtenUnresolved.add(bindingId);
        const queued = this.queues.get(bindingId);
        this.queues.delete(bindingId);
        // Followers never wrote: they refuse against the unresolved composer
        // and re-park from their own retry once it clears.
        for (const item of queued ?? []) {
          item.resolve({
            status: "refused",
            reason: "written-unresolved",
            bindingGeneration,
            writesBefore: 0,
            writesAfter: 0,
            pasteWrites: 0,
            wrotePhysicalBytes: false,
          });
        }
      }
      this.traceState(bindingId, "submission.end");
      endTrace?.();
      if ((this.bindingGenerations.get(bindingId) ?? 0) === bindingGeneration) {
        this.writing.delete(bindingId);
      }
      if (this.writtenUnresolved.has(bindingId)) {
        this.onAttention?.(bindingId, "prompt-stalled");
      }
    }
  }

  /**
   * Bounded wait for the operator latches to go quiet. Runs between the
   * screen gates and the paste boundary so a keystroke younger than the
   * repaint cannot race admission. A painted draft refuses through the
   * ordinary composer gate mid-wait; sustained activity refuses as
   * operator-active — queueing callers re-park from their own retry.
   */
  private async awaitOperatorQuiet(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wait = this.interlock.quietInMs(bindingId);
      this.traceState(bindingId, "gate", { gate: "operator-quiet", attempt, waitMs: wait });
      if (wait <= 0) return true;
      await new Promise<void>((r) => {
        const t = setTimeout(
          r,
          Math.min(wait, Math.max(1, this.pasteToCrSettleMs)),
        );
        t.unref?.();
      });
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return false;
      }
      if (this.composerBlocked(bindingId)) {
        this.onAttention?.(
          bindingId,
          this.composerVerdict?.(bindingId) === "draft"
            ? "not-ready"
            : "composer-unreadable",
        );
        return false;
      }
    }
    if (this.interlock.gateActive(bindingId)) {
      this.onAttention?.(bindingId, "operator-active");
      return false;
    }
    return true;
  }

  /**
   * Run `fn` inside an operator-input hold: parked writes replay in order at
   * the outermost end. Depth-tracked, so recovery writes nested inside the
   * submission span share it instead of flushing early.
   */
  private async withOperatorHold<T>(
    bindingId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = this.interlock.beginHold(bindingId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private refuseWrittenUnresolved(bindingId: string): boolean {
    if (!this.writtenUnresolved.has(bindingId)) return false;
    this.traceState(bindingId, "delivery.verdict", {
      verdict: "refused-before-write",
      reason: "written-unresolved",
    });
    this.onAttention?.(bindingId, "prompt-stalled");
    return true;
  }

  /**
   * Same-generation explicit-resume authorization outlet: release this
   * binding's written-unresolved hold so one operator-authorized retry can
   * paste. The caller guarantees a durable retry grant opened a new ledger
   * intent first — this never fires on idle, pulse, or ordinary scans.
   * Returns whether a hold was actually held.
   */
  releaseWrittenUnresolved(bindingId: string): boolean {
    if (!this.writtenUnresolved.has(bindingId)) return false;
    this.writtenUnresolved.delete(bindingId);
    this.traceState(bindingId, "delivery.verdict", {
      verdict: "resumed-authorized-retry",
      reason: "written-unresolved",
    });
    return true;
  }

  private async writePasteAndCr(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
    signal: AbortSignal | undefined,
    onPasteAccepted: () => void,
    admittedWorking = false,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return false;
    }
    // Final seat gate at the paste boundary (no durable receipt if refused).
    if (!this.admitsWrite(bindingId, admittedWorking)) {
      return false;
    }
    // Second line: a queued drain must not sneak a Hermes chip through.
    if (this.refuseHermesMultiline(bindingId, text)) {
      return false;
    }
    const [paste, cr] = buildPromptWriteSequence(text);
    // ONE write for the full paste envelope…
    if (!(await Promise.resolve(this.writeTraced(bindingId, paste, "paste")))) return false;
    onPasteAccepted();
    this.pasteWrites.set(bindingId, (this.pasteWrites.get(bindingId) ?? 0) + 1);
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return false;
    }
    // Register only in the generation that accepted this attempt. A late
    // physical completion from a replaced process cannot replace its text.
    this.lastWrittenText.set(bindingId, text);
    // Let paste-end settle before CR — racing ESC[201~ leaves Claude/Devin
    // with a stuck "[Pasted text …]" chip and never submits.
    if (this.pasteToCrSettleMs > 0) {
      this.traceState(bindingId, "settle.begin", { ms: this.pasteToCrSettleMs });
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.pasteToCrSettleMs);
        t.unref?.();
      });
      this.traceState(bindingId, "settle.end");
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
        return false;
      }
    }
    if (this.interlock.resizeActive(bindingId)) {
      if (!(await this.awaitResizeQuiet(bindingId, generation, bindingGeneration, signal))) {
        return false;
      }
    }
    // Our own draft can replace idle chrome during settle. Continue the
    // accepted submission using its evidence, never the empty-seat gate.
    if (!this.mayContinueSubmission(bindingId, admittedWorking)) return false;
    // …then a SEPARATE CR write. Never join; never LF.
    if (!(await Promise.resolve(this.writeTraced(bindingId, cr, "submit-cr")))) return false;
    return this.activeBinding(bindingId, generation, bindingGeneration, signal);
  }

  /**
   * Chip-submit CR: the recipe step ink TUIs need after a multiline paste.
   * Sends immediately when evidence already shows our text in an idle
   * composer; otherwise waits one settle for the observer to paint.
   * Returns true only when a CR was written.
   */
  private async writeChipSubmitCrIfNeeded(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
    admittedWorking = false,
  ): Promise<boolean> {
    this.traceState(bindingId, "chip.evaluate", { payloadMayChip: payloadMayChip(text) });
    if (!payloadMayChip(text)) return false;
    if (!this.pasteChip && !this.pendingText) return false;
    if (
      await this.tryChipSubmitCr(bindingId, generation, bindingGeneration, signal, admittedWorking)
    ) {
      return true;
    }
    if (this.pasteToCrSettleMs > 0) {
      if (
        !(await this.settle(bindingId, generation, bindingGeneration, signal))
      ) {
        return false;
      }
      return this.tryChipSubmitCr(
        bindingId,
        generation,
        bindingGeneration,
        signal,
        admittedWorking,
      );
    }
    return false;
  }

  private async tryChipSubmitCr(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
    admittedWorking = false,
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return false;
    }
    if (
      this.interlock.resizeActive(bindingId) &&
      !(await this.awaitResizeQuiet(bindingId, generation, bindingGeneration, signal))
    ) {
      return false;
    }
    if (!this.mayContinueSubmission(bindingId, admittedWorking)) return false;
    if (!this.chipVisible(bindingId)) return false;
    return this.writeSubmitCr(bindingId, generation, bindingGeneration, signal);
  }

  /**
   * Is the text the drive last wrote still pending on screen? The text comes
   * from the drive's own write record — every delivery path carries evidence
   * because no caller can forget to register it.
   */
  private pendingOnScreen(bindingId: string): boolean {
    const text = this.lastWrittenText.get(bindingId);
    return (
      text !== undefined &&
      this.pendingText !== undefined &&
      this.pendingText(bindingId, text)
    );
  }

  /** Chip chrome, or pendingText when the production pasteChip lookup is absent. */
  private chipVisible(bindingId: string): boolean {
    if (this.pasteChip) return this.pasteChip(bindingId);
    return this.pendingOnScreen(bindingId);
  }

  /** Wait for repaint quiet without releasing parked input or waiting forever. */
  private async awaitResizeQuiet(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const waitMs = this.interlock.resizeQuietInMs(bindingId);
      this.traceState(bindingId, "gate", { gate: "submit-resize-quiet", attempt, waitMs });
      if (waitMs <= 0) return true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        timer.unref?.();
      });
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) return false;
    }
    return !this.interlock.resizeActive(bindingId);
  }

  private async settle(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.traceState(bindingId, "settle.begin", { ms: this.pasteToCrSettleMs });
    if (this.pasteToCrSettleMs > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.pasteToCrSettleMs);
        t.unref?.();
      });
    }
    this.traceState(bindingId, "settle.end");
    return this.activeBinding(bindingId, generation, bindingGeneration, signal);
  }

  /** One extra CR when the first paste+CR did not produce turn-start. */
  private async writeSubmitCr(
    bindingId: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
    stage: "chip-cr" | "recovery-cr" = "chip-cr",
  ): Promise<boolean> {
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return false;
    }
    // Single atomic write under the hold: a keystroke in the evidence→CR
    // gap parks instead of becoming draft text our CR would submit.
    return this.withOperatorHold(bindingId, async () => {
      const accepted = await Promise.resolve(this.writeTraced(bindingId, CR, stage));
      return accepted && this.activeBinding(bindingId, generation, bindingGeneration, signal);
    });
  }

  /**
   * Continue our own accepted paste (chip or recovery CR). An idle admission
   * uses the destination's idle evidence; a working admission continues only
   * while the seat is still mid-turn on a readable screen.
   */
  private mayContinueSubmission(bindingId: string, admittedWorking: boolean): boolean {
    return (
      this.canContinueSubmission(bindingId) ||
      (admittedWorking && this.isSeatWorking(bindingId))
    );
  }

  /**
   * Acceptance for a write admitted into a live turn: a turn start, or the
   * composer letting go of our text after the paint-lag floor (the harness
   * queued or steered it). Without pending-text evidence nothing is proven.
   */
  private async awaitWorkingWriteTaken(
    bindingId: string,
    turnStartCount: number,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Counted in polls, not read off the clock: the window is timer time.
    const windowMs = Math.max(this.stallTimeoutMs, WORKING_WRITE_ACCEPT_FLOOR_MS);
    this.traceState(bindingId, "turn.wait", { timeoutMs: windowMs, working: true });
    for (let waited = 0; ; waited += WORKING_WRITE_POLL_MS) {
      if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) return false;
      if ((this.turnStartCounts.get(bindingId) ?? 0) !== turnStartCount) return true;
      if (
        waited >= WORKING_WRITE_ACCEPT_FLOOR_MS &&
        this.pendingText !== undefined &&
        !this.pendingOnScreen(bindingId)
      ) {
        return true;
      }
      if (waited >= windowMs) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WORKING_WRITE_POLL_MS);
        timer.unref?.();
      });
    }
  }

  private awaitTurnStart(
    bindingId: string,
    text: string,
    generation: number,
    bindingGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.traceState(bindingId, "turn.wait", { timeoutMs: this.stallTimeoutMs });
    if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const cancel = () => {
        if (this.pendingTurns.get(bindingId) === pending) {
          this.resolvePendingTurn(bindingId, false);
        }
      };
      const pending: PendingTurn = {
        generation,
        bindingGeneration,
        signal,
        text,
        resolve: (ok) => {
          signal?.removeEventListener("abort", cancel);
          resolve(ok);
        },
        timer: undefined,
      };
      pending.timer = setTimeout(() => {
        if (this.pendingTurns.get(bindingId) !== pending) return;
        this.pendingTurns.delete(bindingId);
        this.traceState(bindingId, "turn.timeout");
        pending.timer = undefined;
        if (!this.activeBinding(bindingId, generation, bindingGeneration, signal)) {
          pending.resolve(false);
          return;
        }
        // The caller owns recovery and the terminal outcome. Forcing attention
        // here would make its immediately following idle recovery gate fail.
        pending.resolve(false);
      }, this.stallTimeoutMs);
      pending.timer.unref?.();
      this.pendingTurns.set(bindingId, pending);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private resolvePendingTurn(bindingId: string, ok: boolean): void {
    const pending = this.pendingTurns.get(bindingId);
    if (pending === undefined) return;
    this.traceState(bindingId, "turn.resolve", { ok });
    this.pendingTurns.delete(bindingId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.resolve(
      ok &&
        this.activeBinding(
          bindingId,
          pending.generation,
          pending.bindingGeneration,
          pending.signal,
        ),
    );
  }

  private traceState(bindingId: string, event: string, fields: PtyTraceFields = {}): void {
    if (this.tracer === undefined) return;
    try {
      this.tracer.event(bindingId, event, {
        ...fields,
        inputActive: this.interlock.inputActive(bindingId),
        resizeActive: this.interlock.resizeActive(bindingId),
        holding: this.interlock.holding(bindingId),
        heldWrites: this.interlock.heldCount(bindingId),
        writing: this.writing.has(bindingId),
        pendingTurn: this.pendingTurns.has(bindingId),
      });
    } catch {
      // Diagnostic reads must never change drive behavior.
    }
  }

  private writeTraced(bindingId: string, data: string, stage: string): boolean | Promise<boolean> {
    if (this.tracer === undefined) return this.writeFn(bindingId, data);
    this.traceState(bindingId, "write.begin", { stage, bytes: Buffer.byteLength(data) });
    try {
      const result = this.writeFn(bindingId, data);
      if (typeof result === "boolean") {
        this.traceState(bindingId, "write.end", { stage, ok: result });
      } else {
        void result.then(
          (ok) => this.traceState(bindingId, "write.end", { stage, ok }),
          () => this.traceState(bindingId, "write.end", { stage, ok: false, threw: true }),
        );
      }
      return result;
    } catch (error) {
      this.traceState(bindingId, "write.end", { stage, ok: false, threw: true });
      throw error;
    }
  }
}
