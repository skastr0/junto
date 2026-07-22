/**
 * Sealed process-signal authority — capability-based, not open kill(pid).
 *
 * HARD LAW:
 *   There is NO public API that accepts an arbitrary pid and delivers
 *   SIGTERM/SIGKILL. The only way to signal a process is:
 *
 *     1. registerOwnedProcess(...) at the moment Vellum spawns it
 *     2. keep the returned OwnedProcessHandle
 *     3. signalOwnedHandle(handle, signal)
 *
 *   Forging a handle with a random id fails registry lookup.
 *   Passing pid=1 / self / parent fails registration.
 *   process.kill(-pid) only runs when the registered record opted into
 *   ownsProcessGroup at spawn time (never from a free-form flag at kill time).
 *
 * Existence probes (signal 0) may use probeProcessAlive(pid) — never kills.
 */

import { randomBytes } from "node:crypto";
import { Context, Effect, Layer } from "effect";

export type ProcessSignalName = NodeJS.Signals | 0;

const ALLOWED_SIGNALS: ReadonlySet<string | number> = new Set([
  0,
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
]);

export type ProcessSignalDecision =
  | { readonly ok: true; readonly mode: "direct" | "group" | "existence" | "child" }
  | { readonly ok: false; readonly reason: string };

export type ProcessSignalAudit = {
  readonly at: number;
  readonly source: string;
  readonly pid: number | undefined;
  readonly signal: string;
  readonly requestedGroup: boolean;
  readonly decision: ProcessSignalDecision;
  readonly handleId?: string;
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
      `[process-signal-REFUSED] source=${full.source} handle=${full.handleId ?? "-"} pid=${String(full.pid)} signal=${full.signal} group=${full.requestedGroup} reason=${full.decision.reason}`,
    );
  }
  return full;
};

/**
 * Pure pid safety classifier — used at registration and before every OS kill.
 * Never sufficient alone to kill; registry membership is also required.
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
  if (raw === 0) return { ok: false, reason: "pid-zero-forbidden" };
  if (raw < 0) return { ok: false, reason: "negative-pid-forbidden" };

  const leader = raw;
  if (leader === 1) return { ok: false, reason: "pid-is-init-or-launchd" };
  if (leader === selfPid) return { ok: false, reason: "pid-is-self" };
  if (ppid !== undefined && leader === ppid) return { ok: false, reason: "pid-is-parent" };

  if (input.asProcessGroup) return { ok: true, mode: "group" };
  return { ok: true, mode: "direct" };
};

const classifySignalName = (signal: ProcessSignalName): ProcessSignalDecision => {
  if (!ALLOWED_SIGNALS.has(signal) && !ALLOWED_SIGNALS.has(String(signal))) {
    return { ok: false, reason: `signal-not-allowed:${String(signal)}` };
  }
  return { ok: true, mode: signal === 0 ? "existence" : "direct" };
};

export type SignalChildHandle = {
  readonly kill: (signal?: NodeJS.Signals) => void;
};

/**
 * Opaque capability. Only objects returned by registerOwnedProcess work.
 * A forged plain object with a guessed id will fail Map lookup.
 */
export type OwnedProcessHandle = {
  readonly id: string;
  readonly source: string;
  readonly pid: number;
  readonly ownsProcessGroup: boolean;
};

type RegistryRec = {
  readonly handle: OwnedProcessHandle;
  readonly pid: number;
  readonly ownsProcessGroup: boolean;
  readonly child: SignalChildHandle | undefined;
  readonly source: string;
  released: boolean;
};

/** Module-private — the only place that maps handles to kill authority. */
const registry = new Map<string, RegistryRec>();

export type RegisterOwnedProcessInput = {
  readonly source: string;
  readonly pid: number | undefined;
  /**
   * True only when THIS spawn used detached/new process group and `pid` is
   * the group leader we created. Frozen at registration — cannot be flipped
   * later at kill time.
   */
  readonly ownsProcessGroup: boolean;
  readonly child?: SignalChildHandle;
};

export type RegisterOwnedProcessResult =
  | { readonly ok: true; readonly handle: OwnedProcessHandle }
  | { readonly ok: false; readonly reason: string };

