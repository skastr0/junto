import { feedNdjson } from "./ndjson";
import { isKnownHerdrHost } from "./hosts";
import type {
  HerdrClientIo,
  HerdrSpawnFn,
  RemoteScopeCloseReceipt,
} from "./stream";
import type { AppProcessSignalReceipt } from "../app-process-plane";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  herdrShutdownMessage,
  type HerdrComponentShutdownReceipt,
  type HerdrShutdownCause,
  validateHerdrShutdownTimeout,
} from "./shutdown";

const OBSERVE_CHILD_TERMINATION_GRACE_MS = 1_500;

/**
 * LRU pool of read-only `herdr terminal session observe` children with
 * main-process frame retention. Observers never take input/resize/scroll
 * ownership on the host (stock herdr 0.7.x: multiple observers allowed), so
 * terminating one is always safe. Local observers use bounded child-only
 * SIGTERM → SIGKILL; remote observers close only their captured Effect scope.
 * Neither lifecycle sends `terminal.release` (that is a control-stream concept).
 *
 * Frames are retained only — never forwarded to the renderer. The retained
 * [full, ...deltas] buffer is handed to the renderer when a control stream
 * opens (instant paint before live frames arrive).
 *
 * Channel budget per host: 1 control + <=5 observe long-lived channels.
 * Short operations use the transport's independent per-host dial admission;
 * observe capacity remains explicit here because these leases are long-lived.
 */

export type ObserveSpawnFn = HerdrSpawnFn;

export interface ObserveInput {
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

/** One exact observe child generation, retained while TERM is in flight. */
type LocalObserveLifecycle = {
  readonly kind: "local-process";
  readonly terminate: (reason: string) => AppProcessSignalReceipt;
  readonly forceTerminate: (reason: string) => AppProcessSignalReceipt;
  readonly closedPromise: Promise<void>;
  readonly resolveClosed: () => void;
  terminationRequested: boolean;
  closed: boolean;
  termReceipt?: AppProcessSignalReceipt;
  forceReceipt?: AppProcessSignalReceipt;
  signalFailures: HerdrShutdownCause[];
  terminationTimer?: ReturnType<typeof setTimeout>;
};

type RemoteObserveLifecycle = {
  readonly kind: "remote-scope";
  readonly close: () => Promise<RemoteScopeCloseReceipt>;
  closeRequested: boolean;
  closeFlight?: Promise<RemoteScopeCloseReceipt>;
  receipt?: RemoteScopeCloseReceipt;
};

/** One exact observe generation, independently local-process or remote-scope. */
interface ObserveGeneration {
  readonly child: HerdrClientIo;
  readonly lifecycle: LocalObserveLifecycle | RemoteObserveLifecycle;
}

interface ObserveEntry {
  readonly terminalId: string;
  /** Observer is a bounded read lease, not a daemon or terminal owner. */
  readonly childLifetime: "observation-owned";
  hostId: string;
  session?: string | null;
  /** What the NEXT child spawn is asked for — updated on every ensureObserve
   * touch (live or not) so a later respawn honors the latest measured size.
   * Mutable independent of whether a child is currently running. */
  spawnCols: number;
  spawnRows: number;
  /** The (clamped) geometry the entry's CURRENT child was actually launched
   * with — set once, at that spawn, and left alone by later touches even
   * while the child stays live. This is the generation label: it can differ
   * from spawnCols/Rows the moment a resize is requested without triggering
   * a respawn (an already-live entry is touched, not restarted). */
  childCols: number | undefined;
  childRows: number | undefined;
  /** The geometry of the frames actually retained in full/deltas below.
   * Generation-bound: set ONLY at full-frame receipt, from childCols/Rows —
   * i.e. from the child generation that produced that frame — never from
   * spawnCols/Rows, which may already point at a not-yet-spawned request. */
  retainedCols: number | undefined;
  retainedRows: number | undefined;
  generation: ObserveGeneration | undefined;
  live: boolean;
  stale: boolean;
  full: string | undefined;
  deltas: string[];
  deltaBytes: number;
  touched: number;
  buffer: string;
  /** Last time ANY frame (full or delta) was received — drives idle sweep. */
  lastFrameAt: number | undefined;
}

export class HerdrObservePool {
  private readonly maxGlobal: number;
  private readonly maxPerHost: number;
  private readonly maxDeltaBytes: number;
  private readonly maxEntries: number;
  /** Idle lease: a live child with no frames for this long gets released
   * (retention kept) on the next sweep. */
  private readonly idleLeaseMs: number;
  /** How often the idle sweep runs. */
  private readonly idleSweepMs: number;
  private readonly spawnFn: ObserveSpawnFn;
  private readonly entries = new Map<string, ObserveEntry>();
  private readonly localLifecycles = new Set<LocalObserveLifecycle>();
  private readonly remoteLifecycles = new Set<RemoteObserveLifecycle>();
  private readonly terminationGraceMs: number;
  private readonly shutdownDrainTimeoutMs: number;
  private touchSeq = 0;
  private shutDown = false;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  private cleanShutdownReceipt: HerdrComponentShutdownReceipt | undefined;

