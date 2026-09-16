import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { Schema } from "effect";
import {
  captureChildProcessEpoch,
  captureProcessEpoch,
  childProcessEpochIsCurrent,
  processGroupEpochIsCurrent,
  type ChildProcessEpoch,
  type ProcessGroupEpoch,
} from "./process-epoch";

const OwnedProcessTypeId: unique symbol = Symbol("@vellum-command/OwnedProcess");
export interface OwnedProcess { readonly [OwnedProcessTypeId]: typeof OwnedProcessTypeId; readonly source: string; }

export const KillablePid = Schema.Number.pipe(Schema.check(Schema.isInt()), 
  Schema.check(Schema.isGreaterThan(1)),
  Schema.check(Schema.makeFilter((pid) => pid !== globalThis.process.pid, { message: "pid must not be the Junto process" })),
  Schema.check(Schema.makeFilter((pid) => pid !== globalThis.process.ppid, { message: "pid must not be Junto's parent process" })),
  Schema.brand("KillablePid"),
);
export type KillablePid = typeof KillablePid.Type;
export const TerminatingSignal = Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2"]);
export type TerminatingSignal = typeof TerminatingSignal.Type;
export type SignalChildHandle = {
  /** Optional because some internal wrappers expose only an opaque handle. */
  readonly pid?: number;
  readonly kill: (signal?: NodeJS.Signals) => unknown;
};

type OwnedAuthority =
  | { readonly kind: "child-opaque"; readonly child: SignalChildHandle; readonly source: string; released: boolean }
  | { readonly kind: "child-verified"; readonly child: SignalChildHandle; readonly pid: KillablePid; readonly epoch: ChildProcessEpoch; readonly source: string; released: boolean }
  | { readonly kind: "child-refused"; readonly child: SignalChildHandle; readonly pid: number | undefined; readonly reason: string; readonly source: string; released: boolean }
  | { readonly kind: "group"; readonly child: SignalChildHandle; readonly pid: KillablePid; readonly epoch: ProcessGroupEpoch; readonly source: string; released: boolean };
const authority = new WeakMap<OwnedProcess, OwnedAuthority>();

export type ProcessSignalDecision =
  | { readonly ok: true; readonly mode: "child" | "group" }
  | { readonly ok: false; readonly reason: string };
export type ProcessSignalAudit = { readonly at: number; readonly source: string; readonly pid: number | undefined; readonly signal: string; readonly requestedGroup: boolean; readonly decision: ProcessSignalDecision };
const auditLog: ProcessSignalAudit[] = [];
export const getProcessSignalAuditLog = (): readonly ProcessSignalAudit[] => auditLog.slice();
export const clearProcessSignalAuditLog = (): void => { auditLog.length = 0; };
const pushAudit = (entry: Omit<ProcessSignalAudit, "at">): void => { auditLog.push({ at: Date.now(), ...entry }); if (auditLog.length > 400) auditLog.shift(); };

export const classifyProcessSignalTarget = (input: { readonly pid: number | undefined; readonly selfPid?: number; readonly ppid?: number }): ProcessSignalDecision => {
  const pid = input.pid;
  if (!Number.isInteger(pid) || pid === undefined || pid <= 1) return { ok: false, reason: "pid-not-killable" };
  if (pid === (input.selfPid ?? process.pid)) return { ok: false, reason: "pid-is-self" };
  if (pid === (input.ppid ?? process.ppid)) return { ok: false, reason: "pid-is-parent" };
  return { ok: true, mode: "child" };
};

const mint = (source: string, rec: OwnedAuthority): OwnedProcess => {
  const handle: OwnedProcess = { [OwnedProcessTypeId]: OwnedProcessTypeId, source };
  authority.set(handle, rec);
  return handle;
};

type ChildPidObservation =
  | { readonly kind: "opaque" }
  | { readonly kind: "present"; readonly pid: unknown }
  | { readonly kind: "unavailable" };

const observeChildPid = (child: SignalChildHandle): ChildPidObservation => {
  try {
    if (!("pid" in child)) return { kind: "opaque" };
    return { kind: "present", pid: (child as { readonly pid?: unknown }).pid };
  } catch {
    return { kind: "unavailable" };
  }
};

