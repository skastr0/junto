/**
 * Sealed process-signal authority.
 *
 * THIS is the only module allowed to call `process.kill` with a negative pid
 * (POSIX process-group signal). Terminal / adapter / ssh code must go through
 * here — never raw `process.kill(-pid)`.
 *
 * Hard refusals (cannot be overridden):
 *   - pid missing / non-integer / ≤ 0
 *   - pid === 1          (init / launchd)  → process.kill(-1) is host-wide blast
 *   - pid === process.pid (self)           → process.kill(-self) kills our PG
 *   - pid === process.ppid (parent)        → can take down Electron / Amp / shell
 *   - group signal when |pgid| is any of the above
 *
 * Process-group kill is opt-in and only when the caller asserts they created
 * an isolated group for that leader (`ownsProcessGroup: true`).
 */

import { Context, Effect, Layer } from "effect";

export type ProcessSignalName = NodeJS.Signals | 0;

export type ProcessSignalDecision =
  | { readonly ok: true; readonly mode: "direct" | "group" | "existence" }
  | { readonly ok: false; readonly reason: string };

export type ProcessSignalAudit = {
  readonly at: number;
  readonly source: string;
  readonly pid: number | undefined;
  readonly signal: string;
  readonly requestedGroup: boolean;
  readonly decision: ProcessSignalDecision;
};

const auditLog: ProcessSignalAudit[] = [];

export const getProcessSignalAuditLog = (): readonly ProcessSignalAudit[] => auditLog.slice();
export const clearProcessSignalAuditLog = (): void => {
  auditLog.length = 0;
};

const pushAudit = (entry: Omit<ProcessSignalAudit, "at">): ProcessSignalAudit => {
  const full: ProcessSignalAudit = { at: Date.now(), ...entry };
  auditLog.push(full);
  if (auditLog.length > 400) auditLog.shift();
  if (!full.decision.ok) {
    console.error(
      `[process-signal-REFUSED] source=${full.source} pid=${String(full.pid)} signal=${full.signal} group=${full.requestedGroup} reason=${full.decision.reason}`,
    );
  }
  return full;
};

/**
 * Pure classifier — no side effects. Used by production + tests.
 * `target` is the pid that would be passed to process.kill (positive for
 * direct, or the absolute value when a group signal is requested).
 */
export const classifyProcessSignalTarget = (input: {
  readonly pid: number | undefined;
  readonly asProcessGroup?: boolean;
  readonly selfPid?: number;
  readonly ppid?: number;
}): ProcessSignalDecision => {
  const selfPid = input.selfPid ?? process.pid;
  const ppid = input.ppid ?? (typeof process.ppid === "number" ? process.ppid : undefined);
  const raw = input.pid;

  if (raw === undefined || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, reason: "pid-missing-or-non-integer" };
  }

  // Existence probe allows 0? No — kill(0, 0) is "every process we can signal".
  if (raw === 0) return { ok: false, reason: "pid-zero-forbidden" };
  if (raw < 0 && !input.asProcessGroup) {
    return { ok: false, reason: "negative-pid-without-group-flag" };
  }

  const leader = input.asProcessGroup ? Math.abs(raw) : raw;
  if (!Number.isInteger(leader) || leader <= 0) {
    return { ok: false, reason: `invalid-leader:${String(leader)}` };
  }
  if (leader === 1) return { ok: false, reason: "pid-is-init-or-launchd" };
  if (leader === selfPid) return { ok: false, reason: "pid-is-self" };
  if (ppid !== undefined && leader === ppid) return { ok: false, reason: "pid-is-parent" };

  if (input.asProcessGroup) return { ok: true, mode: "group" };
  return { ok: true, mode: "direct" };
};

export type SignalChildHandle = {
  readonly kill: (signal?: NodeJS.Signals) => void;
};

