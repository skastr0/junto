/**
 * App-scoped local terminal session authority.
 * Owns child processes (PTY when available, pipe fallback otherwise).
 * Presentation (xterm) is a consumer — never co-located as process owner.
 * Product law: app quit stops all local sessions (no LaunchAgent survive-quit).
 */

import { EventEmitter } from "node:events";
import { spawn as cpSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import { getProcessIdentityMap } from "../process-identity";
import {
  admitChildProcess,
  classifyProcessSignalTarget,
  clearProcessSignalAuditLog,
  getProcessSignalAuditLog,
  releaseOwned,
  signalOwned,
  type OwnedProcess,
  type ProcessSignalAudit,
  type TerminatingSignal,
} from "../process-signal";

export type LocalHostCreateInput = {
  readonly bindingId: string;
  readonly hostId?: string;
  readonly launch?: TerminalLaunch;
  readonly cols?: number;
  readonly rows?: number;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly label?: string;
  readonly title?: string;
};

export type LocalHostEvent =
  | {
      readonly type: "output";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: bigint;
      readonly data: string;
    }
  | {
      readonly type: "resize";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: bigint;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: "exit";
      readonly bindingId: string;
      readonly epoch: string;
      readonly seq: bigint;
      readonly code: number | undefined;
      readonly signal: number | undefined;
    }
  | {
      readonly type: "session";
      readonly bindingId: string;
      readonly epoch: string;
      readonly status: "starting" | "running" | "exited";
      readonly pid?: number;
    };

export type ControlLease = {
  readonly leaseId: string;
  readonly bindingId: string;
  readonly epoch: string;
  readonly mode: "control" | "observe";
};

export type JournalEntry =
  | { readonly seq: bigint; readonly type: "output"; readonly data: string }
  | { readonly seq: bigint; readonly type: "resize"; readonly cols: number; readonly rows: number }
  | {
      readonly seq: bigint;
      readonly type: "exit";
      readonly code: number | undefined;
      readonly signal: number | undefined;
    };

/** Minimal process handle so tests can inject fakes and PTY/pipe share one path. */
export type TermChild = {
  readonly pid: number | undefined;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number | undefined, signal: number | undefined) => void): void;
};

export type TermSpawnFn = (input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols: number;
  readonly rows: number;
}) => TermChild;

type SessionRec = {
  bindingId: string;
  epoch: string;
  hostId: string;
  status: "starting" | "running" | "exited";
  child: TermChild | undefined;
  pid: number | undefined;
  cols: number;
  rows: number;
  cwd: string;
  title?: string;
  label?: string;
  canvasName?: string;
  nodeId?: string;
  detached: boolean;
  createdAt: number;
  seq: bigint;
  journal: JournalEntry[];
  journalBytes: number;
  controlLeaseId: string | undefined;
  killed: boolean;
  /** Branded child-only capability — only process-signal can mint. */
  owned: OwnedProcess | undefined;
  /** Exact-record escalation; never follows a mutable binding lookup. */
  escalationTimer: ReturnType<typeof setTimeout> | undefined;
};

export type LocalHostShutdownStraggler = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly status: "starting" | "running";
  readonly pid?: number;
};

export type LocalHostShutdownResult =
  | { readonly clean: true; readonly stragglers: readonly [] }
  | {
      readonly clean: false;
      readonly stragglers: readonly LocalHostShutdownStraggler[];
    };

export type LocalSessionHostOptions = {
  /** TERM-to-KILL delay for one exact child generation. */
  readonly killGraceMs?: number;
  /** Bounded wait after each shutdown signal phase. */
  readonly shutdownGraceMs?: number;
  /** Final event-driven window for a late observed exit after SIGKILL. */
  readonly lateExitGraceMs?: number;
};

