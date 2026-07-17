import { spawn } from "node:child_process";
import { herdrArgv } from "./hosts";
import { feedNdjson } from "./ndjson";

/**
 * LRU pool of read-only `herdr terminal session observe` children with
 * main-process frame retention. Observers never take input/resize/scroll
 * ownership on the host (stock herdr 0.7.x: multiple observers allowed), so
 * killing one is always safe — plain SIGTERM, no `terminal.release` (that is
 * a control-stream concept).
 *
 * Frames are retained only — never forwarded to the renderer. The retained
 * [full, ...deltas] buffer is handed to the renderer when a control stream
 * opens (instant paint before live frames arrive).
 *
 * Channel budget per host: 1 control + <=5 observe (maxPerHost) long-lived
 * channels; short execs are capped at 3 by withHostSlot elsewhere. Total <=9
 * under sshd MaxSessions=10. Observe children deliberately do NOT go through
 * withHostSlot — they are long-lived streams, not ops; the per-host cap here
 * is the enforcement.
 */

/** Minimal structural child shape so tests can inject EventEmitter fakes. */
export interface ObserveChildLike {
  readonly stdout: {
    setEncoding(encoding: string): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "close" | "error", listener: (...args: never[]) => void): unknown;
}

export type ObserveSpawnFn = (
  command: string,
  argv: ReadonlyArray<string>,
) => ObserveChildLike;

export interface ObserveInput {
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

interface ObserveEntry {
  readonly terminalId: string;
  hostId: string;
  session?: string | null;
  cols: number;
  rows: number;
  child: ObserveChildLike | undefined;
  live: boolean;
  stale: boolean;
  full: string | undefined;
  deltas: string[];
  deltaBytes: number;
  touched: number;
  buffer: string;
}

const defaultSpawn: ObserveSpawnFn = (command, argv) =>
  spawn(command, [...argv], {
    // Observers never write — no stdin.
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  }) as unknown as ObserveChildLike;

export class HerdrObservePool {
  private readonly maxGlobal: number;
  private readonly maxPerHost: number;
  private readonly maxDeltaBytes: number;
  private readonly maxEntries: number;
  private readonly spawnFn: ObserveSpawnFn;
  private readonly entries = new Map<string, ObserveEntry>();
  private touchSeq = 0;
  private shutDown = false;

  constructor(opts?: {
    readonly maxGlobal?: number;
    readonly maxPerHost?: number;
    readonly maxDeltaBytes?: number;
    readonly maxEntries?: number;
    readonly spawnFn?: ObserveSpawnFn;
  }) {
    this.maxGlobal = opts?.maxGlobal ?? 10;
    this.maxPerHost = opts?.maxPerHost ?? 5;
    this.maxDeltaBytes = opts?.maxDeltaBytes ?? 4 * 1024 * 1024;
    // Aggregate retention bound: total entries (live + stale) ever kept.
    // Beyond this, the least-recently-touched dead entry is dropped outright
    // — otherwise every terminal ever touched pins up to maxDeltaBytes forever.
    this.maxEntries = Math.max(opts?.maxEntries ?? 3 * this.maxGlobal, this.maxGlobal);
    this.spawnFn = opts?.spawnFn ?? defaultSpawn;
  }

  /** Pool an observe stream for the terminal (LRU-touch if already live). */
  ensureObserve(input: ObserveInput): { readonly pooled: boolean } {
    if (this.shutDown || !input.terminalId) return { pooled: false };
    const existing = this.entries.get(input.terminalId);
    if (existing?.live) {
      existing.touched = ++this.touchSeq;
      existing.cols = input.cols;
      existing.rows = input.rows;
      return { pooled: true };
    }
    // Enforce caps BEFORE spawn (never count the terminal being ensured).
    this.evictForCaps(input.hostId, input.terminalId);
    const entry: ObserveEntry = existing ?? {
      terminalId: input.terminalId,
      hostId: input.hostId,
      session: input.session,
      cols: input.cols,
      rows: input.rows,
      child: undefined,
      live: false,
      stale: false,
      full: undefined,
      deltas: [],
      deltaBytes: 0,
      touched: 0,
      buffer: "",
    };
    entry.hostId = input.hostId;
    entry.session = input.session;
    entry.cols = input.cols;
    entry.rows = input.rows;
    this.entries.set(input.terminalId, entry);
    const spawned = this.spawnChild(entry);
    if (!spawned && !existing) this.entries.delete(input.terminalId);
    this.pruneDeadEntries();
    return { pooled: spawned };
  }

  /** [fullBytes, ...deltaBytes] in arrival order — empty if nothing retained. */
  retainedFrames(terminalId: string): ReadonlyArray<string> {
    const entry = this.entries.get(terminalId);
    if (!entry) return [];
    return entry.full !== undefined ? [entry.full, ...entry.deltas] : [...entry.deltas];
  }