export type SignalOwnedInput = {
  /** Caller identity for audit (e.g. "term.forceKill", "adapter.quit"). */
  readonly source: string;
  /** OS pid of the child / group leader. */
  readonly pid: number | undefined;
  readonly signal: ProcessSignalName;
  /**
   * Only true when THIS process created an isolated process group for `pid`
   * (e.g. spawn({ detached: true }) and we are the group leader's parent).
   * Default false — never process-group-kill node-pty or untrusted pids.
   */
  readonly ownsProcessGroup?: boolean;
  /** Preferred path: the handle we spawned. Always tried when present. */
  readonly child?: SignalChildHandle;
};

export type SignalOwnedResult = {
  readonly attempted: boolean;
  readonly decision: ProcessSignalDecision;
  readonly via: "child.kill" | "process.kill" | "process.kill-group" | "none";
};

/**
 * Signal a process we own. Order:
 *  1. Classify pid — refuse init/self/parent/zero.
 *  2. If refused → still may child.kill (safe handle) but NEVER process.kill*.
 *  3. If ownsProcessGroup && group-ok → process.kill(-pid) (only sealed site).
 *  4. Else if child handle → child.kill (term/node-pty/fakes).
 *  5. Else if direct-ok → process.kill(pid).
 *  6. Else no-op.
 *
 * signal 0 is existence-only and never uses the group form.
 */
export const signalOwnedProcess = (input: SignalOwnedInput): SignalOwnedResult => {
  const wantsGroup = Boolean(input.ownsProcessGroup) && input.signal !== 0;
  const classified = classifyProcessSignalTarget({
    pid: input.pid,
    asProcessGroup: wantsGroup,
  });

  pushAudit({
    source: input.source,
    pid: input.pid,
    signal: String(input.signal),
    requestedGroup: wantsGroup,
    decision: classified,
  });

  const pid = input.pid;

  // Refused targets: handle-only. Never touch process.kill.
  if (!classified.ok) {
    if (input.child && input.signal !== 0) {
      try {
        input.child.kill(input.signal);
        return { attempted: true, decision: classified, via: "child.kill" };
      } catch {
        /* ignore */
      }
    }
    return { attempted: false, decision: classified, via: "none" };
  }

  // Group path only when caller owns the group AND classifier allowed it.
  if (classified.mode === "group" && pid !== undefined) {
    try {
      process.kill(-pid, input.signal);
      return { attempted: true, decision: classified, via: "process.kill-group" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { attempted: true, decision: classified, via: "process.kill-group" };
      }
      // Fall through to child / direct.
    }
  }

  if (input.child && input.signal !== 0) {
    try {
      input.child.kill(input.signal);
      return { attempted: true, decision: classified, via: "child.kill" };
    } catch {
      // fall through
    }
  }

  if (pid === undefined) {
    return { attempted: false, decision: classified, via: "none" };
  }

  try {
    process.kill(pid, input.signal);
    return { attempted: true, decision: classified, via: "process.kill" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { attempted: true, decision: classified, via: "process.kill" };
    }
    return { attempted: false, decision: classified, via: "none" };
  }
};

/** Existence probe — never group, never dangerous pids. */
export const processExists = (pid: number | undefined, source = "processExists"): boolean => {
  const result = signalOwnedProcess({ source, pid, signal: 0, ownsProcessGroup: false });
  return result.attempted && result.decision.ok;
};

// ── Effect service surface (for Effect-land callers) ───────────────────────

export class ProcessSignal extends Context.Tag("@vellum/ProcessSignal")<
  ProcessSignal,
  {
    readonly signalOwned: (input: SignalOwnedInput) => Effect.Effect<SignalOwnedResult>;
    readonly exists: (pid: number | undefined, source?: string) => Effect.Effect<boolean>;
    readonly classify: (
      input: Parameters<typeof classifyProcessSignalTarget>[0],
    ) => ProcessSignalDecision;
  }
>() {}

export const ProcessSignalLive = Layer.succeed(ProcessSignal, {
  signalOwned: (input) => Effect.sync(() => signalOwnedProcess(input)),
  exists: (pid, source) => Effect.sync(() => processExists(pid, source)),
  classify: (input) => classifyProcessSignalTarget(input),
});