  constructor(opts?: {
    readonly maxGlobal?: number;
    readonly maxPerHost?: number;
    readonly maxDeltaBytes?: number;
    readonly maxEntries?: number;
    readonly idleLeaseMs?: number;
    readonly idleSweepMs?: number;
    readonly spawnFn?: ObserveSpawnFn;
    readonly terminationGraceMs?: number;
    readonly shutdownDrainTimeoutMs?: number;
  }) {
    this.maxGlobal = opts?.maxGlobal ?? 10;
    this.maxPerHost = opts?.maxPerHost ?? 5;
    this.maxDeltaBytes = opts?.maxDeltaBytes ?? 4 * 1024 * 1024;
    // Aggregate retention bound: total entries (live + stale) ever kept.
    // Beyond this, the least-recently-touched dead entry is dropped outright
    // — otherwise every terminal ever touched pins up to maxDeltaBytes forever.
    this.maxEntries = Math.max(opts?.maxEntries ?? 3 * this.maxGlobal, this.maxGlobal);
    this.idleLeaseMs = opts?.idleLeaseMs ?? 5 * 60_000;
    this.idleSweepMs = opts?.idleSweepMs ?? 60_000;
    if (!opts?.spawnFn) throw new TypeError("HerdrObservePool requires a scoped process factory");
    this.spawnFn = opts.spawnFn;
    this.terminationGraceMs = validateHerdrShutdownTimeout(
      opts.terminationGraceMs,
      OBSERVE_CHILD_TERMINATION_GRACE_MS,
    );
    this.shutdownDrainTimeoutMs = validateHerdrShutdownTimeout(
      opts.shutdownDrainTimeoutMs,
      3_250,
    );
  }