  /**
   * Control stream took over the terminal: kill the observe child (control
   * now provides frames) but KEEP the entry + retention until the first live
   * control frame arrives (clearRetention).
   */
  pauseForControl(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.killChild(entry);
    entry.live = false;
    entry.stale = true;
  }

  /** First live control frame arrived — the renderer has fresher pixels now. */
  clearRetention(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    entry.full = undefined;
    entry.deltas = [];
    entry.deltaBytes = 0;
  }

  /** Kill + drop the entry entirely (retention discarded). */
  releaseObserve(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.killChild(entry);
    this.entries.delete(terminalId);
  }

  /** App quit: SIGTERM every observe child. Observers own nothing on the
   * host — plain kill is safe (never `terminal.release`, control-only). */
  stopAll(): void {
    this.shutDown = true;
    for (const entry of this.entries.values()) this.killChild(entry);
    this.entries.clear();
  }

  /** Test/inspection surface: pool entry liveness for a terminal. */
  entryState(
    terminalId: string,
  ): { readonly live: boolean; readonly stale: boolean } | undefined {
    const entry = this.entries.get(terminalId);
    return entry ? { live: entry.live, stale: entry.stale } : undefined;
  }

  /**
   * Aggregate memory bound (in addition to per-entry maxDeltaBytes): keep at
   * most maxEntries entries total. Dead (non-live) entries are dropped oldest
   * touched first; live entries are never pruned here (evictForCaps bounds
   * them at maxGlobal, below maxEntries).
   */
  private pruneDeadEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const dead = [...this.entries.values()].filter((e) => !e.live);
      if (dead.length === 0) return;
      const oldest = dead.reduce((a, b) => (a.touched <= b.touched ? a : b));
      this.entries.delete(oldest.terminalId);
    }
  }

  private evictForCaps(hostId: string, excludeTerminalId: string): void {
    const live = () =>
      [...this.entries.values()].filter(
        (e) => e.live && e.terminalId !== excludeTerminalId,
      );
    const evictOldest = (candidates: ObserveEntry[]): void => {
      const oldest = candidates.reduce((a, b) => (a.touched <= b.touched ? a : b));
      // Evict = kill the child, keep retention marked stale.
      this.killChild(oldest);
      oldest.live = false;
      oldest.stale = true;
    };
    let onHost = live().filter((e) => e.hostId === hostId);
    while (onHost.length >= this.maxPerHost) {
      evictOldest(onHost);
      onHost = live().filter((e) => e.hostId === hostId);
    }
    let all = live();
    while (all.length >= this.maxGlobal) {
      evictOldest(all);
      all = live();
    }
  }

  private spawnChild(entry: ObserveEntry): boolean {
    const args = [
      "terminal",
      "session",
      "observe",
      entry.terminalId,
      "--cols",
      String(Math.max(20, Math.floor(entry.cols || 80))),
      "--rows",
      String(Math.max(5, Math.floor(entry.rows || 24))),
    ];
    let command: string;
    let argv: string[];
    try {
      ({ command, argv } = herdrArgv(entry.hostId, args, entry.session));
    } catch {
      return false;
    }
    let child: ObserveChildLike;
    try {
      child = this.spawnFn(command, argv);
    } catch {
      return false;
    }
    entry.child = child;
    entry.live = true;
    entry.stale = false;
    entry.touched = ++this.touchSeq;
    entry.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (entry.child !== child) return; // superseded by a respawn
      entry.buffer = feedNdjson(entry.buffer, chunk, (line) => this.handleLine(entry, line));
    });

    const onGone = (): void => {
      if (entry.child !== child) return; // already respawned/killed deliberately
      entry.child = undefined;
      entry.live = false;
      entry.stale = true; // retention kept; next ensureObserve respawns
    };
    child.on("close", onGone);
    child.on("error", onGone);
    return true;
  }

  private handleLine(entry: ObserveEntry, line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj.type === "terminal.closed") {
      // Host says the terminal is gone — retention is dead weight. Drop the
      // whole entry (kills the child too); nothing to hand back or respawn.
      this.releaseObserve(entry.terminalId);
      return;
    }
    if (obj.type !== "terminal.frame" || typeof obj.bytes !== "string") return;
    if (obj.full === true) {
      entry.full = obj.bytes;
      entry.deltas = [];
      entry.deltaBytes = 0;
      entry.stale = false;
      return;
    }
    entry.deltas.push(obj.bytes);
    entry.deltaBytes += obj.bytes.length;
    if (entry.deltaBytes > this.maxDeltaBytes) {
      // Self-healing bound: respawn — a fresh attach yields a full frame that
      // replaces the retained buffer. Retention survives until it arrives.
      this.killChild(entry);
      this.spawnChild(entry);
    }
  }

  private killChild(entry: ObserveEntry): void {
    const child = entry.child;
    if (!child) return;
    entry.child = undefined; // detach handlers' identity check first
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

export const herdrObservePool = new HerdrObservePool();
