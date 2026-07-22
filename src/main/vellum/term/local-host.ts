/**
 * App-scoped local terminal session authority.
 * Owns child processes (PTY when available, pipe fallback otherwise).
 * Presentation (Ghostty/xterm) is a consumer — never co-located as process owner.
 * Product law: app quit stops all local sessions (no LaunchAgent survive-quit).
 */

import { EventEmitter } from "node:events";
import { spawn as cpSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import { getProcessIdentityMap } from "../process-identity";

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
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_JOURNAL_BYTES = 512 * 1024;
const SHUTDOWN_GRACE_MS = 1500;

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
    }) as ChildProcessWithoutNullStreams;
    return wrapPipeChild(child);
  }
};

export class LocalSessionHost extends EventEmitter {
  private readonly sessions = new Map<string, SessionRec>();
  private shuttingDown = false;
  private readonly spawnFn: TermSpawnFn;

  constructor(spawnFn: TermSpawnFn = defaultTermSpawn) {
    super();
    this.spawnFn = spawnFn;
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
    };
    this.sessions.set(bindingId, rec);
    this.emitEvent({ type: "session", bindingId, epoch, status: "starting" });

    try {
      const child = this.spawnFn({
        file: launch.file,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cols,
        rows,
      });
      rec.child = child;
      rec.pid = child.pid;
      rec.status = "running";
      this.bindProcessIdentity(rec);
      this.emitEvent({
        type: "session",
        bindingId,
        epoch,
        status: "running",
        pid: child.pid,
      });

      child.onData((data) => {
        if (rec.killed || rec.epoch !== epoch) return;
        rec.seq = rec.seq + 1n;
        this.pushJournal(rec, { seq: rec.seq, type: "output", data });
        this.emitEvent({
          type: "output",
          bindingId,
          epoch,
          seq: rec.seq,
          data,
        });
      });

      child.onExit((code, signal) => {
        if (rec.epoch !== epoch) return;
        rec.status = "exited";
        getProcessIdentityMap().unbindTerminalBinding(rec.bindingId);
        rec.child = undefined;
        rec.seq = rec.seq + 1n;
        this.pushJournal(rec, {
          seq: rec.seq,
          type: "exit",
          code,
          signal,
        });
        this.emitEvent({
          type: "exit",
          bindingId,
          epoch,
          seq: rec.seq,
          code,
          signal,
        });
        this.emitEvent({
          type: "session",
          bindingId,
          epoch,
          status: "exited",
          pid: rec.pid,
        });
      });
    } catch (err) {
      rec.status = "exited";
      rec.seq = rec.seq + 1n;
      const message = err instanceof Error ? err.message : String(err);
      this.pushJournal(rec, {
        seq: rec.seq,
        type: "output",
        data: `\r\n[vellum] failed to spawn: ${message}\r\n`,
      });
      this.emitEvent({
        type: "exit",
        bindingId,
        epoch,
        seq: rec.seq,
        code: 1,
        signal: undefined,
      });
      this.emitEvent({ type: "session", bindingId, epoch, status: "exited" });
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
    if (!ref || !ref.canvasName || !ref.nodeId) {
      getProcessIdentityMap().unbindTerminalBinding(rec.bindingId);
      rec.canvasName = undefined;
      rec.nodeId = undefined;
      rec.detached = true;
      return;
    }
    rec.canvasName = ref.canvasName;
    rec.nodeId = ref.nodeId;
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
    if (!rec || !rec.child || rec.status !== "running") return false;
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
    if (!rec || !rec.child || rec.status !== "running") return false;
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
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running" || s.status === "starting") n += 1;
    }
    return n;
  }

  detachedRunning(): readonly TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.detached && (s.status === "running" || s.status === "starting"))
      .map((s) => this.summaryOf(s));
  }

  async shutdownAll(_reason = "app_quit"): Promise<void> {
    this.shuttingDown = true;
    const live = [...this.sessions.values()].filter(
      (s) => s.status === "running" || s.status === "starting",
    );
    for (const s of live) {
      this.killBinding(s.bindingId);
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      const still = [...this.sessions.values()].some(
        (s) => s.status === "running" || s.status === "starting",
      );
      if (!still) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const s of this.sessions.values()) {
      if (s.status === "running" || s.status === "starting") {
        this.forceKill(s, "SIGKILL");
      }
    }
  }

  private killBinding(bindingId: string): boolean {
    const rec = this.sessions.get(bindingId);
    if (!rec) return false;
    if (rec.status === "exited") return true;
    rec.killed = true;
    this.forceKill(rec, "SIGTERM");
    const child = rec.child;
    if (child) {
      setTimeout(() => {
        if (rec.status === "running" || rec.status === "starting") {
          this.forceKill(rec, "SIGKILL");
        }
      }, 400).unref?.();
    }
    return true;
  }

  private forceKill(rec: SessionRec, signal: NodeJS.Signals): void {
    const child = rec.child;
    if (!child) {
      rec.status = "exited";
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }

  private pushJournal(rec: SessionRec, entry: JournalEntry): void {
    rec.journal.push(entry);
    if (entry.type === "output") {
      rec.journalBytes += entry.data.length;
    }
    while (rec.journalBytes > MAX_JOURNAL_BYTES && rec.journal.length > 1) {
      const dropped = rec.journal.shift();
      if (dropped?.type === "output") rec.journalBytes -= dropped.data.length;
    }
  }

  private bindProcessIdentity(rec: SessionRec): void {
    if (!rec.pid || !rec.canvasName || !rec.nodeId || rec.status !== "running") return;
    const identities = getProcessIdentityMap();
    identities.unbindTerminalBinding(rec.bindingId);
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