  /** Pool an observe stream for the terminal (LRU-touch if already live). */
  ensureObserve(input: ObserveInput): { readonly pooled: boolean } {
    if (this.shutDown || !input.terminalId || !isKnownHerdrHost(input.hostId)) {
      return { pooled: false };
    }
    const existing = this.entries.get(input.terminalId);
    if (existing?.live) {
      existing.touched = ++this.touchSeq;
      // Record the latest measured size for whenever this child next
      // respawns — but never touch retainedCols/Rows: the running child
      // was spawned with the OLD geometry, and its frames still are too.
      if (input.cols) existing.spawnCols = input.cols;
      if (input.rows) existing.spawnRows = input.rows;
      return { pooled: true };
    }
    // Enforce caps BEFORE spawn (never count the terminal being ensured).
    this.evictForCaps(input.hostId, input.terminalId);
    const entry: ObserveEntry = existing ?? {
      terminalId: input.terminalId,
      childLifetime: "observation-owned",
      hostId: input.hostId,
      session: input.session,
      spawnCols: input.cols,
      spawnRows: input.rows,
      childCols: undefined,
      childRows: undefined,
      retainedCols: undefined,
      retainedRows: undefined,
      generation: undefined,
      live: false,
      stale: false,
      full: undefined,
      deltas: [],
      deltaBytes: 0,
      touched: 0,
      buffer: "",
      lastFrameAt: undefined,
    };
    entry.hostId = input.hostId;
    entry.session = input.session;
    if (input.cols) entry.spawnCols = input.cols;
    if (input.rows) entry.spawnRows = input.rows;
    this.entries.set(input.terminalId, entry);
    this.ensureIdleTimer();
    const spawned = this.spawnChild(entry);
    if (!spawned && !existing) this.entries.delete(input.terminalId);
    this.pruneDeadEntries();
    return { pooled: spawned };
  }

  /**
   * Retained frames and the geometry those SPECIFIC frames were rendered at.
   * Generation-true: cols/rows come from the child generation that produced
   * the retained full frame, never from a pending resize request that
   * hasn't produced a replacement frame yet (that would relabel old pixels
   * with a new size before they've actually changed).
   */
  retainedFrames(terminalId: string): {
    readonly frames: ReadonlyArray<string>;
    readonly cols?: number;
    readonly rows?: number;
  } {
    const entry = this.entries.get(terminalId);
    if (!entry) return { frames: [] };
    const frames = entry.full !== undefined ? [entry.full, ...entry.deltas] : [...entry.deltas];
    if (frames.length === 0) return { frames };
    if (entry.retainedCols !== undefined && entry.retainedRows !== undefined) {
      return { frames, cols: entry.retainedCols, rows: entry.retainedRows };
    }
    // Frames exist but no full frame has confirmed a generation yet (e.g. a
    // delta arrived first) — best-known geometry is what the entry's current
    // child was actually launched with, if a child has ever run.
    if (entry.childCols !== undefined && entry.childRows !== undefined) {
      return { frames, cols: entry.childCols, rows: entry.childRows };
    }
    return { frames };
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
    entry.retainedCols = undefined;
    entry.retainedRows = undefined;
  }

  /** Kill + drop the entry entirely (retention discarded). */
  releaseObserve(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    this.killChild(entry);
    this.entries.delete(terminalId);
    this.maybeStopIdleTimer();
  }

  /**
   * Host removed/edited: kill + drop every pooled entry for hostId. Retention
   * is discarded outright — stale pixels for a gone endpoint are a lie, so
   * this never keeps a stale entry around the way a normal pause/evict does.
   */
  releaseByHost(hostId: string): void {
    for (const terminalId of [...this.entries.keys()]) {
      if (this.entries.get(terminalId)?.hostId === hostId) this.releaseObserve(terminalId);
    }
  }