type AllExitedWaiter = {
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly resolve: (clean: boolean) => void;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_JOURNAL_BYTES = 512 * 1024;
const SHUTDOWN_GRACE_MS = 1500;
const KILL_GRACE_MS = 400;
const LATE_EXIT_GRACE_MS = 1500;

/** @deprecated use ProcessSignalAudit from process-signal */
export type TermKillAudit = ProcessSignalAudit;
export const getTermKillAuditLog = getProcessSignalAuditLog;
export const clearTermKillAuditLog = clearProcessSignalAuditLog;

/** Thin wrapper kept for term tests — maps to sealed classifier. */
export const classifyTermKillTarget = (input: {
  readonly pid: number | undefined;
  readonly selfPid?: number;
  readonly ppid?: number;
}): { readonly allowed: boolean; readonly reason?: string } => {
  const d = classifyProcessSignalTarget({
    pid: input.pid,
    selfPid: input.selfPid,
    ppid: input.ppid,
  });
  return d.ok ? { allowed: true } : { allowed: false, reason: d.reason };
};

const mintEpoch = (): string =>
  `ep_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

const mintLease = (): string => `ls_${randomBytes(8).toString("hex")}`;

const defaultShell = (): string => {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/zsh";
};

export const resolveLaunch = (
  launch: TerminalLaunch | undefined,
): { file: string; args: string[]; cwd: string; env: Record<string, string> } => {
  const cwd =
    (launch?.cwd && launch.cwd.trim()) ||
    process.env.HOME ||
    os.homedir() ||
    process.cwd();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(launch?.env ?? {}),
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
  };
  const argv = launch?.argv?.filter((a) => typeof a === "string" && a.length > 0) ?? [];
  if (launch?.kind === "shell" || !launch || argv.length === 0) {
    const shell = defaultShell();
    if (process.platform !== "win32") {
      return { file: shell, args: ["-l"], cwd, env };
    }
    return { file: shell, args: [], cwd, env };
  }
  return { file: argv[0]!, args: argv.slice(1), cwd, env };
};

const wrapPipeChild = (child: ChildProcessWithoutNullStreams): TermChild => {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number | undefined, signal: number | undefined) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    for (const l of dataListeners) l(d);
  });
  child.stderr.on("data", (d: string) => {
    for (const l of dataListeners) l(d);
  });
  child.on("exit", (code, signal) => {
    const sigNum =
      typeof signal === "string"
        ? undefined
        : typeof signal === "number"
          ? signal
          : undefined;
    for (const l of exitListeners) l(code ?? undefined, sigNum);
  });
  return {
    get pid() {
      return child.pid;
    },
    write(data: string) {
      child.stdin.write(data);
    },
    kill(signal?: NodeJS.Signals) {
      try {
        child.kill(signal ?? "SIGTERM");
      } catch {
        // ignore
      }
    },
    onData(listener) {
      dataListeners.add(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
    },
  };
};

/** Prefer node-pty; fall back to piped child_process when PTY spawn is unavailable. */
export const defaultTermSpawn: TermSpawnFn = (input) => {
  try {
    // Dynamic require keeps optional native dep from breaking import graphs in tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePty = require("node-pty") as typeof import("node-pty");
    const p = nodePty.spawn(input.file, [...input.args], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: input.env,
      handleFlowControl: true,
    });
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number | undefined, signal: number | undefined) => void>();
    p.onData((d) => {
      for (const l of dataListeners) l(d);
    });
    p.onExit(({ exitCode, signal }) => {
      for (const l of exitListeners) l(exitCode ?? undefined, signal ?? undefined);
    });
    return {
      get pid() {
        return p.pid;
      },
      write(data: string) {
        p.write(data);
      },
      resize(cols: number, rows: number) {
        p.resize(cols, rows);
      },
      kill(signal?: NodeJS.Signals) {
        try {
          p.kill(signal ?? "SIGTERM");
        } catch {
          // ignore
        }
      },
      onData(listener) {
        dataListeners.add(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
      },
    };
  } catch {
    const child = cpSpawn(input.file, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      // NOT detached. Detached+process.kill(-pid) was a host-wide landmine
      // when pid was wrong (tests used 1 / process.pid). Kill only via handle.
      detached: false,
    }) as ChildProcessWithoutNullStreams;
    return wrapPipeChild(child);
  }
};

export class LocalSessionHost extends EventEmitter {
  /** Current presentation generation by binding. */
  private readonly sessions = new Map<string, SessionRec>();
  /** Every child generation remains owned until its exit callback is observed. */
  private readonly liveRecords = new Set<SessionRec>();
  /** Bounded waiters used only after shutdown has prevented further creates. */
  private readonly allExitedWaiters = new Set<AllExitedWaiter>();
  private shuttingDown = false;
  private shutdownFlight: Promise<LocalHostShutdownResult> | undefined;
  private readonly spawnFn: TermSpawnFn;
  private readonly killGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly lateExitGraceMs: number;

  constructor(
    spawnFn: TermSpawnFn = defaultTermSpawn,
    options: LocalSessionHostOptions = {},
  ) {
    super();
    this.spawnFn = spawnFn;
    this.killGraceMs = Math.max(0, options.killGraceMs ?? KILL_GRACE_MS);
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    this.lateExitGraceMs = Math.max(0, options.lateExitGraceMs ?? LATE_EXIT_GRACE_MS);
  }

  create(input: LocalHostCreateInput): TerminalSessionSummary {
    if (this.shuttingDown) {
      throw new Error("terminal host shutting down");
    }
    const bindingId = input.bindingId.trim();
    if (!bindingId) throw new Error("bindingId required");

    const prior = this.sessions.get(bindingId);
    if (prior && prior.status !== "exited") {
      this.killBinding(bindingId);
    }

    const cols = Math.max(20, Math.min(300, input.cols ?? DEFAULT_COLS));
    const rows = Math.max(5, Math.min(120, input.rows ?? DEFAULT_ROWS));
    const launch = resolveLaunch(input.launch);
    const epoch = mintEpoch();
    const rec: SessionRec = {
      bindingId,
      epoch,
      hostId: input.hostId?.trim() || "local",
      status: "starting",
      child: undefined,
      pid: undefined,
      cols,
      rows,
      cwd: launch.cwd,
      title: input.title,
      label: input.label,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      detached: !(input.canvasName && input.nodeId),
      createdAt: Date.now(),
      seq: 0n,
      journal: [],
      journalBytes: 0,
      controlLeaseId: undefined,
      killed: false,
      owned: undefined,
      escalationTimer: undefined,
    };
    this.sessions.set(bindingId, rec);
    this.liveRecords.add(rec);

    let child: TermChild;
    try {
      child = this.spawnFn({
        file: launch.file,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cols,
        rows,
      });
    } catch (err) {
      this.failBeforeOwnership(rec, err);
      return this.summaryOf(rec);
    }

    try {
      rec.child = child;
      rec.pid = child.pid;
      rec.status = "running";
      // Local terminals are always child-only; their capability contains no pid.
      rec.owned = admitChildProcess({ source: `term:${bindingId}`, child });

      // Install the cleanup path before data listeners, identity binding, or
      // EventEmitter publication. Any later exception retains this exact
      // authority and initiates bounded teardown instead of inventing exit.
      child.onExit((code, signal) => this.observeExit(rec, code, signal));
      if (!this.liveRecords.has(rec)) return this.summaryOf(rec);
      child.onData((data) => this.observeData(rec, data));
      if (!this.liveRecords.has(rec)) return this.summaryOf(rec);

      this.bindProcessIdentity(rec);
      this.emitEvent({ type: "session", bindingId, epoch, status: "starting" });
      this.emitEvent({
        type: "session",
        bindingId,
        epoch,
        status: "running",
        pid: child.pid,
      });
    } catch (err) {
      this.recordPostSpawnFailure(rec, err);
      this.requestStop(rec);
    }

    return this.summaryOf(rec);
  }

  list(): readonly TerminalSessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summaryOf(s));
  }

  get(bindingId: string): TerminalSessionSummary | undefined {
    const rec = this.sessions.get(bindingId);
    return rec ? this.summaryOf(rec) : undefined;
  }

  bindCanvas(
    bindingId: string,
    ref: { canvasName?: string; nodeId?: string } | null,
  ): void {
    const rec = this.sessions.get(bindingId);
    if (!rec) return;
    if (rec.killed) return;
    if (!ref || !ref.canvasName || !ref.nodeId) {
      if (rec.pid !== undefined) getProcessIdentityMap().unbind(rec.pid);
      rec.canvasName = undefined;
      rec.nodeId = undefined;
      rec.detached = true;
      return;
    }
    rec.canvasName = ref.canvasName.trim();
    rec.nodeId = ref.nodeId.trim();
    rec.detached = false;
    this.bindProcessIdentity(rec);
  }

  attach(input: {
    readonly bindingId: string;
    readonly mode: "control" | "observe";
    readonly takeover?: boolean;
  }):
    | {
        readonly ok: true;
        readonly lease: ControlLease;
        readonly cols: number;
        readonly rows: number;
        readonly journal: readonly JournalEntry[];
        readonly status: SessionRec["status"];
        readonly pid?: number;
      }
    | { readonly ok: false; readonly message: string } {
    const rec = this.sessions.get(input.bindingId);
    if (!rec) return { ok: false, message: "session not found" };
    if (rec.killed) {
      return { ok: false, message: "session interaction revoked during stop" };
    }

    if (input.mode === "control") {
      if (rec.controlLeaseId && !input.takeover) {
        return { ok: false, message: "control lease held (pass takeover)" };
      }
      rec.controlLeaseId = mintLease();
      return {
        ok: true,
        lease: {
          leaseId: rec.controlLeaseId,
          bindingId: rec.bindingId,
          epoch: rec.epoch,
          mode: "control",
        },
        cols: rec.cols,
        rows: rec.rows,
        journal: rec.journal.slice(),
        status: rec.status,
        pid: rec.pid,
      };
    }

    return {
      ok: true,
      lease: {
        leaseId: mintLease(),
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        mode: "observe",
      },
      cols: rec.cols,
      rows: rec.rows,
      journal: rec.journal.slice(),
      status: rec.status,
      pid: rec.pid,
    };
  }

  release(lease: ControlLease): void {
    const rec = this.sessions.get(lease.bindingId);
    if (!rec) return;
    if (lease.mode === "control" && rec.controlLeaseId === lease.leaseId) {
      rec.controlLeaseId = undefined;
    }
  }

  write(lease: ControlLease, data: string): boolean {
    const rec = this.sessions.get(lease.bindingId);
    if (!rec || rec.killed || !rec.child || rec.status !== "running") return false;
    if (lease.mode !== "control" || rec.controlLeaseId !== lease.leaseId) return false;
    if (lease.epoch !== rec.epoch) return false;
    try {
      rec.child.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(lease: ControlLease, cols: number, rows: number): boolean {
    const rec = this.sessions.get(lease.bindingId);
    if (!rec || rec.killed || !rec.child || rec.status !== "running") return false;
    if (lease.mode !== "control" || rec.controlLeaseId !== lease.leaseId) return false;
    if (lease.epoch !== rec.epoch) return false;
    const c = Math.max(20, Math.min(300, cols | 0));
    const r = Math.max(5, Math.min(120, rows | 0));
    if (c === rec.cols && r === rec.rows) return true;
    try {
      rec.child.resize?.(c, r);
      rec.cols = c;
      rec.rows = r;
      rec.seq = rec.seq + 1n;
      this.pushJournal(rec, { seq: rec.seq, type: "resize", cols: c, rows: r });
      this.emitEvent({
        type: "resize",
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        seq: rec.seq,
        cols: c,
        rows: r,
      });
      return true;
    } catch {
      return false;
    }
  }

  kill(bindingId: string): boolean {
    return this.killBinding(bindingId);
  }

  runningCount(): number {
    return this.liveRecords.size;
  }

  detachedRunning(): readonly TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.detached && (s.status === "running" || s.status === "starting"))
      .map((s) => this.summaryOf(s));
  }

  shutdownAll(reason = "app_quit"): Promise<LocalHostShutdownResult> {
    if (this.shutdownFlight !== undefined) return this.shutdownFlight;
    // Close admission synchronously, then defer signaling until the shared
    // promise is published. A child.kill callback can re-enter this host.
    this.shuttingDown = true;
    const flight = Promise.resolve()
      .then(() => this.performShutdown(reason))
      .finally(() => {
        if (this.shutdownFlight === flight) this.shutdownFlight = undefined;
      });
    this.shutdownFlight = flight;
    return flight;
  }

  private async performShutdown(reason: string): Promise<LocalHostShutdownResult> {
    for (const rec of [...this.liveRecords]) {
      this.requestStop(rec);
    }
    if (await this.waitForAllExitsWithin(this.shutdownGraceMs)) {
      return { clean: true, stragglers: [] };
    }
    for (const rec of [...this.liveRecords]) {
      this.forceKill(rec, "SIGKILL");
    }
    if (await this.waitForAllExitsWithin(this.shutdownGraceMs)) {
      return { clean: true, stragglers: [] };
    }
    // Some process wrappers report exit just after a successful KILL. Give
    // that observed callback one final bounded, event-driven window.
    if (await this.waitForAllExitsWithin(this.lateExitGraceMs)) {
      return { clean: true, stragglers: [] };
    }
    const stragglers = [...this.liveRecords].map((rec) => ({
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      status: rec.status,
      ...(rec.pid === undefined ? {} : { pid: rec.pid }),
    })) as LocalHostShutdownStraggler[];
    console.error(
      `[term] ${reason} retained ${stragglers.length} local terminal child generation(s): ${stragglers
        .map((rec) => `${rec.bindingId}@${rec.epoch}${rec.pid === undefined ? "" : ` pid=${rec.pid}`}`)
        .join(", ")}`,
    );
    // The quit attempt is canceled. Retained exact authorities remain live,
    // while the app may recover and a later signal can start a fresh attempt.
    this.shuttingDown = false;
    return { clean: false, stragglers };
  }

  private killBinding(bindingId: string): boolean {
    const rec = this.sessions.get(bindingId);
    if (!rec) return false;
    if (rec.status === "exited") return true;
    this.requestStop(rec);
    return true;
  }

  private requestStop(rec: SessionRec): void {
    if (rec.status === "exited") return;
    rec.killed = true;
    rec.controlLeaseId = undefined;
    if (rec.pid !== undefined) {
      try {
        getProcessIdentityMap().unbind(rec.pid);
      } catch (error) {
        console.error(`[term] identity revoke failed for ${rec.bindingId}@${rec.epoch}:`, error);
      }
    }
    this.forceKill(rec, "SIGTERM");
    if (rec.escalationTimer === undefined && this.liveRecords.has(rec)) {
      rec.escalationTimer = setTimeout(() => {
        rec.escalationTimer = undefined;
        if (this.liveRecords.has(rec)) {
          this.forceKill(rec, "SIGKILL");
        }
      }, this.killGraceMs);
      rec.escalationTimer.unref?.();
    }
  }

  private waitForAllExitsWithin(timeoutMs: number): Promise<boolean> {
    if (this.liveRecords.size === 0) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: AllExitedWaiter = {
        timer: undefined,
        resolve,
      };
      waiter.timer = setTimeout(() => {
        if (!this.allExitedWaiters.delete(waiter)) return;
        resolve(this.liveRecords.size === 0);
      }, timeoutMs);
      this.allExitedWaiters.add(waiter);
      // Defensive totality if future code makes registration re-entrant.
      if (this.liveRecords.size === 0 && this.allExitedWaiters.delete(waiter)) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        resolve(true);
      }
    });
  }

  private observeData(rec: SessionRec, data: string): void {
    if (rec.killed || rec.status !== "running" || !this.liveRecords.has(rec)) return;
    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, { seq: rec.seq, type: "output", data });
    try {
      this.emitEvent({
        type: "output",
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        seq: rec.seq,
        data,
      });
    } catch (error) {
      console.error(`[term] output listener failed for ${rec.bindingId}@${rec.epoch}:`, error);
    }
  }

  private observeExit(
    rec: SessionRec,
    code: number | undefined,
    signal: number | undefined,
  ): void {
    if (!this.liveRecords.has(rec)) return;
    if (rec.escalationTimer !== undefined) {
      clearTimeout(rec.escalationTimer);
      rec.escalationTimer = undefined;
    }
    releaseOwned(rec.owned);
    rec.owned = undefined;
    this.removeLiveRecord(rec);
    const current = this.sessions.get(rec.bindingId);
    // A reused numeric PID may already belong to the replacement. Never let
    // the old generation's late exit erase that newer identity.
    if (rec.pid !== undefined && (current === rec || current?.pid !== rec.pid)) {
      try {
        getProcessIdentityMap().unbind(rec.pid);
      } catch (error) {
        console.error(`[term] identity unbind failed for ${rec.bindingId}@${rec.epoch}:`, error);
      }
    }
    rec.status = "exited";
    rec.child = undefined;
    if (current !== rec) return;
    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, { seq: rec.seq, type: "exit", code, signal });
    this.safeEmitEvent({
      type: "exit",
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      seq: rec.seq,
      code,
      signal,
    });
    this.safeEmitEvent({
      type: "session",
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      status: "exited",
      pid: rec.pid,
    });
  }

  private failBeforeOwnership(rec: SessionRec, error: unknown): void {
    this.removeLiveRecord(rec);
    rec.status = "exited";
    rec.seq = rec.seq + 1n;
    const message = error instanceof Error ? error.message : String(error);
    this.pushJournal(rec, {
      seq: rec.seq,
      type: "output",
      data: `\r\n[vellum] failed to spawn: ${message}\r\n`,
    });
    this.safeEmitEvent({
      type: "exit",
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      seq: rec.seq,
      code: 1,
      signal: undefined,
    });
    this.safeEmitEvent({
      type: "session",
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      status: "exited",
    });
  }

  private recordPostSpawnFailure(rec: SessionRec, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, {
      seq: rec.seq,
      type: "output",
      data: `\r\n[vellum] terminal setup failed; stopping owned child: ${message}\r\n`,
    });
    console.error(`[term] setup failed for ${rec.bindingId}@${rec.epoch}; stopping child:`, error);
  }

  private removeLiveRecord(rec: SessionRec): void {
    if (!this.liveRecords.delete(rec) || this.liveRecords.size !== 0) return;
    const waiters = [...this.allExitedWaiters];
    this.allExitedWaiters.clear();
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  private safeEmitEvent(ev: LocalHostEvent): void {
    try {
      this.emitEvent(ev);
    } catch (error) {
      console.error(`[term] lifecycle listener failed for ${ev.bindingId}@${ev.epoch}:`, error);
    }
  }

  /**
   * Kill via branded OwnedProcess only. Parameter type cannot be a bare pid.
   * Terminals admit with ownsProcessGroup:false → child.kill path inside seal.
   */
  private forceKill(rec: SessionRec, signal: NodeJS.Signals): void {
    // Only an observed child exit closes a live generation. A missing
    // capability must remain visible as an unclean shutdown, never be inferred
    // exited from local bookkeeping alone.
    if (!rec.owned) return;
    const termSignal = signal as TerminatingSignal;
    signalOwned(rec.owned, termSignal);
  }

  private pushJournal(rec: SessionRec, entry: JournalEntry): void {
    rec.journal.push(entry);
    if (entry.type === "output") {
      rec.journalBytes += Buffer.byteLength(entry.data, "utf8");
    }
    while (rec.journalBytes > MAX_JOURNAL_BYTES && rec.journal.length > 0) {
      const dropped = rec.journal.shift();
      if (dropped?.type === "output") {
        rec.journalBytes -= Buffer.byteLength(dropped.data, "utf8");
      }
      if (rec.journal.length === 1 && rec.journalBytes > MAX_JOURNAL_BYTES) {
        // Single oversized entry — drop it entirely.
        const last = rec.journal.shift();
        if (last?.type === "output") rec.journalBytes = 0;
        break;
      }
    }
  }

  private bindProcessIdentity(rec: SessionRec): void {
    if (!rec.pid || !rec.canvasName || !rec.nodeId || rec.status !== "running") return;
    const identities = getProcessIdentityMap();
    // Unbind only this PID so a replaced epoch's late exit cannot wipe the new bind.
    identities.unbind(rec.pid);
    identities.bind(rec.pid, {
      kind: "terminal",
      bindingId: rec.bindingId,
      canvasName: rec.canvasName,
      nodeId: rec.nodeId,
    });
  }

  private summaryOf(rec: SessionRec): TerminalSessionSummary {
    return {
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      hostId: rec.hostId,
      status:
        rec.status === "starting"
          ? "starting"
          : rec.status === "running"
            ? "running"
            : "exited",
      title: rec.title,
      cwd: rec.cwd,
      pid: rec.pid,
      detached: rec.detached,
      canvasName: rec.canvasName,
      nodeId: rec.nodeId,
      createdAt: rec.createdAt,
      label: rec.label,
    };
  }

  private emitEvent(ev: LocalHostEvent): void {
    this.emit("event", ev);
  }
}
