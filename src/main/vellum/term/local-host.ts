/**
 * App-scoped local terminal session coordinator.
 * The central app process plane exclusively owns native PTY processes.
 * Presentation (xterm) is a consumer — never co-located as process owner.
 * Product law: app quit stops all local sessions (no LaunchAgent survive-quit).
 */

import { EventEmitter } from "node:events";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { Either } from "effect";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import {
  productStatusFromSessionPhase,
  sessionPhaseAllowsWrite,
  SessionPhase,
  type SessionPhase as SessionPhaseT,
} from "@shared/terminal-session-domain";
import {
  TERM_MAINTENANCE_OBSERVATION_BYTES,
  type TermMaintenanceDenialReason,
  type TermMaintenanceEvidence,
  type TermMaintenanceQuiescenceEvidence,
} from "@shared/term-control";
import { getProcessIdentityMap } from "../process-identity";
import {
  TerminalLaunchError,
  validateExecutableShell,
  type TerminalLaunchFailureCode,
} from "./shell-policy";
import {
  appProcessPlane,
  type AppProcessPlane,
  type AppProcessSignalReceipt,
  type AppTerminalExit,
  type AppTerminalLease,
  type AppTerminalSpawnSpec,
} from "../app-process-plane";
import {
  terminalObserverPlane,
  type TerminalObserverPlane,
} from "./observer";
import { seatStateRuntime } from "./agent-state";
import {
  armFirstTypedMessage,
  clearFirstTypedMessage,
} from "./first-typed";
import {
  extractSessionIdFromText,
  recordCapturedSessionId,
  clearCapturedSessionId,
  getCapturedSessionId,
} from "./session-id-store";
import { buildSpawnEnv, scrubSpawnEnv } from "./templates/resolve-launch";
import { buildManagedSeatInject } from "./templates/seat-env";

/**
 * What a terminal generation *is*. Decided by the caller from the node's
 * authored spec and never recomputed from the launch payload:
 *
 *   agent    → the actor seat. A harness template, spawned from its own argv.
 *   terminal → geography. A shell.
 *
 * The shell path is reachable only from the `terminal` variant, so an actor
 * whose launch does not resolve fails; it never degrades into a login shell.
 */
export type TerminalSeat =
  | {
      readonly kind: "agent";
      /** Closed literal — an actor seat always names a real template. */
      readonly harness: HarnessId;
      readonly agentKey: string;
      readonly launch?: TerminalLaunch;
    }
  | {
      readonly kind: "terminal";
      readonly launch?: TerminalLaunch;
    };

/** Fields every generation carries, whatever the node is. */
export type TerminalOpenInput = {
  readonly bindingId: string;
  readonly hostId?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly label?: string;
  readonly title?: string;
  /**
   * Tier B doctrine body — armed for first idle delivery via ManagedTerminalDrive.
   * Never written into harness configs; typed only.
   */
  readonly firstTypedMessage?: string;
};

/** Geography terminal (`geography/"terminal"`) — a shell. Holds no harness. */
export type LocalHostCreateInput = TerminalOpenInput & {
  readonly launch?: TerminalLaunch;
};

