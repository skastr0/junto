/**
 * Process-signal authority — architecturally closed.
 *
 * Pattern matches ssh/domain RemoteCommand:
 *   - unique symbol brand on the public handle type
 *   - private WeakMap holds kill authority (pid, group flag, child)
 *   - only `admitSpawnedProcess` can mint a handle (validates pid)
 *   - only `signalOwned` / `releaseOwned` accept the branded type
 *
 * There is NO function of the form:
 *   kill(pid: number, signal) | signalOwnedProcess({ pid })
 *
 * A plain object `{ id, pid, ... }` is not assignable to OwnedProcess
 * (missing unique symbol). Even at runtime, WeakMap lookup fails for
 * anything not minted here.
 *
 * process.kill(-pid) exists only inside this module, and only after
 * WeakMap proves the handle was admitted with ownsProcessGroup=true.
 */

import { Context, Effect, Layer, Schema } from "effect";

// ── Brand (type-system seal) ───────────────────────────────────────────────

const OwnedProcessTypeId: unique symbol = Symbol("@vellum/OwnedProcess");

/**
 * Opaque capability. Cannot be constructed outside this module.
 * Structural impostors fail: they lack `[OwnedProcessTypeId]`.
 */
export interface OwnedProcess {
  readonly [OwnedProcessTypeId]: typeof OwnedProcessTypeId;
  /** Audit / debug label only — never used as a kill key. */
  readonly source: string;
}

// ── Domain schemas (parse, don't trust) ────────────────────────────────────

/** Positive integer pid that is not init/self/parent — Effect Schema. */
export const KillablePid = Schema.Int.pipe(
  Schema.greaterThan(1),
  Schema.filter((pid) => pid !== process.pid, {
    message: () => "pid must not be the Vellum process itself",
  }),
  Schema.filter(
    (pid) => typeof process.ppid !== "number" || pid !== process.ppid,
    { message: () => "pid must not be the parent process" },
  ),
  Schema.brand("KillablePid"),
);
export type KillablePid = typeof KillablePid.Type;

export const TerminatingSignal = Schema.Literal(
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
);
export type TerminatingSignal = typeof TerminatingSignal.Type;

// ── Private authority store ────────────────────────────────────────────────

export type SignalChildHandle = {
  readonly kill: (signal?: NodeJS.Signals) => void;
};

type OwnedAuthority = {
  readonly pid: KillablePid;
  readonly ownsProcessGroup: boolean;
  readonly child: SignalChildHandle | undefined;
  readonly source: string;
  released: boolean;
};

/** ONLY place pid + kill rights live. Keyed by branded handle identity. */
const authority = new WeakMap<OwnedProcess, OwnedAuthority>();

// ── Audit (observability, not the safety mechanism) ────────────────────────

export type ProcessSignalDecision =
  | { readonly ok: true; readonly mode: "direct" | "group" | "child" | "existence" }
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

const pushAudit = (entry: Omit<ProcessSignalAudit, "at">): void => {
  auditLog.push({ at: Date.now(), ...entry });
  if (auditLog.length > 400) auditLog.shift();
  if (!entry.decision.ok) {
    console.error(
      `[process-signal-REFUSED] source=${entry.source} pid=${String(entry.pid)} signal=${entry.signal} group=${entry.requestedGroup} reason=${entry.decision.reason}`,
    );
  }
};

// ── Pure classification (for docs/tests; admission uses Schema) ────────────

export const classifyProcessSignalTarget = (input: {
  readonly pid: number | undefined;
  readonly selfPid?: number;
  readonly ppid?: number;
}): ProcessSignalDecision => {
  const selfPid = input.selfPid ?? process.pid;
  const ppid = input.ppid ?? (typeof process.ppid === "number" ? process.ppid : undefined);
  const raw = input.pid;
  if (raw === undefined || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, reason: "pid-missing-or-non-integer" };
  }
  if (raw <= 1) return { ok: false, reason: raw === 1 ? "pid-is-init-or-launchd" : "pid-non-positive" };
  if (raw === selfPid) return { ok: false, reason: "pid-is-self" };
  if (ppid !== undefined && raw === ppid) return { ok: false, reason: "pid-is-parent" };
  return { ok: true, mode: "direct" };
};

// ── Admission (only mint site) ─────────────────────────────────────────────

