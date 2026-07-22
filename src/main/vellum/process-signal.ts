import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { Schema } from "effect";
import { captureProcessGroupEpoch, processGroupEpochIsCurrent, type ProcessGroupEpoch } from "./process-epoch";

const OwnedProcessTypeId: unique symbol = Symbol("@vellum/OwnedProcess");
export interface OwnedProcess { readonly [OwnedProcessTypeId]: typeof OwnedProcessTypeId; readonly source: string; }

export const KillablePid = Schema.Int.pipe(
  Schema.greaterThan(1),
  Schema.filter((pid) => pid !== globalThis.process.pid, { message: () => "pid must not be Vellum" }),
  Schema.filter((pid) => pid !== globalThis.process.ppid, { message: () => "pid must not be Vellum parent" }),
  Schema.brand("KillablePid"),
);
export type KillablePid = typeof KillablePid.Type;
export const TerminatingSignal = Schema.Literal("SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2");
export type TerminatingSignal = typeof TerminatingSignal.Type;
export type SignalChildHandle = { readonly kill: (signal?: NodeJS.Signals) => void };

type OwnedAuthority =
  | { readonly kind: "child"; readonly child: SignalChildHandle; readonly source: string; released: boolean }
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

/** Child-only capability: contains no pid and can only invoke child.kill(). */
export const admitChildProcess = (input: { readonly source: string; readonly child: SignalChildHandle }): OwnedProcess =>
  mint(input.source, { kind: "child", child: input.child, source: input.source, released: false });

export type DetachedProcessGroup = { readonly child: ChildProcessWithoutNullStreams; readonly process: OwnedProcess; readonly mode: "group" | "child" };
/** The sole mint site for POSIX process-group authority. Detached is not caller-configurable. */
export const spawnDetachedProcessGroup = (input: { readonly source: string; readonly command: string; readonly args: readonly string[]; readonly options?: Omit<SpawnOptionsWithoutStdio, "detached"> }): DetachedProcessGroup => {
  const child = spawn(input.command, [...input.args], { ...input.options, detached: true, stdio: "pipe" });
  const pid = child.pid;
  const decoded = Schema.decodeUnknownEither(KillablePid)(pid);
  const epoch = process.platform === "win32" || decoded._tag === "Left" || pid === undefined ? undefined : captureProcessGroupEpoch(pid);
  const ownedProcess = epoch && decoded._tag === "Right"
    ? mint(input.source, { kind: "group", child, pid: decoded.right, epoch, source: input.source, released: false })
    : admitChildProcess({ source: input.source, child });
  return { child, process: ownedProcess, mode: epoch && decoded._tag === "Right" ? "group" : "child" };
};

export type SignalOwnedResult = { readonly attempted: boolean; readonly decision: ProcessSignalDecision; readonly via: "child.kill" | "process.kill-group" | "none" };
const signalChild = (rec: OwnedAuthority, signal: TerminatingSignal): SignalOwnedResult => {
  try { rec.child.kill(signal); return { attempted: true, decision: { ok: true, mode: "child" }, via: "child.kill" }; }
  catch { return { attempted: false, decision: { ok: true, mode: "child" }, via: "none" }; }
};
export const signalOwned = (process: OwnedProcess, signal: TerminatingSignal): SignalOwnedResult => {
  const rec = authority.get(process);
  if (!rec || rec.released) return { attempted: false, decision: { ok: false, reason: "handle-not-registered" }, via: "none" };
  if (Schema.decodeUnknownEither(TerminatingSignal)(signal)._tag === "Left") return { attempted: false, decision: { ok: false, reason: "signal-not-allowed" }, via: "none" };
  if (rec.kind === "child") return signalChild(rec, signal);
  if (!processGroupEpochIsCurrent(rec.pid, rec.epoch)) {
    pushAudit({ source: rec.source, pid: rec.pid, signal, requestedGroup: true, decision: { ok: false, reason: "group-epoch-mismatch" } });
    return { attempted: false, decision: { ok: false, reason: "group-epoch-mismatch" }, via: "none" };
  }
  try {
    // Sole terminating process.kill in Vellum: negative verified group leader only.
    globalThis.process.kill(-rec.pid, signal);
    return { attempted: true, decision: { ok: true, mode: "group" }, via: "process.kill-group" };
  } catch {
    pushAudit({ source: rec.source, pid: rec.pid, signal, requestedGroup: true, decision: { ok: false, reason: "group-signal-failed" } });
    return { attempted: false, decision: { ok: false, reason: "group-signal-failed" }, via: "none" };
  }
};
export const releaseOwned = (process: OwnedProcess | undefined): void => { if (!process) return; const rec = authority.get(process); if (!rec) return; rec.released = true; authority.delete(process); };
/** Existence probe only, never a terminating signal. */
export const probeProcessAlive = (pid: number | undefined): boolean => { try { return pid !== undefined && pid > 0 ? globalThis.process.kill(pid, 0) : false; } catch { return false; } };