/** The actor seat. Harness and agent key are part of the type, not a bolt-on. */
export type LocalHostAgentSeatInput = TerminalOpenInput & {
  readonly harness: HarnessId;
  readonly agentKey: string;
  readonly launch?: TerminalLaunch;
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

declare const localTerminalMaintenanceLeaseBrand: unique symbol;

/**
 * Opaque host authority for one zero-session terminal admission cut.
 * Only exact object identity can release the cut; it is never serialized.
 */
export type LocalTerminalMaintenanceLease = {
  readonly [localTerminalMaintenanceLeaseBrand]: true;
};

export type LocalTerminalMaintenanceAcquireResult =
  | {
      readonly acquired: true;
      readonly evidence: TermMaintenanceQuiescenceEvidence;
      readonly lease: LocalTerminalMaintenanceLease;
    }
  | {
      readonly acquired: false;
      readonly evidence: TermMaintenanceEvidence;
      readonly reason: TermMaintenanceDenialReason;
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

export type LocalTerminalProcessAuthority = Pick<
  AppProcessPlane,
  "spawnTerminal" | "terminate" | "forceTerminate"
>;

type SessionRec = {
  bindingId: string;
  epoch: string;
  hostId: string;
  /**
   * Product session phase (shared domain with herdr control).
   * Write only while Live; Broken still "running" for inventory until exit.
   */
  phase: SessionPhaseT;
  lease: AppTerminalLease | undefined;
  exitWitness: Promise<AppTerminalExit> | undefined;
  listenerCleanups: Array<() => void>;
  pid: number | undefined;
  cols: number;
  rows: number;
  cwd: string;
  title?: string;
  label?: string;
  backend: "pty" | undefined;
  canvasName?: string;
  nodeId?: string;
  /** Actor key when this generation is an agent seat (process-bind principal). */
  agentKey?: string;
  /** Harness template when this generation is an actor seat. */
  harness?: HarnessId;
  detached: boolean;
  createdAt: number;
  seq: bigint;
  journal: JournalEntry[];
  journalBytes: number;
  controlLeaseId: string | undefined;
  killed: boolean;
  termReceipt: AppProcessSignalReceipt | undefined;
  killReceipt: AppProcessSignalReceipt | undefined;
  /** Bounded carryover for a harness session marker split across PTY chunks. */
  sessionCaptureTail: string;
  /** Exact-record escalation; never follows a mutable binding lookup. */
  escalationTimer: ReturnType<typeof setTimeout> | undefined;
};

const sessionStatusOf = (
  rec: Pick<SessionRec, "phase">,
): "starting" | "running" | "exited" =>
  productStatusFromSessionPhase(rec.phase);

const activeSessionStatusOf = (
  rec: Pick<SessionRec, "bindingId" | "epoch" | "phase">,
): "starting" | "running" => {
  const status = sessionStatusOf(rec);
  if (status === "exited") {
    throw new Error(
      `closed terminal retained as active: ${rec.bindingId}@${rec.epoch}`,
    );
  }
  return status;
};

export type LocalHostShutdownStraggler = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly status: "starting" | "running";
  readonly pid?: number;
  readonly term?: AppProcessSignalReceipt;
  readonly kill?: AppProcessSignalReceipt;
};

export type LocalHostShutdownResult =
  | { readonly clean: true; readonly stragglers: readonly [] }
  | {
      readonly clean: false;
      readonly stragglers: readonly LocalHostShutdownStraggler[];
    };

export type LocalSessionHostOptions = {
  /** TERM-to-KILL delay for one exact terminal generation. */
  readonly killGraceMs?: number;
  /** Bounded wait after each shutdown signal phase. */
  readonly shutdownGraceMs?: number;
  /** Final event-driven window for a late observed exit after SIGKILL. */
  readonly lateExitGraceMs?: number;
  /**
   * Read-only external admission fence. Production observes the fixed
   * root-owned Linux release marker; tests inject state without touching the
   * host filesystem. Errors close admission.
   */
  readonly externalMaintenanceFence?: () => boolean;
  /**
   * Main-process screen observer plane. Defaults to the process singleton.
   * Tests may inject an isolated plane.
   */
  readonly observerPlane?: TerminalObserverPlane;
};

type AllExitedWaiter = {
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly resolve: (clean: boolean) => void;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_JOURNAL_BYTES = 512 * 1024;
const SESSION_CAPTURE_TAIL_BYTES = 1024;
const SHUTDOWN_GRACE_MS = 1500;
const KILL_GRACE_MS = 400;
const LATE_EXIT_GRACE_MS = 1500;

const mintEpoch = (): string =>
  `ep_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

const mintLease = (): string => `ls_${randomBytes(8).toString("hex")}`;
const mintMaintenanceObservation = (): string =>
  `tm_${randomBytes(TERM_MAINTENANCE_OBSERVATION_BYTES).toString("hex")}`;

export { TerminalLaunchError };
export type { TerminalLaunchFailureCode };

const defaultShell = (): string => {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  const userShell = process.env.SHELL?.trim();
  if (userShell) {
    try {
      return validateExecutableShell(userShell);
    } catch (error) {
      if (!(error instanceof TerminalLaunchError)) throw error;
      // `$SHELL` is ambient preference, not executable authority. A stale or
      // malformed value falls through to the fixed platform policy below.
    }
  }
  // Linux is deliberately bash-first; macOS retains its system login shell.
  return validateExecutableShell(
    process.platform === "linux" ? "/bin/bash" : "/bin/zsh",
  );
};

const resolveCwd = (launch: TerminalLaunch | undefined): string =>
  (launch?.cwd && launch.cwd.trim()) ||
  process.env.HOME ||
  os.homedir() ||
  process.cwd();

/** An actor seat whose harness launch does not name an executable argv. */
export type AgentLaunchUnresolvable = {
  readonly code: "agent_launch_unresolvable";
  readonly harness: HarnessId;
  readonly reason: string;
};

export type ResolvedLaunch = {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
};

/**
 * Resolve the argv a seat spawns. Total over the seat sum:
 *
 *   agent    → the harness argv, or a typed failure. There is no shell here.
 *   terminal → the authored command, else a validated login shell.
 *
 * A seat is what the node says it is; nothing about the launch payload can
 * make one variant behave like the other.
 */
export const resolveLaunch = (
  seat: TerminalSeat,
  options?: {
    readonly seatInject?: Readonly<Record<string, string>>;
  },
): Either.Either<ResolvedLaunch, AgentLaunchUnresolvable> => {
  const launch = seat.launch;
  const cwd = resolveCwd(launch);
  // Actor seat: scrub nested Claude markers + merge seat inject after scrub
  // so ambient CLAUDE_CODE_CHILD_SESSION cannot disable the child transcript.
  const env: Record<string, string> =
    seat.kind === "agent"
      ? {
          ...buildSpawnEnv(process.env, {
            ...(options?.seatInject ?? {}),
            ...(launch?.env ?? {}),
          }),
          TERM: process.env.TERM || "xterm-256color",
          COLORTERM: process.env.COLORTERM || "truecolor",
        }
      : {
          ...(process.env as Record<string, string>),
          ...(launch?.env ?? {}),
          TERM: process.env.TERM || "xterm-256color",
          COLORTERM: process.env.COLORTERM || "truecolor",
        };
  // Defensive: never let scrubbed keys re-enter via TERM/COLORTERM path.
  if (seat.kind === "agent") {
    for (const key of Object.keys(env)) {
      if (scrubSpawnEnv({ [key]: env[key] })[key] === undefined) {
        delete env[key];
      }
    }
  }
  const argv = launch?.argv?.filter((a) => typeof a === "string" && a.length > 0) ?? [];

  if (seat.kind === "agent") {
    const unresolvable = (reason: string): AgentLaunchUnresolvable => ({
      code: "agent_launch_unresolvable",
      harness: seat.harness,
      reason,
    });
    if (!launch) return Either.left(unresolvable("the seat carries no launch profile"));
    if (launch.kind === "shell") {
      return Either.left(unresolvable("the seat's launch profile is a shell"));
    }
    const file = argv[0];
    if (file === undefined) {
      return Either.left(unresolvable("the seat's launch profile carries no argv"));
    }
    return Either.right({ file, args: argv.slice(1), cwd, env });
  }

  if (launch && launch.kind !== "shell" && argv.length > 0) {
    return Either.right({ file: argv[0]!, args: argv.slice(1), cwd, env });
  }
  // An explicit shell argv wins over the user/default shell, but is still
  // validated before process ownership can be minted.
  const shell = argv.length > 0 ? validateExecutableShell(argv[0]!) : defaultShell();
  if (process.platform !== "win32") {
    return Either.right({
      file: shell,
      args: argv.length > 1 ? argv.slice(1) : ["-l"],
      cwd,
      env,
    });
  }
  return Either.right({ file: shell, args: [], cwd, env });
};

export class LocalSessionHost extends EventEmitter {
  /** Current presentation generation by binding. */
  private readonly sessions = new Map<string, SessionRec>();
  /** Every terminal generation remains live until its exact witness settles. */
  private readonly liveRecords = new Set<SessionRec>();
  /** Bounded waiters used only after shutdown has prevented further creates. */
  private readonly allExitedWaiters = new Set<AllExitedWaiter>();
  private maintenanceLease: LocalTerminalMaintenanceLease | undefined;
  private shuttingDown = false;
  private shutdownFlight: Promise<LocalHostShutdownResult> | undefined;
  private readonly processAuthority: LocalTerminalProcessAuthority;
  private readonly killGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly lateExitGraceMs: number;
  private readonly externalMaintenanceFence: () => boolean;
  private readonly observerPlane: TerminalObserverPlane;

  constructor(
    processAuthority: LocalTerminalProcessAuthority = appProcessPlane,
    options: LocalSessionHostOptions = {},
  ) {
    super();
    this.processAuthority = processAuthority;
    this.killGraceMs = Math.max(0, options.killGraceMs ?? KILL_GRACE_MS);
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    this.lateExitGraceMs = Math.max(0, options.lateExitGraceMs ?? LATE_EXIT_GRACE_MS);
    this.externalMaintenanceFence =
      options.externalMaintenanceFence ?? (() => false);
    this.observerPlane = options.observerPlane ?? terminalObserverPlane;
  }

  /** Open a geography terminal. A shell — it can hold no harness. */
  create(input: LocalHostCreateInput): TerminalSessionSummary {
    return this.open(
      { kind: "terminal", ...(input.launch ? { launch: input.launch } : {}) },
      input,
    );
  }

  /** Open the actor seat. Its harness is declared, never inferred at spawn. */
  createAgentSeat(input: LocalHostAgentSeatInput): TerminalSessionSummary {
    const bindingId = input.bindingId.trim();
    const current = this.sessions.get(bindingId);
    if (current && sessionStatusOf(current) !== "exited") {
      // One binding owns one live actor generation. Create is an idempotent
      // ensure at this boundary: renderer remounts, concurrent factory wake,
      // or duplicate IPC must never turn into permission to signal and replace
      // a healthy harness. Explicit kill followed by create remains restart.
      return this.summaryOf(current);
    }
    return this.open(
      {
        kind: "agent",
        harness: input.harness,
        agentKey: input.agentKey,
        ...(input.launch ? { launch: input.launch } : {}),
      },
      input,
    );
  }

  private open(seat: TerminalSeat, input: TerminalOpenInput): TerminalSessionSummary {
    if (this.shuttingDown) {
      throw new Error("terminal host shutting down");
    }
    let externallyFenced = true;
    try {
      externallyFenced = this.externalMaintenanceFence();
    } catch {
      // Cross-privilege maintenance state is fail-closed. A broken observation
      // must never become permission to create a new terminal.
    }
    if (this.maintenanceLease !== undefined || externallyFenced) {
      throw new Error("terminal admission closed for maintenance");
    }
    const bindingId = input.bindingId.trim();
    if (!bindingId) throw new Error("bindingId required");

    const prior = this.sessions.get(bindingId);
    if (prior && sessionStatusOf(prior) !== "exited") {
      this.killBinding(bindingId);
    }

    const cols = Math.max(20, Math.min(300, input.cols ?? DEFAULT_COLS));
    const rows = Math.max(5, Math.min(120, input.rows ?? DEFAULT_ROWS));
    const harness = seat.kind === "agent" ? seat.harness : undefined;
    const agentKey = seat.kind === "agent" ? seat.agentKey : undefined;
    const resolved = resolveLaunch(
      seat,
      seat.kind === "agent"
        ? {
            seatInject: buildManagedSeatInject({
              agentKey: seat.agentKey,
              canvasName: input.canvasName,
              nodeId: input.nodeId,
            }),
          }
        : {},
    );
    const epoch = mintEpoch();
    const rec: SessionRec = {
      bindingId,
      epoch,
      hostId: input.hostId?.trim() || "local",
      phase: SessionPhase.Opening({ surface: "native" }),
      lease: undefined,
      exitWitness: undefined,
      listenerCleanups: [],
      pid: undefined,
      cols,
      rows,
      cwd: Either.isRight(resolved) ? resolved.right.cwd : resolveCwd(seat.launch),
      title: input.title,
      label: input.label,
      backend: undefined,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      agentKey,
      harness,
      detached: !(input.canvasName && input.nodeId),
      createdAt: Date.now(),
      seq: 0n,
      journal: [],
      journalBytes: 0,
      controlLeaseId: undefined,
      killed: false,
      termReceipt: undefined,
      killReceipt: undefined,
      sessionCaptureTail: "",
      escalationTimer: undefined,
    };
    this.sessions.set(bindingId, rec);
    this.liveRecords.add(rec);

    if (Either.isLeft(resolved)) {
      // An actor whose launch does not resolve stops here and shows the error
      // state on its node. It never falls through to a shell.
      this.failBeforeOwnership(
        rec,
        new Error(
          `${resolved.left.harness} seat launch unresolvable: ${resolved.left.reason}`,
        ),
      );
      return this.summaryOf(rec);
    }
    const launch = resolved.right;

    let lease: AppTerminalLease;
    try {
      const spec: AppTerminalSpawnSpec = {
        source: `term:${bindingId}`,
        purpose: `local terminal ${bindingId}@${epoch}`,
        command: launch.file,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        cols,
        rows,
      };
      lease = this.processAuthority.spawnTerminal(spec);
    } catch (err) {
      this.failBeforeOwnership(rec, err);
      return this.summaryOf(rec);
    }

    try {
      rec.lease = lease;
      rec.backend = lease.backend;
      rec.exitWitness = lease.io.exited;
      rec.pid = lease.io.pidForDiagnostics;
      rec.phase = SessionPhase.Live({ surface: "native" });
      // Retain the central plane's exact native-PTY exit witness before any
      // fallible presentation setup. Rejection is diagnostic only: authority
      // stays registered centrally and this generation remains a straggler.
      void rec.exitWitness.then(
        (event) => this.observeExit(rec, event.code, event.signal),
        (error) => this.observeWitnessFailure(rec, error),
      );
      rec.listenerCleanups.push(
        lease.io.onData((data) => this.observeData(rec, data)),
        lease.io.onError((error) => this.observeTerminalError(rec, error)),
      );
      // Main-process screen truth: one headless grid per live generation.
      // Independent of renderer mount lifetime (workers run with windows closed).
      this.observerPlane.attach({
        bindingId,
        epoch,
        cols,
        rows,
      });
      if (seat.kind === "agent") {
        seatStateRuntime.bindHarness(bindingId, seat.harness, epoch);
      }
      const firstTyped = input.firstTypedMessage?.trim();
      if (firstTyped) {
        clearFirstTypedMessage(bindingId);
        armFirstTypedMessage(bindingId, firstTyped);
      }
      if (!this.liveRecords.has(rec)) {
        this.observerPlane.detach(bindingId, epoch);
        if (seat.kind === "agent") {
          seatStateRuntime.unbind(bindingId, epoch, "generation_aborted");
        }
        clearFirstTypedMessage(bindingId);
        return this.summaryOf(rec);
      }

      this.bindProcessIdentity(rec);
      this.emitEvent({ type: "session", bindingId, epoch, status: "starting" });
      this.emitEvent({
        type: "session",
        bindingId,
        epoch,
        status: "running",
        pid: rec.pid,
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
        /**
         * Preferred long-session attach: full headless grid (scrollback + viewport).
         * When present, renderer should apply this and ignore `journal`.
         */
        readonly screen?: {
          readonly bindingId: string;
          readonly epoch: string;
          readonly cols: number;
          readonly rows: number;
          readonly cursorX: number;
          readonly cursorY: number;
          readonly seq: bigint;
          readonly lines: readonly string[];
        };
        /** Bounded byte ring for sessions without an observer. */
        readonly journal: readonly JournalEntry[];
        readonly status: "starting" | "running" | "exited";
        readonly pid?: number;
      }
    | { readonly ok: false; readonly message: string } {
    const rec = this.sessions.get(input.bindingId);
    if (!rec) return { ok: false, message: "session not found" };
    if (rec.killed) {
      return { ok: false, message: "session interaction revoked during stop" };
    }

    // Prefer full-grid attach over journal: long sessions must not depend on a
    // truncating 512KB byte ring (mid-escape corruption under heavy output).
    const screen = this.observerPlane.attachScreen(rec.bindingId);
    const screenPayload = screen
      ? {
          bindingId: screen.bindingId,
          epoch: screen.epoch,
          cols: screen.cols,
          rows: screen.rows,
          cursorX: screen.cursorX,
          cursorY: screen.cursorY,
          seq: screen.seq,
          lines: screen.lines,
          // Mode flags for renderer re-arm after plain-text rebuild
          // (mouse/alt-screen — without these hover/click die on attach).
          signals: screen.signals,
        }
      : undefined;
    // When screen is present, do not ship the journal — forces clients onto
    // the correct path and avoids double-paint.
    const journal = screenPayload ? ([] as const) : rec.journal.slice();

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
        ...(screenPayload ? { screen: screenPayload } : {}),
        journal,
        status: sessionStatusOf(rec),
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
      ...(screenPayload ? { screen: screenPayload } : {}),
      journal,
      status: sessionStatusOf(rec),
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
    if (!rec || rec.killed || !rec.lease || !sessionPhaseAllowsWrite(rec.phase)) return false;
    if (lease.mode !== "control" || rec.controlLeaseId !== lease.leaseId) return false;
    if (lease.epoch !== rec.epoch) return false;
    try {
      rec.lease.io.write(data);
      return true;
    } catch {
      // PTY write failure (broken pipe family) — leave generation registered
      // until exact exit witness; refuse further writes via phase.
      rec.phase = SessionPhase.Broken({ surface: "native", reason: "pipe" });
      return false;
    }
  }

  resize(lease: ControlLease, cols: number, rows: number): boolean {
    const rec = this.sessions.get(lease.bindingId);
    if (!rec || rec.killed || !rec.lease || !sessionPhaseAllowsWrite(rec.phase)) return false;
    if (lease.mode !== "control" || rec.controlLeaseId !== lease.leaseId) return false;
    if (lease.epoch !== rec.epoch) return false;
    const c = Math.max(20, Math.min(300, cols | 0));
    const r = Math.max(5, Math.min(120, rows | 0));
    if (c === rec.cols && r === rec.rows) return true;
    try {
      rec.lease.io.resize?.(c, r);
      rec.cols = c;
      rec.rows = r;
      rec.seq = rec.seq + 1n;
      this.pushJournal(rec, { seq: rec.seq, type: "resize", cols: c, rows: r });
      this.observerPlane.resize(rec.bindingId, c, r);
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

  /**
   * Atomically observes the exact live-generation set and closes create
   * admission only when it is empty. JavaScript execution cannot interleave a
   * synchronous create/shutdown call between the observation and capability
   * mint.
   */
  acquireMaintenanceLease(): LocalTerminalMaintenanceAcquireResult {
    const activeTerminalSessions = this.liveRecords.size;
    const evidence = Object.freeze({
      activeTerminalSessions,
      observationId: mintMaintenanceObservation(),
    });
    if (this.shuttingDown) {
      return { acquired: false, evidence, reason: "shutting_down" };
    }
    if (this.maintenanceLease !== undefined) {
      return { acquired: false, evidence, reason: "maintenance_held" };
    }
    if (activeTerminalSessions !== 0) {
      return { acquired: false, evidence, reason: "active_sessions" };
    }
    const lease = Object.freeze({}) as LocalTerminalMaintenanceLease;
    this.maintenanceLease = lease;
    return {
      acquired: true,
      evidence: {
        activeTerminalSessions: 0,
        observationId: evidence.observationId,
      },
      lease,
    };
  }

  /** Release requires the exact in-process capability minted above. */
  releaseMaintenanceLease(lease: LocalTerminalMaintenanceLease): boolean {
    if (this.maintenanceLease !== lease) return false;
    this.maintenanceLease = undefined;
    return true;
  }

  detachedRunning(): readonly TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.detached && sessionStatusOf(s) !== "exited")
      .map((s) => this.summaryOf(s));
  }

  shutdownAll(reason = "app_quit"): Promise<LocalHostShutdownResult> {
    if (this.shutdownFlight !== undefined) return this.shutdownFlight;
    // Close admission synchronously, then defer signaling until the shared
    // promise is published. A terminal backend callback can re-enter this host.
    this.shuttingDown = true;
    this.maintenanceLease = undefined;
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
      status: activeSessionStatusOf(rec),
      ...(rec.pid === undefined ? {} : { pid: rec.pid }),
      ...(rec.termReceipt === undefined ? {} : { term: rec.termReceipt }),
      ...(rec.killReceipt === undefined ? {} : { kill: rec.killReceipt }),
    })) as LocalHostShutdownStraggler[];
    console.error(
      `[term] ${reason} retained ${stragglers.length} local terminal generation(s): ${stragglers
        .map((rec) => `${rec.bindingId}@${rec.epoch}${rec.pid === undefined ? "" : ` pid=${rec.pid}`}`)
        .join(", ")}`,
    );
    // Retained exact authorities remain live. Shutdown admission is monotonic:
    // a failed quit may retry the same records but can never spawn new ones.
    return { clean: false, stragglers };
  }

  private killBinding(bindingId: string): boolean {
    const rec = this.sessions.get(bindingId);
    if (!rec) return false;
    if (sessionStatusOf(rec) === "exited") return true;
    this.requestStop(rec);
    return true;
  }

  private requestStop(rec: SessionRec): void {
    if (sessionStatusOf(rec) === "exited") return;
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
    if (
      rec.killed ||
      sessionStatusOf(rec) !== "running" ||
      !this.liveRecords.has(rec)
    ) return;
    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, { seq: rec.seq, type: "output", data });
    // Single insertion point: every byte already flows here with a seq.
    this.observerPlane.feed(rec.bindingId, data, rec.seq);
    // Best-effort diagnostic observation when a harness prints a labeled id.
    // PTY text is untrusted and this value is neither durable nor a cold-resume
    // capability. Retain a bounded tail so a label split across chunks remains
    // parseable; the first candidate wins within this process lifetime.
    if ((rec.agentKey || rec.harness) && !getCapturedSessionId(rec.bindingId)) {
      const captureText = `${rec.sessionCaptureTail}${data}`;
      const sid = extractSessionIdFromText(captureText);
      if (sid) recordCapturedSessionId(rec.bindingId, sid);
      rec.sessionCaptureTail = captureText.slice(-SESSION_CAPTURE_TAIL_BYTES);
    }
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
    for (const cleanup of rec.listenerCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Listener disposal never weakens the exact central exit witness.
      }
    }
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
    rec.phase = SessionPhase.Closed({
      surface: "native",
      reason: signal !== undefined ? `signal_${signal}` : `exit_${code ?? "null"}`,
    });
    rec.lease = undefined;
    rec.exitWitness = undefined;
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
    rec.phase = SessionPhase.Closed({ surface: "native", reason: "spawn_failed" });
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
      data: `\r\n[vellum] terminal setup failed; stopping central lease: ${message}\r\n`,
    });
    console.error(`[term] setup failed for ${rec.bindingId}@${rec.epoch}; stopping lease:`, error);
  }

  private observeWitnessFailure(rec: SessionRec, error: unknown): void {
    if (!this.liveRecords.has(rec)) return;
    console.error(
      `[term] terminal witness rejected for ${rec.bindingId}@${rec.epoch}; retaining authority:`,
      error,
    );
  }

  private observeTerminalError(rec: SessionRec, error: Error): void {
    if (!this.liveRecords.has(rec)) return;
    if (sessionPhaseAllowsWrite(rec.phase)) {
      rec.phase = SessionPhase.Broken({ surface: "native", reason: "io" });
    }
    console.error(
      `[term] terminal process error for ${rec.bindingId}@${rec.epoch}; awaiting exact exit witness:`,
      error,
    );
  }

  private removeLiveRecord(rec: SessionRec): void {
    // Drop headless grid for this exact generation (epoch-gated).
    this.observerPlane.detach(rec.bindingId, rec.epoch);
    seatStateRuntime.unbind(
      rec.bindingId,
      rec.epoch,
      "generation_exited",
    );
    clearFirstTypedMessage(rec.bindingId);
    clearCapturedSessionId(rec.bindingId);
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

  private forceKill(rec: SessionRec, signal: NodeJS.Signals): void {
    // Only the central plane can translate this opaque lease into OS signal
    // authority. Generic dispatch failures retain the record and therefore
    // fail the bounded shutdown receipt closed.
    if (!rec.lease) return;
    try {
      if (signal === "SIGTERM") {
        rec.termReceipt = this.processAuthority.terminate(
          rec.lease,
          `local-terminal-stop:${rec.bindingId}@${rec.epoch}`,
        );
      } else if (signal === "SIGKILL") {
        rec.killReceipt = this.processAuthority.forceTerminate(
          rec.lease,
          `local-terminal-force-stop:${rec.bindingId}@${rec.epoch}`,
        );
      }
    } catch (error) {
      console.error(
        `[term] ${signal} dispatch failed for ${rec.bindingId}@${rec.epoch}; retaining authority:`,
        error,
      );
    }
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
    if (
      !rec.pid ||
      !rec.canvasName ||
      !rec.nodeId ||
      sessionStatusOf(rec) !== "running"
    ) return;
    const identities = getProcessIdentityMap();
    // Unbind only this PID so a replaced epoch's late exit cannot wipe the new bind.
    identities.unbind(rec.pid);
    // Managed actor seats bind as agent so work-control process-bind matches the card.
    if (rec.agentKey) {
      identities.bind(rec.pid, {
        agentKey: rec.agentKey,
        canvasName: rec.canvasName,
        nodeId: rec.nodeId,
      });
      return;
    }
    identities.bind(rec.pid, {
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
      status: sessionStatusOf(rec),
      title: rec.title,
      cwd: rec.cwd,
      pid: rec.pid,
      detached: rec.detached,
      canvasName: rec.canvasName,
      nodeId: rec.nodeId,
      createdAt: rec.createdAt,
      label: rec.label,
      backend: rec.backend,
    };
  }

  /** Domain phase for tests / Effect consumers (not canvas). */
  phaseOf(bindingId: string): SessionPhaseT | undefined {
    return this.sessions.get(bindingId)?.phase;
  }

  private emitEvent(ev: LocalHostEvent): void {
    this.emit("event", ev);
  }
}