  /** Permanently close observe admission before any asynchronous drain. */
  beginShutdown(): void {
    this.shutDown = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** App quit: observers own no host panes; prove only their client leases. */
  drainOnQuit(): Promise<HerdrComponentShutdownReceipt> {
    this.beginShutdown();
    if (this.cleanShutdownReceipt) return Promise.resolve(this.cleanShutdownReceipt);
    if (this.drainFlight) return this.drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      const causes: HerdrShutdownCause[] = [];
      for (const entry of [...this.entries.values()]) {
        try {
          this.killChild(entry);
        } catch (error) {
          causes.push({
            code: "observe-release-failed",
            message: herdrShutdownMessage(error),
          });
        }
      }
      this.entries.clear();

      // Retry previously bounded remote closes. The closer retains the exact
      // underlying Scope.close and can report a late terminal witness.
      for (const lifecycle of this.remoteLifecycles) {
        this.trackRemoteClose(lifecycle);
      }

      const [localResult, remoteResult] = await Promise.allSettled([
        awaitHerdrPromiseFixedPoint(
          () => [...this.localLifecycles].map((lifecycle) => lifecycle.closedPromise),
          this.shutdownDrainTimeoutMs,
        ),
        awaitHerdrPromiseFixedPoint(
          () => [...this.remoteLifecycles]
            .flatMap((lifecycle) => lifecycle.closeFlight ? [lifecycle.closeFlight] : []),
          this.shutdownDrainTimeoutMs,
        ),
      ]);

      for (const lifecycle of this.localLifecycles) {
        causes.push(...lifecycle.signalFailures);
        const refusal = lifecycle.forceReceipt ?? lifecycle.termReceipt;
        if (refusal?.attempted === false) {
          causes.push({
            code: "observe-local-signal-refused",
            message: refusal.decision.ok
              ? "central process plane did not attempt the requested signal"
              : refusal.decision.reason,
          });
        }
      }
      if (localResult.status === "rejected") {
        causes.push({
          code: "observe-local-close-wait-failed",
          message: herdrShutdownMessage(localResult.reason),
        });
      } else if (!localResult.value || this.localLifecycles.size > 0) {
        causes.push({
          code: "observe-local-close-retained",
          message: `${this.localLifecycles.size} local observer client(s) lack an exact close witness`,
        });
      }

      for (const lifecycle of this.remoteLifecycles) {
        const receipt = lifecycle.receipt;
        if (receipt?.status === "failed") {
          causes.push({ code: "observe-remote-close-failed", message: receipt.message });
        } else if (receipt?.status === "timed-out") {
          causes.push({
            code: "observe-remote-close-timed-out",
            message: `remote observer scope did not close within ${receipt.timeoutMs}ms`,
          });
        } else if (receipt === undefined) {
          causes.push({
            code: "observe-remote-close-retained",
            message: "remote observer scope close did not produce a bounded receipt",
          });
        }
      }
      if (remoteResult.status === "rejected") {
        causes.push({
          code: "observe-remote-close-wait-failed",
          message: herdrShutdownMessage(remoteResult.reason),
        });
      } else if (!remoteResult.value && this.remoteLifecycles.size > 0) {
        causes.push({
          code: "observe-remote-close-retained",
          message: `${this.remoteLifecycles.size} remote observer scope(s) remain retained`,
        });
      }

      const retained = this.localLifecycles.size + this.remoteLifecycles.size;
      const receipt = retained === 0 && causes.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(retained, causes);
      if (receipt.clean) this.cleanShutdownReceipt = receipt;
      return receipt;
    })();
    this.drainFlight = flight;
    void flight.finally(() => {
      if (this.drainFlight === flight) this.drainFlight = undefined;
    });
    return flight;
  }

  stopAll(): Promise<HerdrComponentShutdownReceipt> {
    return this.drainOnQuit();
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
    this.maybeStopIdleTimer();
  }

  /**
   * Idle lease sweep: a live child that has gone quiet (no frame — full or
   * delta — for idleLeaseMs) is released like any other eviction. Retention
   * and retainedCols/Rows are KEPT (the pane's last pixels are still true);
   * the entry is marked stale so the existing ensureObserve/touch respawn
   * path picks it back up on demand. Released-idle entries fall out of
   * `live` the same way an evicted entry does, so they count toward
   * pruneDeadEntries' retention bound like any other dead entry — the sweep
   * does not need to fight the LRU separately.
   */
  private sweepIdle(): void {
    const cutoff = Date.now() - this.idleLeaseMs;
    for (const entry of this.entries.values()) {
      if (!entry.live || entry.lastFrameAt === undefined || entry.lastFrameAt > cutoff) continue;
      this.killChild(entry);
      entry.live = false;
      entry.stale = true;
    }
    // A mass simultaneous idle-release can push entries.size past maxEntries
    // until the next touch trims it — bound it here too rather than waiting.
    this.pruneDeadEntries();
  }