/**
 * Admit a process Vellum just spawned. Fails closed on dangerous pids.
 * Returns a capability handle required for any later signal.
 */
export const registerOwnedProcess = (
  input: RegisterOwnedProcessInput,
): RegisterOwnedProcessResult => {
  const classified = classifyProcessSignalTarget({
    pid: input.pid,
    asProcessGroup: input.ownsProcessGroup,
  });
  if (!classified.ok) {
    pushAudit({
      source: `register:${input.source}`,
      pid: input.pid,
      signal: "register",
      requestedGroup: input.ownsProcessGroup,
      decision: classified,
    });
    return { ok: false, reason: classified.reason };
  }
  const pid = input.pid;
  if (pid === undefined) {
    return { ok: false, reason: "pid-missing-or-non-integer" };
  }

  const id = `op_${randomBytes(12).toString("hex")}`;
  const handle: OwnedProcessHandle = Object.freeze({
    id,
    source: input.source,
    pid,
    ownsProcessGroup: Boolean(input.ownsProcessGroup),
  });
  registry.set(id, {
    handle,
    pid,
    ownsProcessGroup: handle.ownsProcessGroup,
    child: input.child,
    source: input.source,
    released: false,
  });
  return { ok: true, handle };
};

/** Drop kill authority (call on child exit). Idempotent. */
export const releaseOwnedProcess = (handle: OwnedProcessHandle | undefined): void => {
  if (!handle) return;
  const rec = registry.get(handle.id);
  if (!rec) return;
  rec.released = true;
  registry.delete(handle.id);
};

export type SignalOwnedResult = {
  readonly attempted: boolean;
  readonly decision: ProcessSignalDecision;
  readonly via: "child.kill" | "process.kill" | "process.kill-group" | "none";
};

/**
 * Signal a process we previously registered. No bare-pid overload exists.
 */
export const signalOwnedHandle = (
  handle: OwnedProcessHandle | undefined,
  signal: ProcessSignalName,
): SignalOwnedResult => {
  const signalOk = classifySignalName(signal);
  if (!handle) {
    pushAudit({
      source: "signal:missing-handle",
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: { ok: false, reason: "handle-missing" },
    });
    return { attempted: false, decision: { ok: false, reason: "handle-missing" }, via: "none" };
  }

  const rec = registry.get(handle.id);
  if (!rec || rec.released) {
    const decision = { ok: false as const, reason: "handle-not-registered" };
    pushAudit({
      source: handle.source,
      pid: handle.pid,
      signal: String(signal),
      requestedGroup: handle.ownsProcessGroup,
      decision,
      handleId: handle.id,
    });
    // If caller still has a child handle on the object graph, they must pass
    // it via register — we do not accept free child.kill bypass here for OS
    // kill. Unregistered = no OS signal.
    return { attempted: false, decision, via: "none" };
  }

  // Re-validate pid every time (defense in depth).
  const classified = classifyProcessSignalTarget({
    pid: rec.pid,
    asProcessGroup: rec.ownsProcessGroup && signal !== 0,
  });
  if (!signalOk.ok) {
    pushAudit({
      source: rec.source,
      pid: rec.pid,
      signal: String(signal),
      requestedGroup: rec.ownsProcessGroup,
      decision: signalOk,
      handleId: handle.id,
    });
    return { attempted: false, decision: signalOk, via: "none" };
  }
  if (!classified.ok) {
    pushAudit({
      source: rec.source,
      pid: rec.pid,
      signal: String(signal),
      requestedGroup: rec.ownsProcessGroup,
      decision: classified,
      handleId: handle.id,
    });
    return { attempted: false, decision: classified, via: "none" };
  }

  pushAudit({
    source: rec.source,
    pid: rec.pid,
    signal: String(signal),
    requestedGroup: rec.ownsProcessGroup && signal !== 0,
    decision: classified,
    handleId: handle.id,
  });

  // Prefer child handle when not doing an existence probe.
  if (rec.child && signal !== 0) {
    // When we own a process group, signal the group first so the tree dies;
    // child.kill alone may leave grandchildren.
    if (classified.mode === "group") {
      try {
        process.kill(-rec.pid, signal);
        return { attempted: true, decision: classified, via: "process.kill-group" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          return { attempted: true, decision: classified, via: "process.kill-group" };
        }
        // fall through to child
      }
    }
    try {
      rec.child.kill(signal);
      return { attempted: true, decision: classified, via: "child.kill" };
    } catch {
      // fall through
    }
  }

  if (signal === 0) {
    try {
      process.kill(rec.pid, 0);
      return { attempted: true, decision: { ok: true, mode: "existence" }, via: "process.kill" };
    } catch {
      return { attempted: false, decision: { ok: true, mode: "existence" }, via: "none" };
    }
  }

  if (classified.mode === "group") {
    try {
      process.kill(-rec.pid, signal);
      return { attempted: true, decision: classified, via: "process.kill-group" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { attempted: true, decision: classified, via: "process.kill-group" };
      }
    }
  }

  try {
    process.kill(rec.pid, signal);
    return { attempted: true, decision: classified, via: "process.kill" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { attempted: true, decision: classified, via: "process.kill" };
    }
    return { attempted: false, decision: classified, via: "none" };
  }
};