const mintRefusedChild = (source: string, child: SignalChildHandle, pid: number | undefined, reason: string): OwnedProcess =>
  mint(source, { kind: "child-refused", child, pid, reason, source, released: false });

const mintVerifiedChild = (source: string, child: SignalChildHandle, pid: KillablePid, epoch: ChildProcessEpoch): OwnedProcess =>
  mint(source, { kind: "child-verified", child, pid, epoch, source, released: false });

/**
 * Child-only capability. Truly pid-less wrappers stay opaque; a numeric child
 * is usable only after its exact start epoch is captured at admission.
 */
export const admitChildProcess = (input: { readonly source: string; readonly child: SignalChildHandle }): OwnedProcess => {
  const observation = observeChildPid(input.child);
  if (observation.kind === "opaque") {
    return mint(input.source, { kind: "child-opaque", child: input.child, source: input.source, released: false });
  }
  if (observation.kind === "unavailable" || observation.pid === undefined) {
    return mintRefusedChild(input.source, input.child, undefined, "child-pid-unavailable");
  }
  const decoded = Schema.decodeUnknownResult(KillablePid)(observation.pid);
  if (decoded._tag === "Failure") {
    return mintRefusedChild(
      input.source,
      input.child,
      typeof observation.pid === "number" ? observation.pid : undefined,
      "child-pid-not-killable",
    );
  }
  const epoch = captureChildProcessEpoch(decoded.success);
  return epoch
    ? mintVerifiedChild(input.source, input.child, decoded.success, epoch)
    : mintRefusedChild(input.source, input.child, decoded.success, "child-epoch-unavailable");
};

export type DetachedProcessGroup = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly process: OwnedProcess;
  readonly mode: "group" | "child";
};
/** The sole mint site for POSIX process-group authority. Detached is not caller-configurable. */
export const spawnDetachedProcessGroup = (input: { readonly source: string; readonly command: string; readonly args: readonly string[]; readonly options?: Omit<SpawnOptionsWithoutStdio, "detached"> }): DetachedProcessGroup => {
  const child = spawn(input.command, [...input.args], { ...input.options, detached: true, stdio: "pipe" });
  const pid = child.pid;
  const decoded = Schema.decodeUnknownResult(KillablePid)(pid);
  // Bind the child handle at spawn. A later mutation of ChildProcess.kill
  // cannot redirect either exact-leader or group-owned signal authority.
  const signalSink: SignalChildHandle = Object.freeze({
    ...(pid === undefined ? {} : { pid }),
    kill: child.kill.bind(child),
  });
  if (decoded._tag === "Failure" || pid === undefined) {
    return {
      child,
      process: mintRefusedChild(input.source, signalSink, typeof pid === "number" ? pid : undefined, "child-pid-not-killable"),
      mode: "child",
    };
  }
  // One snapshot supplies both identities. If group proof is absent, the
  // fallback reuses the already-verified exact-child epoch rather than
  // silently reopening unverified child authority.
  const captured = captureProcessEpoch(decoded.success);
  if (!captured) {
    return {
      child,
      process: mintRefusedChild(input.source, signalSink, decoded.success, "child-epoch-unavailable"),
      mode: "child",
    };
  }
  if (process.platform !== "win32" && captured.group) {
    return {
      child,
      process: mint(input.source, {
        kind: "group",
        child: signalSink,
        pid: decoded.success,
        epoch: captured.group,
        source: input.source,
        released: false,
      }),
      mode: "group",
    };
  }
  return {
    child,
    process: mintVerifiedChild(input.source, signalSink, decoded.success, captured.child),
    mode: "child",
  };
};