  /** Started lazily once an entry exists; a no-op if already running. */
  private ensureIdleTimer(): void {
    if (this.idleTimer || this.shutDown) return;
    this.idleTimer = setInterval(() => this.sweepIdle(), this.idleSweepMs);
    // Never let the sweep alone keep the Electron main process alive.
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stopped once the pool is empty — no timer leaks between tests/hosts. */
  private maybeStopIdleTimer(): void {
    if (this.entries.size > 0 || !this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
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
    // Clamped values are what the child is actually told — and so the true
    // generation label for whatever frames it goes on to produce.
    const cols = Math.max(20, Math.floor(entry.spawnCols || 80));
    const rows = Math.max(5, Math.floor(entry.spawnRows || 24));
    const args = [
      "terminal",
      "session",
      "observe",
      entry.terminalId,
      "--cols",
      String(cols),
      "--rows",
      String(rows),
    ];
    let child: HerdrClientIo;
    let lifecycle: LocalObserveLifecycle | RemoteObserveLifecycle;
    try {
      const spawned = this.spawnFn(entry.hostId, args, entry.session);
      if ((entry.hostId === "local") !== (spawned.kind === "local-process")) {
        return false;
      }
      child = spawned.child;
      if (spawned.kind === "local-process") {
        let resolveClosed!: () => void;
        const closedPromise = new Promise<void>((resolve) => {
          resolveClosed = resolve;
        });
        lifecycle = {
          kind: "local-process",
          terminate: spawned.terminate,
          forceTerminate: spawned.forceTerminate,
          closedPromise,
          resolveClosed,
          terminationRequested: false,
          closed: false,
          signalFailures: [],
        };
        this.localLifecycles.add(lifecycle);
      } else {
        lifecycle = {
          kind: "remote-scope",
          close: spawned.close,
          closeRequested: false,
        };
        this.remoteLifecycles.add(lifecycle);
      }
    } catch {
      return false;
    }
    const generation: ObserveGeneration = {
      child,
      lifecycle,
    };
    entry.generation = generation;
    entry.childCols = cols;
    entry.childRows = rows;
    entry.live = true;
    entry.stale = false;
    entry.touched = ++this.touchSeq;
    entry.buffer = "";
    // New generation, new idle clock: a respawned child must not inherit a
    // predecessor's stale lastFrameAt, or the very next sweep tick would
    // SIGTERM it before it has had a chance to send its own first frame.
    entry.lastFrameAt = undefined;

    try {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (entry.generation !== generation) return; // superseded by a respawn
        entry.buffer = feedNdjson(entry.buffer, chunk, (line) => this.handleLine(entry, generation, line), {
          onOverflow: () => {
            if (entry.generation !== generation) return;
            // Defective/wedged observer: kill outright and mark stale rather
            // than eagerly respawning (unlike the deltaBytes self-heal below)
            // — a child spewing unterminated garbage would just repeat. The
            // next ensureObserve (e.g. the user re-switching to this
            // terminal) respawns it.
            this.killChild(entry);
            entry.live = false;
            entry.stale = true;
          },
        });
      });

      const onClose = (): void => {
        if (generation.lifecycle.kind === "remote-scope") {
          // A natural SSH exit still needs to drain that generation's scope
          // finalizers through the bounded receipt path.
          this.terminateGeneration(generation);
        } else {
          this.settleLocalGeneration(generation);
        }
        if (entry.generation !== generation) return; // already respawned/killed deliberately
        entry.generation = undefined;
        entry.live = false;
        entry.stale = true; // retention kept; next ensureObserve respawns
      };
      const onError = (): void => {
        // Error is not proof the process exited. Logically retire this observe
        // lease, but retain its exact authority through bounded termination.
        if (entry.generation === generation) {
          entry.generation = undefined;
          entry.live = false;
          entry.stale = true;
        }
        this.terminateGeneration(generation);
      };
      child.on("close", onClose);
      child.on("error", onError);
    } catch {
      if (entry.generation === generation) {
        entry.generation = undefined;
        entry.live = false;
        entry.stale = true;
      }
      this.terminateGeneration(generation);
      return false;
    }
    return true;
  }