export type AdmitSpawnedProcessInput = {
  readonly source: string;
  readonly pid: number | undefined;
  /**
   * Frozen at admit time. true only when this spawn created an isolated
   * process group and pid is that group's leader.
   */
  readonly ownsProcessGroup: boolean;
  readonly child?: SignalChildHandle;
};

export type AdmitSpawnedProcessResult =
  | { readonly ok: true; readonly process: OwnedProcess }
  | { readonly ok: false; readonly reason: string };

/**
 * Mint an OwnedProcess for a child Vellum just spawned.
 * Decodes pid through KillablePid schema — init/self/parent cannot enter.
 */
export const admitSpawnedProcess = (
  input: AdmitSpawnedProcessInput,
): AdmitSpawnedProcessResult => {
  const decoded = Schema.decodeUnknownEither(KillablePid)(input.pid);
  if (decoded._tag === "Left") {
    const reason =
      input.pid === 1
        ? "pid-is-init-or-launchd"
        : input.pid === process.pid
          ? "pid-is-self"
          : typeof process.ppid === "number" && input.pid === process.ppid
            ? "pid-is-parent"
            : input.pid === undefined || (typeof input.pid === "number" && input.pid <= 0)
              ? input.pid === 0
                ? "pid-zero-forbidden"
                : "pid-non-positive"
              : "pid-not-killable";
    pushAudit({
      source: `admit:${input.source}`,
      pid: typeof input.pid === "number" ? input.pid : undefined,
      signal: "admit",
      requestedGroup: input.ownsProcessGroup,
      decision: { ok: false, reason },
    });
    return { ok: false, reason };
  }

  const pid = decoded.right;
  const handle: OwnedProcess = {
    [OwnedProcessTypeId]: OwnedProcessTypeId,
    source: input.source,
  };
  authority.set(handle, {
    pid,
    ownsProcessGroup: Boolean(input.ownsProcessGroup),
    child: input.child,
    source: input.source,
    released: false,
  });
  return { ok: true, process: handle };
};

/** @deprecated alias — prefer admitSpawnedProcess */
export const registerOwnedProcess = (
  input: AdmitSpawnedProcessInput,
):
  | { readonly ok: true; readonly handle: OwnedProcess }
  | { readonly ok: false; readonly reason: string } => {
  const r = admitSpawnedProcess(input);
  if (!r.ok) return r;
  return { ok: true, handle: r.process };
};

/** @deprecated use OwnedProcess */
export type OwnedProcessHandle = OwnedProcess;

// ── Signal (only accepts branded OwnedProcess) ─────────────────────────────

export type SignalOwnedResult = {
  readonly attempted: boolean;
  readonly decision: ProcessSignalDecision;
  readonly via: "child.kill" | "process.kill" | "process.kill-group" | "none";
};

/**
 * Signal a process admitted via admitSpawnedProcess.
 * Parameter type is OwnedProcess — bare numbers / plain objects do not typecheck.
 */
export const signalOwned = (
  process: OwnedProcess,
  signal: TerminatingSignal,
): SignalOwnedResult => {
  const signalDecoded = Schema.decodeUnknownEither(TerminatingSignal)(signal);
  if (signalDecoded._tag === "Left") {
    pushAudit({
      source: process.source,
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: { ok: false, reason: "signal-not-allowed" },
    });
    return { attempted: false, decision: { ok: false, reason: "signal-not-allowed" }, via: "none" };
  }

  const rec = authority.get(process);
  if (!rec || rec.released) {
    pushAudit({
      source: process.source,
      pid: undefined,
      signal,
      requestedGroup: false,
      decision: { ok: false, reason: "handle-not-registered" },
    });
    return {
      attempted: false,
      decision: { ok: false, reason: "handle-not-registered" },
      via: "none",
    };
  }

  // Re-validate brand still maps and pid still killable (defense in depth).
  const still = Schema.decodeUnknownEither(KillablePid)(rec.pid);
  if (still._tag === "Left") {
    pushAudit({
      source: rec.source,
      pid: rec.pid,
      signal,
      requestedGroup: rec.ownsProcessGroup,
      decision: { ok: false, reason: "pid-no-longer-killable" },
    });
    return {
      attempted: false,
      decision: { ok: false, reason: "pid-no-longer-killable" },
      via: "none",
    };
  }

  const wantsGroup = rec.ownsProcessGroup;
  pushAudit({
    source: rec.source,
    pid: rec.pid,
    signal,
    requestedGroup: wantsGroup,
    decision: { ok: true, mode: wantsGroup ? "group" : "direct" },
  });

  if (wantsGroup) {
    try {
      // Sole process.kill(-pid) site in the product.
      globalThis.process.kill(-rec.pid, signal);
      return {
        attempted: true,
        decision: { ok: true, mode: "group" },
        via: "process.kill-group",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return {
          attempted: true,
          decision: { ok: true, mode: "group" },
          via: "process.kill-group",
        };
      }
      // fall through to child / direct
    }
  }

  if (rec.child) {
    try {
      rec.child.kill(signal);
      return { attempted: true, decision: { ok: true, mode: "child" }, via: "child.kill" };
    } catch {
      // fall through
    }
  }

  try {
    globalThis.process.kill(rec.pid, signal);
    return { attempted: true, decision: { ok: true, mode: "direct" }, via: "process.kill" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { attempted: true, decision: { ok: true, mode: "direct" }, via: "process.kill" };
    }
    return { attempted: false, decision: { ok: true, mode: "direct" }, via: "none" };
  }
};