export type SignalOwnedResult = { readonly attempted: boolean; readonly decision: ProcessSignalDecision; readonly via: "child.kill" | "process.kill-group" | "none" };
const refuseChildSignal = (rec: OwnedAuthority, signal: TerminatingSignal, reason: string): SignalOwnedResult => {
  const decision = { ok: false, reason } as const;
  pushAudit({
    source: rec.source,
    pid: "pid" in rec ? rec.pid : undefined,
    signal,
    requestedGroup: false,
    decision,
  });
  return { attempted: false, decision, via: "none" };
};
const signalChild = (rec: OwnedAuthority, signal: TerminatingSignal): SignalOwnedResult => {
  try {
    const result = rec.child.kill(signal);
    if (result === false) return refuseChildSignal(rec, signal, "child-signal-refused");
    return { attempted: true, decision: { ok: true, mode: "child" }, via: "child.kill" };
  } catch {
    return refuseChildSignal(rec, signal, "child-signal-failed");
  }
};
export const signalOwned = (process: OwnedProcess, signal: TerminatingSignal): SignalOwnedResult => {
  const rec = authority.get(process);
  if (!rec || rec.released) return { attempted: false, decision: { ok: false, reason: "handle-not-registered" }, via: "none" };
  if (Schema.decodeUnknownResult(TerminatingSignal)(signal)._tag === "Failure") return { attempted: false, decision: { ok: false, reason: "signal-not-allowed" }, via: "none" };
  if (rec.kind === "child-refused") return refuseChildSignal(rec, signal, rec.reason);
  if (rec.kind === "child-opaque") return signalChild(rec, signal);
  if (rec.kind === "child-verified") {
    const current = observeChildPid(rec.child);
    if (current.kind !== "present" || current.pid === undefined) {
      return refuseChildSignal(rec, signal, "child-pid-unavailable");
    }
    if (current.pid !== rec.pid) return refuseChildSignal(rec, signal, "child-pid-mismatch");
    if (!childProcessEpochIsCurrent(rec.pid, rec.epoch)) {
      return refuseChildSignal(rec, signal, "child-epoch-mismatch");
    }
    return signalChild(rec, signal);
  }
  if (!processGroupEpochIsCurrent(rec.pid, rec.epoch)) {
    pushAudit({ source: rec.source, pid: rec.pid, signal, requestedGroup: true, decision: { ok: false, reason: "group-epoch-mismatch" } });
    return { attempted: false, decision: { ok: false, reason: "group-epoch-mismatch" }, via: "none" };
  }
  try {
    // Sole terminating process.kill in Junto: negative verified group leader only.
    globalThis.process.kill(-rec.pid, signal);
    return { attempted: true, decision: { ok: true, mode: "group" }, via: "process.kill-group" };
  } catch {
    pushAudit({ source: rec.source, pid: rec.pid, signal, requestedGroup: true, decision: { ok: false, reason: "group-signal-failed" } });
    return { attempted: false, decision: { ok: false, reason: "group-signal-failed" }, via: "none" };
  }
};

/**
 * Attenuated graceful signal for a verified detached group: address only its
 * exact original leader through the spawn-bound child handle. Group authority
 * remains available to `signalOwned` for bounded escalation after the leader
 * has had a chance to coordinate its own descendants.
 */
export const signalOwnedGroupLeader = (
  process: OwnedProcess,
  signal: TerminatingSignal,
): SignalOwnedResult => {
  const rec = authority.get(process);
  if (!rec || rec.released) {
    return {
      attempted: false,
      decision: { ok: false, reason: "handle-not-registered" },
      via: "none",
    };
  }
  if (signal !== "SIGTERM") {
    return {
      attempted: false,
      decision: { ok: false, reason: "leader-signal-not-allowed" },
      via: "none",
    };
  }
  if (rec.kind !== "group") {
    return refuseChildSignal(rec, signal, "group-leader-authority-required");
  }
  if (!processGroupEpochIsCurrent(rec.pid, rec.epoch)) {
    pushAudit({
      source: rec.source,
      pid: rec.pid,
      signal,
      requestedGroup: false,
      decision: { ok: false, reason: "group-epoch-mismatch" },
    });
    return {
      attempted: false,
      decision: { ok: false, reason: "group-epoch-mismatch" },
      via: "none",
    };
  }
  return signalChild(rec, signal);
};
export const releaseOwned = (process: OwnedProcess | undefined): void => { if (!process) return; const rec = authority.get(process); if (!rec) return; rec.released = true; authority.delete(process); };
/** Existence probe only, never a terminating signal. */
export const probeProcessAlive = (pid: number | undefined): boolean => { try { return pid !== undefined && pid > 0 ? globalThis.process.kill(pid, 0) : false; } catch { return false; } };