/**
 * Handle-less child.kill for test fakes / last-resort when registration failed.
 * NEVER calls process.kill. Domain-safe escape hatch only.
 */
export const signalChildHandleOnly = (
  child: SignalChildHandle | undefined,
  signal: NodeJS.Signals,
  source: string,
): SignalOwnedResult => {
  const signalOk = classifySignalName(signal);
  if (!signalOk.ok || signal === (0 as unknown as NodeJS.Signals)) {
    pushAudit({
      source,
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: signalOk.ok ? { ok: false, reason: "child-only-no-zero" } : signalOk,
    });
    return {
      attempted: false,
      decision: signalOk.ok ? { ok: false, reason: "child-only-no-zero" } : signalOk,
      via: "none",
    };
  }
  if (!child) {
    pushAudit({
      source,
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: { ok: false, reason: "child-missing" },
    });
    return { attempted: false, decision: { ok: false, reason: "child-missing" }, via: "none" };
  }
  try {
    child.kill(signal);
    pushAudit({
      source,
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: { ok: true, mode: "child" },
    });
    return { attempted: true, decision: { ok: true, mode: "child" }, via: "child.kill" };
  } catch {
    return { attempted: false, decision: { ok: true, mode: "child" }, via: "none" };
  }
};

/**
 * Existence probe only (signal 0). Never delivers a terminating signal.
 * Still refuses pid 0 / negative. Allows probing self/init (harmless).
 */
export const probeProcessAlive = (pid: number | undefined): boolean => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Test helper — live registry size. */
export const ownedProcessRegistrySizeForTests = (): number => registry.size;

/** Test helper — drop all registrations. */
export const clearOwnedProcessRegistryForTests = (): void => {
  registry.clear();
};

// ── Effect service (handle-only) ───────────────────────────────────────────

export class ProcessSignal extends Context.Tag("@vellum/ProcessSignal")<
  ProcessSignal,
  {
    readonly register: (
      input: RegisterOwnedProcessInput,
    ) => Effect.Effect<RegisterOwnedProcessResult>;
    readonly signal: (
      handle: OwnedProcessHandle | undefined,
      signal: ProcessSignalName,
    ) => Effect.Effect<SignalOwnedResult>;
    readonly release: (handle: OwnedProcessHandle | undefined) => Effect.Effect<void>;
    readonly classify: (
      input: Parameters<typeof classifyProcessSignalTarget>[0],
    ) => ProcessSignalDecision;
  }
>() {}

export const ProcessSignalLive = Layer.succeed(ProcessSignal, {
  register: (input) => Effect.sync(() => registerOwnedProcess(input)),
  signal: (handle, signal) => Effect.sync(() => signalOwnedHandle(handle, signal)),
  release: (handle) => Effect.sync(() => releaseOwnedProcess(handle)),
  classify: (input) => classifyProcessSignalTarget(input),
});