/** @deprecated prefer signalOwned */
export const signalOwnedHandle = (
  handle: OwnedProcess | undefined,
  signal: NodeJS.Signals | 0,
): SignalOwnedResult => {
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
  if (signal === 0) {
    return {
      attempted: false,
      decision: { ok: false, reason: "use-probeProcessAlive-for-zero" },
      via: "none",
    };
  }
  return signalOwned(handle, signal as TerminatingSignal);
};

export const releaseOwned = (process: OwnedProcess | undefined): void => {
  if (!process) return;
  const rec = authority.get(process);
  if (!rec) return;
  rec.released = true;
  authority.delete(process);
};

/** @deprecated */
export const releaseOwnedProcess = releaseOwned;

/**
 * Child-handle-only path when admit failed (e.g. test fake with pid=self).
 * PHYSICALLY cannot call process.kill — no pid is accepted.
 */
export const signalChildHandleOnly = (
  child: SignalChildHandle | undefined,
  signal: TerminatingSignal,
  source: string,
): SignalOwnedResult => {
  const signalDecoded = Schema.decodeUnknownEither(TerminatingSignal)(signal);
  if (signalDecoded._tag === "Left") {
    pushAudit({
      source,
      pid: undefined,
      signal: String(signal),
      requestedGroup: false,
      decision: { ok: false, reason: "signal-not-allowed" },
    });
    return { attempted: false, decision: { ok: false, reason: "signal-not-allowed" }, via: "none" };
  }
  if (!child) {
    pushAudit({
      source,
      pid: undefined,
      signal,
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
      signal,
      requestedGroup: false,
      decision: { ok: true, mode: "child" },
    });
    return { attempted: true, decision: { ok: true, mode: "child" }, via: "child.kill" };
  } catch {
    return { attempted: false, decision: { ok: true, mode: "child" }, via: "none" };
  }
};

/** Existence only — never terminating. Separate API so kill surface stays closed. */
export const probeProcessAlive = (pid: number | undefined): boolean => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ── Effect service: only branded operations ────────────────────────────────

export class ProcessSignal extends Context.Tag("@vellum/ProcessSignal")<
  ProcessSignal,
  {
    readonly admit: (
      input: AdmitSpawnedProcessInput,
    ) => Effect.Effect<AdmitSpawnedProcessResult>;
    readonly signal: (
      process: OwnedProcess,
      signal: TerminatingSignal,
    ) => Effect.Effect<SignalOwnedResult>;
    readonly release: (process: OwnedProcess | undefined) => Effect.Effect<void>;
  }
>() {}

export const ProcessSignalLive = Layer.succeed(ProcessSignal, {
  admit: (input) => Effect.sync(() => admitSpawnedProcess(input)),
  signal: (process, signal) => Effect.sync(() => signalOwned(process, signal)),
  release: (process) => Effect.sync(() => releaseOwned(process)),
});

// ── Test helpers (no kill authority) ───────────────────────────────────────

export const ownedProcessRegistrySizeForTests = (): number => {
  // WeakMap has no size — track via audit of successful admits minus releases is imprecise.
  // Expose nothing that can kill. Tests use admit/signal directly.
  return 0;
};

export const clearOwnedProcessRegistryForTests = (): void => {
  // WeakMap entries drop when handles are GC'd; tests hold handles in scope.
  // No global clear of kill rights without handles — by design.
};