  private handleLine(
    entry: ObserveEntry,
    generation: ObserveGeneration,
    line: string,
  ): void {
    if (entry.generation !== generation) return;
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
    entry.lastFrameAt = Date.now();
    if (obj.full === true) {
      entry.full = obj.bytes;
      entry.deltas = [];
      entry.deltaBytes = 0;
      entry.stale = false;
      // Generation-true label: this full frame came from the entry's
      // current child, so retained geometry becomes THAT child's geometry —
      // never a newer, not-yet-spawned resize request.
      entry.retainedCols = entry.childCols;
      entry.retainedRows = entry.childRows;
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
    const generation = entry.generation;
    if (!generation) return;
    entry.generation = undefined; // detach handlers' identity check first
    this.terminateGeneration(generation);
  }

  /** Record the central plane's close witness for one exact generation. */
  private settleLocalGeneration(generation: ObserveGeneration): void {
    const lifecycle = generation.lifecycle;
    if (lifecycle.kind === "remote-scope" || lifecycle.closed) return;
    lifecycle.closed = true;
    if (lifecycle.terminationTimer !== undefined) {
      clearTimeout(lifecycle.terminationTimer);
      lifecycle.terminationTimer = undefined;
    }
    lifecycle.resolveClosed();
    this.localLifecycles.delete(lifecycle);
  }

  /** Tagged teardown; never follows the entry to a replacement generation. */
  private terminateGeneration(generation: ObserveGeneration): void {
    const lifecycle = generation.lifecycle;
    if (lifecycle.kind === "remote-scope") {
      if (lifecycle.closeRequested) return;
      lifecycle.closeRequested = true;
      this.trackRemoteClose(lifecycle);
      return;
    }
    if (lifecycle.terminationRequested || lifecycle.closed) return;
    lifecycle.terminationRequested = true;
    try {
      lifecycle.termReceipt = lifecycle.terminate("herdr-observe-release");
    } catch (error) {
      lifecycle.signalFailures.push({
        code: "observe-local-term-failed",
        message: herdrShutdownMessage(error),
      });
    }
    if (lifecycle.closed) return;
    const timer = setTimeout(() => {
      lifecycle.terminationTimer = undefined;
      if (lifecycle.closed) return;
      try {
        lifecycle.forceReceipt = lifecycle.forceTerminate("herdr-observe-grace-expired");
      } catch (error) {
        lifecycle.signalFailures.push({
          code: "observe-local-force-failed",
          message: herdrShutdownMessage(error),
        });
      }
    }, this.terminationGraceMs);
    lifecycle.terminationTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private trackRemoteClose(lifecycle: RemoteObserveLifecycle): void {
    if (lifecycle.closeFlight) return;
    let closeFlight: Promise<RemoteScopeCloseReceipt>;
    try {
      closeFlight = Promise.resolve(lifecycle.close()).catch((error): RemoteScopeCloseReceipt => ({
        status: "failed",
        message: herdrShutdownMessage(error),
      }));
    } catch (error) {
      closeFlight = Promise.resolve<RemoteScopeCloseReceipt>({
        status: "failed",
        message: herdrShutdownMessage(error),
      });
    }
    lifecycle.closeFlight = closeFlight;
    void closeFlight.then((receipt) => {
      lifecycle.receipt = receipt;
      if (receipt.status === "closed") {
        this.remoteLifecycles.delete(lifecycle);
      } else if (lifecycle.closeFlight === closeFlight) {
        lifecycle.closeFlight = undefined;
      }
    });
  }
}
