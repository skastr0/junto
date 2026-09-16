/**
 * Single shared destination-drive runtime.
 *
 * Both the Electron main (Command Center) and the packaged Node Remote build
 * their process-local managed-terminal drive from this factory — one recipe,
 * parameterized only by evidence sources. The socket handler and overseer
 * never construct a drive; they resolve the bound holder and refuse
 * explicitly when it is missing.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import {
  ManagedTerminalDrive,
  type ClipboardSafeAssert,
  type ComposerVerdictLookup,
  type DriveAttentionCallback,
  type SeatHarnessLookup,
  type SeatIdleLookup,
  type TerminalWriter,
} from "./managed-terminal-drive";
import {
  promptHasPasteChip,
  promptStillPending,
} from "./prompt-evidence";

export type ManagedDriveSnapshot = {
  readonly text: string;
  readonly lines: readonly string[];
};

export type ManagedDriveFactoryDeps = {
  readonly write: TerminalWriter;
  readonly isSeatIdle: SeatIdleLookup;
  readonly seatState: (bindingId: string) => AgentSeatState | undefined;
  readonly onAttention: DriveAttentionCallback;
  readonly snapshot: (bindingId: string) => ManagedDriveSnapshot | undefined;
  readonly composerVerdict: ComposerVerdictLookup;
  readonly harnessFor: SeatHarnessLookup;
  /** Grok clipboard-image preflight (Electron only; omitted on Remote). */
  readonly assertClipboardSafe?: ClipboardSafeAssert;
};

export const createManagedTerminalDrive = (
  deps: ManagedDriveFactoryDeps,
): ManagedTerminalDrive =>
  new ManagedTerminalDrive({
    write: deps.write,
    // Unknown screen is never idle: without a snapshot the drive cannot
    // prove an empty composer, so nothing is admitted until one paints.
    isSeatIdle: (bindingId) =>
      deps.snapshot(bindingId) !== undefined && deps.isSeatIdle(bindingId),
    // Admission requires strong idle evidence. After our paste, its draft
    // may replace that chrome (e.g. Devin's welcome placeholder). Continue
    // only with an actual idle destination and positive evidence of our
    // pending draft. Unknown screens, working and permission states refuse.
    canContinueSubmission: (bindingId, text) => {
      const snap = deps.snapshot(bindingId);
      if (!snap || deps.seatState(bindingId) !== "idle") return false;
      return deps.isSeatIdle(bindingId) || (
        deps.composerVerdict(bindingId) === "draft" &&
        promptStillPending(snap, text)
      );
    },
    onAttention: deps.onAttention,
    // Evidence-gated acknowledgement: the drive only receipts a pending
    // prompt once our text has LEFT the composer. A missing snapshot proves
    // nothing — conservatively pending, never receipted without evidence.
    pendingText: (bindingId, text) => {
      const snap = deps.snapshot(bindingId);
      if (!snap) return true;
      return promptStillPending(snap, text);
    },
    // Chip-submit CR is chrome-only. A missing snapshot is conservatively
    // chip-present so the fast path cannot receipt what it cannot see.
    pasteChip: (bindingId) => {
      const snap = deps.snapshot(bindingId);
      if (!snap) return true;
      return promptHasPasteChip(snap);
    },
    composerVerdict: deps.composerVerdict,
    harnessFor: deps.harnessFor,
    ...(deps.assertClipboardSafe !== undefined
      ? { assertClipboardSafe: deps.assertClipboardSafe }
      : {}),
  });
