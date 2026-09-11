/**
 * App-scoped local terminal session coordinator.
 * The central app process plane exclusively owns native PTY processes.
 * Presentation (xterm) is a consumer — never co-located as process owner.
 * Product law: app quit stops all local sessions (no LaunchAgent survive-quit).
 */

import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Result } from "effect";
import type { ManagedSpawnIntent } from "@shared/managed-terminal-launch";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { classifySpawnFailure } from "@shared/spawn-failure";
import type { TerminalLaunch, TerminalSessionSummary } from "@shared/terminal";
import { colorFgBgFor, type ThemeMode } from "@shared/theme";
import { currentThemeMode } from "../theme-state";
import {
  productStatusFromSessionPhase,
  sessionPhaseAllowsWrite,
  SessionPhase,
  type SessionPhase as SessionPhaseT,
} from "@shared/terminal-session-domain";
import {
  occupancyFromSession,
  occupyVacantSeat,
  seatIdentityConflictError,
  seatOccupationFailedError,
} from "@shared/terminal-seat-occupancy";
import { appendTransportTrace } from "../observability/transport-journal";
import {
  TERM_MAINTENANCE_OBSERVATION_BYTES,
  type TermMaintenanceDenialReason,
  type TermMaintenanceEvidence,
  type TermMaintenanceQuiescenceEvidence,
} from "@shared/term-control";
import {
  getProcessIdentityMap,
  type ProcessIdentityBinding,
  type ProcessPrincipal,
} from "../process-identity";
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
import {
  scheduleCapturedSessionPersist,
  usesCapturedSession,
} from "./session-capture-persist";
import {
  DEVIN_PROOF_RETRY_DELAYS_MS,
  discoverDevinSessionId,
} from "./devin-session-capture";
import {
  isHarnessResumeFailureText,
  isPinSessionHarness,
  launchArgvUsesResume,
  reclaimOrphanedHarnessArgv,
} from "./session-existence";
import {
  planFreshManagedSpawnIntent,
  planFreshPinSession,
  shouldAvoidSharedHarnessResume,
} from "./managed-spawn-plan";
import { buildSpawnEnv, scrubSpawnEnv } from "./templates/resolve-launch";
import { buildManagedSeatInject } from "./templates/seat-env";
import {
  primeAgentDaemons,
  type PrimeAgentDaemonHandle,
  type PrimeAgentDaemons,
} from "./prime-agent-daemon";

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
  /** Pure seat context retained only for a failed-resume fresh replan. */
  readonly resumeFallbackIntent?: ManagedSpawnIntent;
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
    }
  | {
      readonly type: "seat-state";
      readonly bindingId: string;
      readonly epoch: string;
      readonly event: {
        readonly bindingId: string;
        readonly epoch: string;
        readonly state: "idle" | "working" | "attention" | "unknown" | "gone";
        readonly reason: string;
        readonly confidence: "high" | "low";
        readonly at: number;
        readonly harness?: string;
      };
    };

export type LocalHostEventListener = (event: LocalHostEvent) => void;

export type LocalHostEventSubscriptionOptions = {
  /**
   * Replay each binding's current live generation after the listener is
   * installed. This closes startup read/subscribe windows without making
   * exited generations look live.
   */
  readonly replayCurrentSessions?: boolean;
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

type PrimeDaemonCleanupState = "none" | "pending" | "clean" | "failed";
type PrimeAgentDaemonReport = Parameters<
  NonNullable<Parameters<PrimeAgentDaemons["start"]>[0]["onReport"]>
>[0];

type SessionRec = {
  bindingId: string;
  epoch: string;
  hostId: string;
  /**
   * Product session phase.
   * Write only while Live; Broken still "running" for inventory until exit.
   */
  phase: SessionPhaseT;
  lease: AppTerminalLease | undefined;
  exitWitness: Promise<AppTerminalExit> | undefined;
  listenerCleanups: Array<() => void>;
  pid: number | undefined;
  /** Exact PID/start-key authorities; never replace these with numeric revocation. */
  ptyIdentityBinding: ProcessIdentityBinding | undefined;
  daemonIdentityBinding: ProcessIdentityBinding | undefined;
  /** Prime Agent's per-seat foreground daemon + reporter registration. */
  primeDaemon: PrimeAgentDaemonHandle | undefined;
  primeDaemonStopFlight: Promise<void> | undefined;
  primeDaemonCleanupState: PrimeDaemonCleanupState;
  primeDaemonCleanupError: string | undefined;
  cols: number;
  rows: number;
  cwd: string;
  title?: string;
  /** Spawn argv basename — display fallback when OSC title is empty. */
  processName?: string;
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
  /**
   * This generation used harness resume argv (`-r` / `--resume` / `resume`).
   * On proven resume failure we fail open to a fresh pin session once.
   */
  resumeAttempt: boolean;
  resumeFailureSeen: boolean;
  failOpenUsed: boolean;
  /** Payload to recreate a pin generation after resume failure. */
  failOpenSeed?: LocalHostAgentSeatInput;
  /**
   * Pre-ownership failure only. Clean post-run exits leave these unset so
   * the canvas keeps the normal stopped/exited grammar.
   */
  exitReason?: "cli-missing" | "spawn_failed";
  exitMessage?: string;
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
  /** True only while the app process plane still owns an unobserved PTY exit. */
  readonly ownedPtyOutstanding?: true;
  readonly term?: AppProcessSignalReceipt;
  readonly kill?: AppProcessSignalReceipt;
  /** Present when a per-seat daemon receipt is still pending or failed. */
  readonly primeDaemon?: {
    readonly daemonPid?: number;
    readonly state: "pending" | "failed" | "manager_pending" | "manager_failed";
    readonly message?: string;
  };
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
  /**
   * Per-seat Prime Agent daemon. Production passes the singleton explicitly;
   * omission selects it only for the exact app process plane. `null` disables
   * the integration for isolated tests without ever launching a real CLI.
   */
  readonly primeDaemons?: PrimeAgentDaemons | null;
};

type AllExitedWaiter = {
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly resolve: (clean: boolean) => void;
};

type RecordExitWaiter = {
  readonly record: SessionRec;
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

const CLEANUP_DIAGNOSTIC_MESSAGE_BYTES = 512;

const boundedCleanupMessage = (message: string): string =>
  Buffer.from(message, "utf8")
    .subarray(0, CLEANUP_DIAGNOSTIC_MESSAGE_BYTES)
    .toString("utf8");

const cleanupFailureMessage = (receipt: unknown): string | undefined => {
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("clean" in receipt) ||
    receipt.clean !== false
  ) return undefined;
  if ("message" in receipt && typeof receipt.message === "string") {
    return boundedCleanupMessage(receipt.message);
  }
  if ("diagnostics" in receipt && Array.isArray(receipt.diagnostics)) {
    const first = receipt.diagnostics.find(
      (value): value is { readonly stage?: unknown; readonly message: string } =>
        typeof value === "object" &&
        value !== null &&
        "message" in value &&
        typeof value.message === "string" &&
        value.message.trim().length > 0,
    );
    if (first !== undefined) {
      const stage = typeof first.stage === "string" && first.stage.trim().length > 0
        ? `${first.stage.trim()}: `
        : "";
      return boundedCleanupMessage(`${stage}${first.message.trim()}`);
    }
  }
  // Manager shutdown receipts carry the actionable detail on the first
  // non-clean per-seat child receipt rather than at the top level.
  if ("receipts" in receipt && Array.isArray(receipt.receipts)) {
    for (const child of receipt.receipts) {
      const detail = cleanupFailureMessage(child);
      if (detail !== undefined) return detail;
    }
  }
  return "daemon cleanup returned a non-clean receipt";
};

const errorMessage = (error: unknown): string =>
  boundedCleanupMessage(error instanceof Error ? error.message : String(error));

/** Reporter fields are authoritative, but still bounded before display storage. */
const safeStructuredSessionId = (report: {
  readonly sessionId?: string;
  readonly sessionPath?: string;
}): string | undefined => {
  const safeToken = (value: string): string | undefined => {
    const token = value.trim();
    if (
      token.length === 0 ||
      token.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(token)
    ) return undefined;
    return token;
  };
  if (typeof report.sessionId === "string") {
    const direct = safeToken(report.sessionId);
    if (direct !== undefined) return direct;
  }
  if (typeof report.sessionPath !== "string") return undefined;
  const leaf = report.sessionPath.trim().split(/[\\/]/u).at(-1) ?? "";
  return safeToken(leaf.replace(/\.jsonl$/iu, ""));
};

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

/**
 * Expand a station-local cwd. Region paths and the directory picker author `~`
 * / `~/…` (see host-directory); node-pty requires a real absolute path and
 * exits the child immediately when given a literal tilde.
 */
export const expandTerminalCwd = (
  input: string | undefined,
  home: string = os.homedir(),
): string => {
  const requested = input?.trim() ?? "";
  if (!requested || requested === "~") return home;
  if (requested.startsWith("~/")) return join(home, requested.slice(2));
  return requested;
};

const resolveCwd = (launch: TerminalLaunch | undefined): string => {
  const expanded = expandTerminalCwd(
    (launch?.cwd && launch.cwd.trim()) ||
      process.env.HOME ||
      os.homedir() ||
      process.cwd(),
  );
  // node-pty rejects relative cwds; fall back rather than mint a doomed spawn.
  if (!isAbsolute(expanded)) {
    return os.homedir() || process.cwd();
  }
  return expanded;
};

/** True when the path is an existing directory the child can start in. */
const isUsableCwd = (cwd: string): boolean => {
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory();
  } catch {
    return false;
  }
};

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
    /**
     * Active Vellum Command theme for COLORFGBG fallback. Defaults dark —
     * renderer OSC 10/11 + CSI ?996n are the live authority once attached.
     */
    readonly themeMode?: ThemeMode;
  },
): Result.Result<ResolvedLaunch, AgentLaunchUnresolvable> => {
  const launch = seat.launch;
  const cwd = resolveCwd(launch);
  // Actor seat: scrub nested Claude markers + merge seat inject after scrub
  // so ambient CLAUDE_CODE_CHILD_SESSION cannot disable the child transcript.
  // PTY is always a real xterm surface. Inherit ambient TERM only when it is
  // already an xterm* value — a host launched under TERM=dumb (CI, headless
  // harnesses) must not blank interactive shells.
  const ambientTerm = process.env.TERM?.trim() ?? "";
  const term =
    ambientTerm.startsWith("xterm") || ambientTerm.startsWith("screen")
      ? ambientTerm
      : "xterm-256color";
  // COLORFGBG is the spawn hint a TUI reads when it never asks the terminal
  // what colour it is (Grok: its real captures carry no OSC 10/11 query). It
  // comes from main's theme state, which is the source of truth for every seat
  // on every canvas — a seat woken with no surface attached is told exactly
  // what a hand-opened one is told. The renderer's OSC 10/11 + CSI ?996n stay
  // the live update path once a surface exists; they are no longer the only
  // way the harness ever learns the theme.
  const colorFgBg = colorFgBgFor(options?.themeMode ?? currentThemeMode());
  const env: Record<string, string> =
    seat.kind === "agent"
      ? {
          ...buildSpawnEnv(process.env, {
            ...(launch?.env ?? {}),
            // Live host authority wins over the earlier pure launch plan.
            // In dev, that keeps repo/dist ahead of a stale installed CLI;
            // for every build, it prevents document/ambient launch env from
            // replacing the process-bound seat and control-socket contract.
            ...(options?.seatInject ?? {}),
          }),
          TERM: term,
          COLORTERM: process.env.COLORTERM || "truecolor",
          COLORFGBG: colorFgBg,
        }
      : {
          ...(process.env as Record<string, string>),
          ...(launch?.env ?? {}),
          TERM: term,
          COLORTERM: process.env.COLORTERM || "truecolor",
          COLORFGBG: colorFgBg,
        };
  // Defensive: never let scrubbed keys re-enter via TERM/COLORTERM path.
  if (seat.kind === "agent") {
    for (const key of Object.keys(env)) {
      if (scrubSpawnEnv({ [key]: env[key] })[key] === undefined) {
        delete env[key];
      }
    }
  }
  const argv = reclaimOrphanedHarnessArgv(
    launch?.argv?.filter((a) => typeof a === "string" && a.length > 0) ?? [],
    cwd,
  );

  if (seat.kind === "agent") {
    const unresolvable = (reason: string): AgentLaunchUnresolvable => ({
      code: "agent_launch_unresolvable",
      harness: seat.harness,
      reason,
    });
    if (!launch) return Result.fail(unresolvable("the seat carries no launch profile"));
    if (launch.kind === "shell") {
      return Result.fail(unresolvable("the seat's launch profile is a shell"));
    }
    const file = argv[0];
    if (file === undefined) {
      return Result.fail(unresolvable("the seat's launch profile carries no argv"));
    }
    return Result.succeed({ file, args: argv.slice(1), cwd, env });
  }

  if (launch && launch.kind !== "shell" && argv.length > 0) {
    return Result.succeed({ file: argv[0]!, args: argv.slice(1), cwd, env });
  }
  // An explicit shell argv wins over the user/default shell, but is still
  // validated before process ownership can be minted.
  const shell = argv.length > 0 ? validateExecutableShell(argv[0]!) : defaultShell();
  if (process.platform !== "win32") {
    return Result.succeed({
      file: shell,
      args: argv.length > 1 ? argv.slice(1) : ["-l"],
      cwd,
      env,
    });
  }
  return Result.succeed({ file: shell, args: [], cwd, env });
};

export class LocalSessionHost extends EventEmitter {
  /** Current presentation generation by binding. */
  private readonly sessions = new Map<string, SessionRec>();
  /** Every terminal generation remains live until its exact witness settles. */
  private readonly liveRecords = new Set<SessionRec>();
  /** Daemon authority remains outstanding until its exact stop receipt settles. */
  private readonly primeDaemonRecords = new Set<SessionRec>();
  /** Bounded waiters used only after shutdown has prevented further creates. */
  private readonly allExitedWaiters = new Set<AllExitedWaiter>();
  /** Exact-generation deletion waiters; unrelated seats never hold these open. */
  private readonly recordExitWaiters = new Set<RecordExitWaiter>();
  private maintenanceLease: LocalTerminalMaintenanceLease | undefined;
  private shuttingDown = false;
  private shutdownFlight: Promise<LocalHostShutdownResult> | undefined;
  private readonly processAuthority: LocalTerminalProcessAuthority;
  private readonly killGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly lateExitGraceMs: number;
  private readonly externalMaintenanceFence: () => boolean;
  private readonly observerPlane: TerminalObserverPlane;
  /**
   * Live attach leases that are painting a surface, leaseId -> bindingId.
   *
   * A lease is what makes a session "one somebody is looking at": the renderer
   * takes one when a node is opened and `release` runs on close, on renderer
   * teardown, and on render-process loss. Holding the mapping here keeps the
   * refcount idempotent — a double `release` for the same lease must not drop
   * another viewer's retention.
   */
  private readonly surfaceLeases = new Map<string, string>();
  private readonly primeDaemons: PrimeAgentDaemons | undefined;
  private primeDaemonsShutdownState:
    | "idle"
    | "pending"
    | "clean"
    | "failed" = "idle";
  private primeDaemonsShutdownError: string | undefined;
  private primeDaemonsShutdownFlight: Promise<void> | undefined;

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
    this.primeDaemons = options.primeDaemons === undefined
      ? processAuthority === appProcessPlane
        ? primeAgentDaemons
        : undefined
      : options.primeDaemons ?? undefined;
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
    const occupancy = occupancyFromSession(
      bindingId,
      current === undefined
        ? undefined
        : {
            epoch: current.epoch,
            status: sessionStatusOf(current),
            ...(current.killed ? { stopping: true as const } : {}),
          },
      "local",
    );
    const occupy = occupyVacantSeat(occupancy);
    if (Result.isFailure(occupy) && current) {
      // Occupied create is an idempotent ensure only for the exact requested
      // actor identity. Any other occupant is a typed conflict — a live
      // generation is never repurposed.
      const incumbent = this.summaryOf(current);
      if (
        incumbent.harness === input.harness &&
        incumbent.agentKey === input.agentKey &&
        incumbent.canvasName === input.canvasName &&
        incumbent.nodeId === input.nodeId
      ) {
        return incumbent;
      }
      throw seatIdentityConflictError(
        bindingId,
        {
          harness: input.harness,
          agentKey: input.agentKey,
          canvasName: input.canvasName ?? "",
          nodeId: input.nodeId ?? "",
        },
        {
          ...(incumbent.harness === undefined
            ? {}
            : { harness: incumbent.harness }),
          ...(incumbent.agentKey === undefined
            ? {}
            : { agentKey: incumbent.agentKey }),
          ...(incumbent.canvasName === undefined
            ? {}
            : { canvasName: incumbent.canvasName }),
          ...(incumbent.nodeId === undefined
            ? {}
            : { nodeId: incumbent.nodeId }),
        },
      );
    }
    // Under isolation, never spawn pin harnesses with resume argv even if a
    // caller bypassed launchForManagedSpawn and handed us document -r.
    let launch = input.launch;
    let resumeAttempt = launchArgvUsesResume(launch?.argv);
    if (
      shouldAvoidSharedHarnessResume() &&
      isPinSessionHarness(input.harness) &&
      resumeAttempt
    ) {
      const freshId = randomUUID();
      try {
        launch = planFreshPinSession({
          harness: input.harness,
          documentLaunch: input.launch,
          agentKey: input.agentKey,
          cwd: input.launch?.cwd,
          sessionId: freshId,
        }).launch;
        resumeAttempt = false;
      } catch (err) {
        console.error(
          `[term] isolate fresh-pin plan failed for ${bindingId}; refusing shared resume:`,
          err,
        );
        throw new Error(
          `isolated VELLUM_COMMAND_HOME refuses shared harness resume for ${input.harness}`,
        );
      }
    }
    const opened = this.open(
      {
        kind: "agent",
        harness: input.harness,
        agentKey: input.agentKey,
        ...(launch ? { launch } : {}),
      },
      {
        ...input,
        ...(launch ? { launch } : {}),
      },
      {
        resumeAttempt,
        failOpenSeed: {
          ...input,
          ...(launch ? { launch } : {}),
        },
      },
    );
    // Fail-open after a dead resume can replace this binding during open (or
    // immediately after exit). Create must return the authoritative generation
    // for the binding — never the exited resume row that is no longer current.
    // Returning the dead summary is what painted "Agent stopped" while a live
    // replacement was already running (Reopen then attached instantly).
    const head = this.sessions.get(bindingId);
    return head ? this.summaryOf(head) : opened;
  }

  private open(
    seat: TerminalSeat,
    input: TerminalOpenInput,
    agentMeta?: {
      readonly resumeAttempt: boolean;
      readonly failOpenSeed: LocalHostAgentSeatInput;
      readonly failOpenUsed?: boolean;
    },
  ): TerminalSessionSummary {
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
    const occupancy = occupancyFromSession(
      bindingId,
      prior === undefined
        ? undefined
        : {
            epoch: prior.epoch,
            status: sessionStatusOf(prior),
            ...(prior.killed ? { stopping: true as const } : {}),
          },
      "local",
    );
    if (Result.isFailure(occupyVacantSeat(occupancy)) && prior) {
      appendTransportTrace({
        plane: "term",
        op: "host.occupy",
        ok: true,
        bindingId,
        status: sessionStatusOf(prior),
        occupancy: occupancy._tag,
        decision: "activate",
      });
      return this.summaryOf(prior);
    }
    appendTransportTrace({
      plane: "term",
      op: "host.occupy",
      ok: true,
      bindingId,
      status: prior ? sessionStatusOf(prior) : "none",
      occupancy: occupancy._tag,
      decision: "occupy",
    });

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
    const requestedCanvasName = input.canvasName?.trim() || undefined;
    const requestedNodeId = input.nodeId?.trim() || undefined;
    // A partial anchor names no principal. Keep the generation intentionally
    // unbound until bindCanvas supplies both halves together.
    const canvasName = requestedCanvasName && requestedNodeId
      ? requestedCanvasName
      : undefined;
    const nodeId = requestedCanvasName && requestedNodeId
      ? requestedNodeId
      : undefined;
    const rec: SessionRec = {
      bindingId,
      epoch,
      hostId: input.hostId?.trim() || "local",
      phase: SessionPhase.Opening({ surface: "native" }),
      lease: undefined,
      exitWitness: undefined,
      listenerCleanups: [],
      pid: undefined,
      ptyIdentityBinding: undefined,
      daemonIdentityBinding: undefined,
      primeDaemon: undefined,
      primeDaemonStopFlight: undefined,
      primeDaemonCleanupState: "none",
      primeDaemonCleanupError: undefined,
      cols,
      rows,
      cwd: Result.isSuccess(resolved) ? resolved.success.cwd : resolveCwd(seat.launch),
      title: input.title,
      label: input.label,
      backend: undefined,
      canvasName,
      nodeId,
      agentKey,
      harness,
      detached: canvasName === undefined,
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
      resumeAttempt: agentMeta?.resumeAttempt === true,
      resumeFailureSeen: false,
      failOpenUsed: agentMeta?.failOpenUsed === true,
      failOpenSeed: agentMeta?.failOpenSeed,
    };
    this.sessions.set(bindingId, rec);
    this.liveRecords.add(rec);
    // Binding-scoped stores are not epoch-keyed. Clear them at the authority
    // handoff so an old generation's late callbacks cannot leak into the new.
    clearFirstTypedMessage(bindingId);
    clearCapturedSessionId(bindingId);

    if (Result.isFailure(resolved)) {
      // An actor whose launch does not resolve stops here and shows the error
      // state on its node. It never falls through to a shell.
      this.failBeforeOwnership(
        rec,
        new Error(
          `${resolved.failure.harness} seat launch unresolvable: ${resolved.failure.reason}`,
        ),
      );
      return this.summaryOf(rec);
    }
    const launch = resolved.success;
    if (seat.kind === "agent") {
      rec.resumeAttempt = launchArgvUsesResume([launch.file, ...launch.args]);
    }
    // Best-effort display name until OSC title updates (the daemon wrapper is
    // transport, not the process name the operator chose).
    const spawnName = basename(launch.file).trim();
    if (spawnName.length > 0) rec.processName = spawnName;
    if (!isUsableCwd(launch.cwd)) {
      // node-pty exits the child with code 1 and no output for a missing or
      // non-directory cwd (including a literal unexpanded `~/…` before expand).
      // Fail before ownership so the journal names the path.
      this.failBeforeOwnership(
        rec,
        new Error(`working directory is not a usable directory: ${launch.cwd}`),
      );
      return this.summaryOf(rec);
    }

    let terminalLaunch: ResolvedLaunch = launch;
    if (
      seat.kind === "agent" &&
      seat.harness === "prime-agent" &&
      this.primeDaemons !== undefined
    ) {
      try {
        const daemon = this.primeDaemons.start({
          bindingId,
          epoch,
          launch,
          onReport: (report) => this.observePrimeAgentReport(rec, report),
          onUnexpectedExit: () => this.observePrimeDaemonUnexpectedExit(rec),
        });
        rec.primeDaemon = daemon;
        this.primeDaemonRecords.add(rec);
        terminalLaunch = daemon.terminalLaunch;
        // The daemon must wield the exact seat principal before its socket-routed
        // client is spawned and can release the initial prompt.
        if (!this.bindDaemonProcessIdentity(rec)) {
          throw new Error("Prime Agent daemon process identity bind failed");
        }
        if (rec.killed || !this.liveRecords.has(rec)) {
          throw new Error("Prime Agent daemon exited during startup");
        }
      } catch (error) {
        this.revokeProcessIdentities(rec);
        this.requestPrimeDaemonStop(rec, "prime_daemon_start_failed");
        this.failBeforeOwnership(rec, error);
        return this.summaryOf(rec);
      }
    }

    if (!isUsableCwd(terminalLaunch.cwd)) {
      const error = new Error(
        `working directory is not a usable directory: ${terminalLaunch.cwd}`,
      );
      this.revokeProcessIdentities(rec);
      this.requestPrimeDaemonStop(rec, "prime_daemon_launch_invalid");
      this.failBeforeOwnership(rec, error);
      return this.summaryOf(rec);
    }

    let lease: AppTerminalLease;
    try {
      const spec: AppTerminalSpawnSpec = {
        source: `term:${bindingId}`,
        purpose: `local terminal ${bindingId}@${epoch}`,
        command: terminalLaunch.file,
        args: terminalLaunch.args,
        cwd: terminalLaunch.cwd,
        env: terminalLaunch.env,
        cols,
        rows,
      };
      lease = this.processAuthority.spawnTerminal(spec);
    } catch (err) {
      this.revokeProcessIdentities(rec);
      this.requestPrimeDaemonStop(rec, "terminal_spawn_failed");
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
      // The terminal is a second exact generation for the same principal. A
      // missing/failed bind is a setup failure, never permission to run ambient.
      if (!this.bindPtyProcessIdentity(rec)) {
        throw new Error("terminal process identity bind failed");
      }
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
        armFirstTypedMessage(bindingId, firstTyped);
      }
      // Devin announces its session id nowhere on the PTY — the id lives in a
      // lockfile written by a descendant of the process we just spawned.
      this.scheduleDevinSessionDiscovery(rec);
      if (!this.liveRecords.has(rec)) {
        this.observerPlane.detach(bindingId, epoch);
        if (seat.kind === "agent") {
          seatStateRuntime.unbind(bindingId, epoch, "generation_aborted");
        }
        if (this.sessions.get(bindingId) === rec) {
          clearFirstTypedMessage(bindingId);
        }
        // Resume fail-open may already own this binding with a live generation.
        const replacement = this.sessions.get(bindingId);
        if (
          replacement &&
          replacement !== rec &&
          sessionStatusOf(replacement) !== "exited"
        ) {
          return this.summaryOf(replacement);
        }
        return this.summaryOf(rec);
      }

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
      this.requestStop(rec, "terminal_setup_failed");
      if (seat.kind === "agent") {
        // Actor occupation is fail-closed: the process is torn down exactly as
        // for geography, but the occupation itself rejects with a typed
        // failure instead of converging on an exited summary.
        throw seatOccupationFailedError(bindingId, epoch, err);
      }
    }

    // Prefer the map head: fail-open may have swapped the binding mid-open.
    const head = this.sessions.get(bindingId);
    return this.summaryOf(head && this.liveRecords.has(head) ? head : rec);
  }

  list(): readonly TerminalSessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summaryOf(s));
  }

  get(bindingId: string): TerminalSessionSummary | undefined {
    const rec = this.sessions.get(bindingId);
    return rec ? this.summaryOf(rec) : undefined;
  }

  /**
   * Subscribe first, then optionally replay current live session state.
   *
   * The exact-record recheck matters when a replay listener synchronously
   * stops or replaces another binding: only the generation still authoritative
   * in `sessions` may be presented as current.
   */
  subscribeEvents(
    listener: LocalHostEventListener,
    options: LocalHostEventSubscriptionOptions = {},
  ): () => void {
    this.on("event", listener);
    if (options.replayCurrentSessions) {
      try {
        for (const rec of [...this.sessions.values()]) {
          if (this.sessions.get(rec.bindingId) !== rec) continue;
          const status = sessionStatusOf(rec);
          if (status === "exited") continue;
          listener({
            type: "session",
            bindingId: rec.bindingId,
            epoch: rec.epoch,
            status,
            ...(status === "running" && rec.pid !== undefined
              ? { pid: rec.pid }
              : {}),
          });
        }
      } catch (error) {
        this.off("event", listener);
        throw error;
      }
    }
    return () => this.off("event", listener);
  }

  bindCanvas(
    bindingId: string,
    ref: { canvasName?: string; nodeId?: string } | null,
  ): void {
    const rec = this.sessions.get(bindingId);
    if (!rec || rec.killed || sessionStatusOf(rec) === "exited") return;
    const canvasName = ref?.canvasName?.trim() || undefined;
    const nodeId = ref?.nodeId?.trim() || undefined;

    // Rebinding is two exact-generation retirements followed by two exact
    // mints. A partial anchor is deliberately no principal at all.
    this.revokeProcessIdentities(rec);
    if (canvasName === undefined || nodeId === undefined) {
      rec.canvasName = undefined;
      rec.nodeId = undefined;
      rec.detached = true;
      return;
    }

    rec.canvasName = canvasName;
    rec.nodeId = nodeId;
    rec.detached = false;
    if (!this.bindAllProcessIdentities(rec)) {
      this.revokeProcessIdentities(rec);
      this.recordPostSpawnFailure(
        rec,
        new Error("canvas rebind could not bind every exact process generation"),
      );
      this.requestStop(rec, "canvas_identity_rebind_failed");
    }
  }

  async attach(input: {
    readonly bindingId: string;
    readonly mode: "control" | "observe";
    readonly takeover?: boolean;
  }): Promise<
    | {
        readonly ok: true;
        readonly lease: ControlLease;
        readonly cols: number;
        readonly rows: number;
        /** Canonical live-session attach: serialized xterm VT state. */
        readonly screen?: {
          readonly bindingId: string;
          readonly epoch: string;
          readonly cols: number;
          readonly rows: number;
          readonly seq: bigint;
          readonly serialized: string;
        };
        /** Spawn/setup diagnostics only, when no live observer was created. */
        readonly journal: readonly JournalEntry[];
        readonly status: "starting" | "running" | "exited";
        readonly pid?: number;
      }
    | { readonly ok: false; readonly message: string }
  > {
    let rec = this.sessions.get(input.bindingId);
    if (!rec) return { ok: false, message: "session not found" };
    if (rec.killed) {
      return { ok: false, message: "session interaction revoked during stop" };
    }

    // One canonical live attach representation: xterm's serialized VT state.
    // Never reconstruct a terminal from observer text.
    let screen = await this.observerPlane.attachScreen(rec.bindingId);

    // attachScreen awaits the headless grid. A resume generation can die and
    // be fail-open replaced while we waited — the map head is then a NEW live
    // epoch. Returning the stale exited rec is exactly "Agent stopped" with a
    // live pin already running (Reopen only re-attached). Re-resolve once.
    const head = this.sessions.get(input.bindingId);
    if (head && head !== rec) {
      rec = head;
      if (rec.killed) {
        return { ok: false, message: "session interaction revoked during stop" };
      }
      if (sessionStatusOf(rec) !== "exited") {
        screen = await this.observerPlane.attachScreen(rec.bindingId);
      }
    }

    const screenPayload = screen
      ? {
          bindingId: screen.bindingId,
          epoch: screen.epoch,
          cols: screen.cols,
          rows: screen.rows,
          seq: screen.seq,
          serialized: screen.serialized,
        }
      : undefined;
    // A live observer owns presentation. Journal is retained only for
    // pre-observer spawn/setup failures, never as an alternate live painter.
    // Drop a screen snapshot that belongs to a different (dead) epoch.
    const screenForRec =
      screenPayload && screenPayload.epoch === rec.epoch
        ? screenPayload
        : undefined;
    const journal = screenForRec ? ([] as const) : rec.journal.slice();

    if (input.mode === "control") {
      if (rec.controlLeaseId && !input.takeover) {
        return { ok: false, message: "control lease held (pass takeover)" };
      }
      // Takeover drops the prior control lease without a `release` call on
      // every path — give its retention back here or the refcount never drains.
      if (rec.controlLeaseId) this.releaseSurfaceLease(rec.controlLeaseId);
      rec.controlLeaseId = mintLease();
      // A surface is now painting this session: retain the full scrollback for
      // as long as the lease lives. `screen` above was already serialized from
      // the bounded window, so this only changes what accrues from here on.
      this.retainSurfaceLease(rec.controlLeaseId, rec.bindingId);
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
        ...(screenForRec ? { screen: screenForRec } : {}),
        journal,
        status: sessionStatusOf(rec),
        pid: rec.pid,
      };
    }

    const observeLeaseId = mintLease();
    this.retainSurfaceLease(observeLeaseId, rec.bindingId);
    return {
      ok: true,
      lease: {
        leaseId: observeLeaseId,
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        mode: "observe",
      },
      cols: rec.cols,
      rows: rec.rows,
      ...(screenForRec ? { screen: screenForRec } : {}),
      journal,
      status: sessionStatusOf(rec),
      pid: rec.pid,
    };
  }

  /**
   * Record that this lease is painting the binding and raise the observer's
   * retention tier. Idempotent per lease id.
   */
  private retainSurfaceLease(leaseId: string, bindingId: string): void {
    if (this.surfaceLeases.has(leaseId)) return;
    this.surfaceLeases.set(leaseId, bindingId);
    this.observerPlane.retainSurface(bindingId);
  }

  /** Give back what `retainSurfaceLease` took. No-op for an unknown lease. */
  private releaseSurfaceLease(leaseId: string): void {
    const bindingId = this.surfaceLeases.get(leaseId);
    if (bindingId === undefined) return;
    this.surfaceLeases.delete(leaseId);
    this.observerPlane.releaseSurface(bindingId);
  }

  release(lease: ControlLease): void {
    // Surface retention is lease-scoped, never record-scoped: a session that
    // exited while a node was open must still give the scrollback back.
    this.releaseSurfaceLease(lease.leaseId);
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
    return this.writeRecord(rec, data);
  }

  /**
   * In-process factory delivery for the current managed-agent generation.
   *
   * Product automation is not an external terminal controller and must never
   * enter control-lease takeover arbitration with the interactive renderer.
   * The kernel has already proven the actor edge and binding; this boundary
   * additionally refuses geography terminals and dead generations.
   */
  writeManagedSeat(bindingId: string, data: string): boolean {
    const rec = this.sessions.get(bindingId);
    if (
      !rec ||
      !rec.agentKey ||
      !rec.harness ||
      rec.killed ||
      !rec.lease ||
      !sessionPhaseAllowsWrite(rec.phase)
    ) {
      return false;
    }
    return this.writeRecord(rec, data);
  }

  private writeRecord(rec: SessionRec, data: string): boolean {
    const lease = rec.lease;
    if (!lease) return false;
    try {
      lease.io.write(data);
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
    return this.killBinding(bindingId, "explicit_kill");
  }

  /**
   * Node deletion is stronger than an interactive Stop click: synchronously cut
   * the exact current generation, then wait for both its PTY witness and any
   * Prime Agent daemon receipt. A missing binding is already clean.
   */
  async deleteBinding(bindingId: string): Promise<boolean> {
    const rec = this.sessions.get(bindingId.trim());
    if (rec === undefined) return true;
    this.requestStop(rec, "node_delete");
    if (await this.waitForRecordExitWithin(rec, this.shutdownGraceMs)) return true;
    if (this.recordCleanupFailed(rec)) return false;

    if (this.liveRecords.has(rec)) this.forceKill(rec, "SIGKILL");
    if (await this.waitForRecordExitWithin(rec, this.shutdownGraceMs)) return true;
    if (this.recordCleanupFailed(rec)) return false;
    return this.waitForRecordExitWithin(rec, this.lateExitGraceMs);
  }

  runningCount(): number {
    return this.outstandingGenerationCount();
  }

  /**
   * Atomically observes the exact live-generation set and closes create
   * admission only when it is empty. JavaScript execution cannot interleave a
   * synchronous create/shutdown call between the observation and capability
   * mint.
   */
  acquireMaintenanceLease(): LocalTerminalMaintenanceAcquireResult {
    const activeTerminalSessions = this.outstandingGenerationCount();
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
      this.requestStop(rec, reason);
    }
    this.requestPrimeDaemonsShutdown(reason);
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
    // that observed callback one final bounded, event-driven window. Daemon
    // stop receipts share the same bound; a hung daemon can never yield clean.
    if (await this.waitForAllExitsWithin(this.lateExitGraceMs)) {
      return { clean: true, stragglers: [] };
    }
    const retained = new Set([...this.liveRecords, ...this.primeDaemonRecords]);
    const stragglers = [...retained].map((rec) => {
      const status = sessionStatusOf(rec) === "exited"
        ? "running" as const
        : activeSessionStatusOf(rec);
      const primeDaemon = this.primeDaemonRecords.has(rec)
        ? {
            daemonPid: rec.primeDaemon?.daemonPid,
            state: rec.primeDaemonCleanupState === "failed"
              ? "failed" as const
              : "pending" as const,
            ...(rec.primeDaemonCleanupError === undefined
              ? {}
              : { message: rec.primeDaemonCleanupError }),
          }
        : undefined;
      return {
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        status,
        ...(rec.pid === undefined ? {} : { pid: rec.pid }),
        ...(this.liveRecords.has(rec) ? { ownedPtyOutstanding: true as const } : {}),
        ...(rec.termReceipt === undefined ? {} : { term: rec.termReceipt }),
        ...(rec.killReceipt === undefined ? {} : { kill: rec.killReceipt }),
        ...(primeDaemon === undefined ? {} : { primeDaemon }),
      };
    }) as LocalHostShutdownStraggler[];
    if (
      this.primeDaemonsShutdownState === "pending" ||
      this.primeDaemonsShutdownState === "failed"
    ) {
      stragglers.push({
        bindingId: "prime-agent-daemon-manager",
        epoch: "shutdown",
        status: "running",
        primeDaemon: {
          state: this.primeDaemonsShutdownState === "failed"
            ? "manager_failed"
            : "manager_pending",
          ...(this.primeDaemonsShutdownError === undefined
            ? {}
            : { message: this.primeDaemonsShutdownError }),
        },
      });
    }
    console.error(
      `[term] ${reason} retained ${stragglers.length} local generation cleanup(s): ${stragglers
        .map((rec) => `${rec.bindingId}@${rec.epoch}${rec.pid === undefined ? "" : ` pid=${rec.pid}`}`)
        .join(", ")}`,
    );
    // Retained exact authorities remain live. Shutdown admission is monotonic:
    // a failed quit may retry the same records but can never spawn new ones.
    return { clean: false, stragglers };
  }

  private killBinding(bindingId: string, reason: string): boolean {
    const rec = this.sessions.get(bindingId);
    if (!rec) return false;
    if (sessionStatusOf(rec) === "exited") {
      this.revokeProcessIdentities(rec);
      this.requestPrimeDaemonStop(rec, reason);
      return true;
    }
    this.requestStop(rec, reason);
    return true;
  }

  private requestStop(rec: SessionRec, reason: string): void {
    const alreadyKilled = rec.killed;
    rec.killed = true;
    rec.controlLeaseId = undefined;
    // Identity revocation is synchronous and exact. Neither daemon shutdown nor
    // terminal TERM may begin while a dying generation still wields the seat.
    this.revokeProcessIdentities(rec);
    this.clearPrimeAgentReporterHook(rec, reason);
    this.requestPrimeDaemonStop(rec, reason);
    if (alreadyKilled || sessionStatusOf(rec) === "exited") return;

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

  private observePrimeAgentReport(
    rec: SessionRec,
    report: PrimeAgentDaemonReport,
  ): void {
    // Reporter sockets are per generation, but the host independently fences the
    // callback because a released registration may already have queued a frame.
    if (
      this.sessions.get(rec.bindingId) !== rec ||
      !this.liveRecords.has(rec) ||
      rec.killed ||
      report.bindingId !== rec.bindingId ||
      report.epoch !== rec.epoch
    ) return;

    const sessionId = safeStructuredSessionId(report);
    if (sessionId !== undefined) {
      recordCapturedSessionId(rec.bindingId, sessionId);
      // The reporter is Prime Agent's own structured channel — a better source
      // than scraped PTY text, and it reaches the same proof-then-store path.
      this.persistCapturedSession(rec, sessionId);
    }
    if (report.released === true) {
      seatStateRuntime.clearStructuredHook(
        rec.bindingId,
        rec.epoch,
        report.reason,
      );
      return;
    }
    seatStateRuntime.observeStructuredHook({
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      state: report.state,
      reason: report.reason,
    });
  }

  private clearPrimeAgentReporterHook(rec: SessionRec, reason: string): void {
    if (rec.harness !== "prime-agent") return;
    seatStateRuntime.clearStructuredHook(rec.bindingId, rec.epoch, reason);
  }

  private observePrimeDaemonUnexpectedExit(rec: SessionRec): void {
    if (!this.liveRecords.has(rec)) return;
    // Exact bindings are retired before terminal TERM. The callback owns `rec`,
    // never a mutable binding lookup, so an old daemon cannot stop a replacement.
    this.revokeProcessIdentities(rec);
    if (this.sessions.get(rec.bindingId) === rec) {
      const data =
        "\r\n[vellum] Prime Agent daemon exited unexpectedly; stopping client\r\n";
      rec.seq = rec.seq + 1n;
      this.pushJournal(rec, {
        seq: rec.seq,
        type: "output",
        data,
      });
      this.safeEmitEvent({
        type: "output",
        bindingId: rec.bindingId,
        epoch: rec.epoch,
        seq: rec.seq,
        data,
      });
    }
    this.requestStop(rec, "prime_daemon_unexpected_exit");
  }

  private requestPrimeDaemonStop(rec: SessionRec, reason: string): void {
    const daemon = rec.primeDaemon;
    if (
      daemon === undefined ||
      rec.primeDaemonStopFlight !== undefined ||
      rec.primeDaemonCleanupState !== "none"
    ) return;
    rec.primeDaemonCleanupState = "pending";
    let stopReceipt: ReturnType<PrimeAgentDaemonHandle["stop"]>;
    try {
      stopReceipt = daemon.stop(reason);
    } catch (error) {
      this.markPrimeDaemonCleanupFailed(rec, error);
      return;
    }
    rec.primeDaemonStopFlight = Promise.resolve(stopReceipt).then(
      (receipt) => {
        const failure = cleanupFailureMessage(receipt);
        if (failure !== undefined) {
          this.markPrimeDaemonCleanupFailed(rec, failure);
          return;
        }
        rec.primeDaemonCleanupState = "clean";
        rec.primeDaemonCleanupError = undefined;
        this.primeDaemonRecords.delete(rec);
        this.notifyQuiescentWaiters();
      },
      (error) => this.markPrimeDaemonCleanupFailed(rec, error),
    );
  }

  private markPrimeDaemonCleanupFailed(rec: SessionRec, error: unknown): void {
    rec.primeDaemonCleanupState = "failed";
    rec.primeDaemonCleanupError = errorMessage(error);
    console.error(
      `[term] Prime Agent daemon cleanup failed for ${rec.bindingId}@${rec.epoch}:`,
      error,
    );
    this.notifyQuiescentWaiters();
    // Keep the record outstanding. A bounded shutdown must report it non-clean.
  }

  private requestPrimeDaemonsShutdown(reason: string): void {
    const manager = this.primeDaemons;
    if (manager === undefined || this.primeDaemonsShutdownFlight !== undefined) {
      return;
    }
    this.primeDaemonsShutdownState = "pending";
    let shutdownReceipt: ReturnType<PrimeAgentDaemons["shutdownAll"]>;
    try {
      shutdownReceipt = manager.shutdownAll(reason);
    } catch (error) {
      this.primeDaemonsShutdownState = "failed";
      this.primeDaemonsShutdownError = errorMessage(error);
      this.primeDaemonsShutdownFlight = Promise.resolve();
      return;
    }
    this.primeDaemonsShutdownFlight = Promise.resolve(shutdownReceipt).then(
      (receipt) => {
        const failure = cleanupFailureMessage(receipt);
        if (failure !== undefined) {
          this.primeDaemonsShutdownState = "failed";
          this.primeDaemonsShutdownError = failure;
          return;
        }
        this.primeDaemonsShutdownState = "clean";
        this.primeDaemonsShutdownError = undefined;
        this.notifyQuiescentWaiters();
      },
      (error) => {
        this.primeDaemonsShutdownState = "failed";
        this.primeDaemonsShutdownError = errorMessage(error);
      },
    );
  }

  private outstandingGenerationCount(): number {
    return new Set([...this.liveRecords, ...this.primeDaemonRecords]).size;
  }

  private shutdownQuiescent(): boolean {
    if (this.liveRecords.size !== 0 || this.primeDaemonRecords.size !== 0) {
      return false;
    }
    return this.primeDaemons === undefined ||
      this.primeDaemonsShutdownState === "clean";
  }

  private recordQuiescent(rec: SessionRec): boolean {
    return !this.liveRecords.has(rec) && !this.primeDaemonRecords.has(rec);
  }

  private recordCleanupFailed(rec: SessionRec): boolean {
    return !this.liveRecords.has(rec) &&
      rec.primeDaemonCleanupState === "failed";
  }

  private waitForRecordExitWithin(
    rec: SessionRec,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.recordQuiescent(rec)) return Promise.resolve(true);
    if (this.recordCleanupFailed(rec) || timeoutMs <= 0) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: RecordExitWaiter = {
        record: rec,
        timer: undefined,
        resolve,
      };
      waiter.timer = setTimeout(() => {
        if (!this.recordExitWaiters.delete(waiter)) return;
        resolve(this.recordQuiescent(rec));
      }, timeoutMs);
      this.recordExitWaiters.add(waiter);
      if (
        (this.recordQuiescent(rec) || this.recordCleanupFailed(rec)) &&
        this.recordExitWaiters.delete(waiter)
      ) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        resolve(this.recordQuiescent(rec));
      }
    });
  }

  private waitForAllExitsWithin(timeoutMs: number): Promise<boolean> {
    if (this.shutdownQuiescent()) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: AllExitedWaiter = {
        timer: undefined,
        resolve,
      };
      waiter.timer = setTimeout(() => {
        if (!this.allExitedWaiters.delete(waiter)) return;
        resolve(this.shutdownQuiescent());
      }, timeoutMs);
      this.allExitedWaiters.add(waiter);
      // Defensive totality if future code makes registration re-entrant.
      if (this.shutdownQuiescent() && this.allExitedWaiters.delete(waiter)) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        resolve(true);
      }
    });
  }

  /**
   * A capture harness just announced its session id. Prove it against the
   * harness's own state, then write it to the seat's node so the next wake
   * resumes this conversation instead of opening a new one.
   *
   * Fire-and-forget by design: the PTY data path must not wait on a filesystem
   * probe or a canvas write, and a seat whose id cannot be proven simply keeps
   * running with the id held for this generation only.
   */
  /**
   * Devin's cold-resume loop, opened at spawn.
   *
   * Every other capture harness prints its id, so `observeData` sees it. Devin
   * prints nothing and writes `session_locks/<slug>.lock` from a descendant of
   * the process this host spawned, so the id has to be looked up rather than
   * read. Discovery is bounded and fire-and-forget: it never gates the spawn,
   * and a seat whose id is never found simply keeps running without one.
   *
   * The id found here is a candidate, not proof — `persistCapturedSession`
   * still refuses to store it until Devin's own `sessions` row exists, which
   * is what makes `-r <id>` work.
   */
  private scheduleDevinSessionDiscovery(rec: SessionRec): void {
    if (rec.harness !== "devin") return;
    const pid = rec.pid;
    if (pid === undefined) return;
    if (getCapturedSessionId(rec.bindingId)) return;
    const epoch = rec.epoch;
    void discoverDevinSessionId({
      pid,
      stillRunning: () =>
        this.sessions.get(rec.bindingId) === rec &&
        rec.epoch === epoch &&
        !rec.killed &&
        this.liveRecords.has(rec),
    })
      .then((sessionId) => {
        if (!sessionId) return;
        if (this.sessions.get(rec.bindingId) !== rec || rec.epoch !== epoch) {
          return;
        }
        recordCapturedSessionId(rec.bindingId, sessionId);
        this.persistCapturedSession(rec, sessionId, DEVIN_PROOF_RETRY_DELAYS_MS);
      })
      .catch(() => {
        // Recovery, never a gate.
      });
  }

  private persistCapturedSession(
    rec: SessionRec,
    sessionId: string,
    delays?: readonly number[],
  ): void {
    const canvasName = rec.canvasName;
    const nodeId = rec.nodeId;
    const harness = rec.harness;
    if (!canvasName || !nodeId || !harness) return;
    if (!usesCapturedSession(harness)) return;
    void scheduleCapturedSessionPersist(
      `${rec.bindingId}@${rec.epoch}`,
      {
        canvasName,
        nodeId,
        harness,
        sessionId,
        ...(rec.cwd ? { cwd: rec.cwd } : {}),
      },
      ...(delays ? ([delays] as const) : ([] as const)),
    ).catch(() => {
      // Recovery, never a gate: a failed persist leaves the seat untouched.
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
      if (sid) {
        recordCapturedSessionId(rec.bindingId, sid);
        this.persistCapturedSession(rec, sid);
      }
      rec.sessionCaptureTail = captureText.slice(-SESSION_CAPTURE_TAIL_BYTES);
    } else {
      rec.sessionCaptureTail = `${rec.sessionCaptureTail}${data}`.slice(
        -SESSION_CAPTURE_TAIL_BYTES,
      );
    }
    // Resume failure evidence is harness-printed, not our cache. Tail is enough
    // when the error is short; also check the live chunk.
    if (
      rec.resumeAttempt &&
      !rec.resumeFailureSeen &&
      (isHarnessResumeFailureText(data) ||
        isHarnessResumeFailureText(rec.sessionCaptureTail))
    ) {
      rec.resumeFailureSeen = true;
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
    // Natural client exit owns the same cleanup contract as explicit stop.
    // Revoke exact identities before asking the daemon to drain.
    this.revokeProcessIdentities(rec);
    this.clearPrimeAgentReporterHook(rec, "terminal_exit");
    this.requestPrimeDaemonStop(rec, "terminal_exit");
    this.removeLiveRecord(rec);
    const current = this.sessions.get(rec.bindingId);
    rec.phase = SessionPhase.Closed({
      surface: "native",
      reason: signal !== undefined ? `signal_${signal}` : `exit_${code ?? "null"}`,
    });
    rec.lease = undefined;
    rec.exitWitness = undefined;
    if (current !== rec) return;
    appendTransportTrace({
      plane: "term",
      op: "host.exit",
      ok: true,
      bindingId: rec.bindingId,
      status: "exited",
      occupancy: "VacantSeat",
      epoch: rec.epoch,
      ...(code === undefined ? {} : { code }),
      ...(signal === undefined ? {} : { signal }),
    });
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
    // Never fail-closed on resume: if the harness rejected -r, open a fresh pin.
    // Some harnesses die with no printed proof when a session is already owned
    // by another Vellum Command process (prod + bun run dev side-by-side). Treat
    // a quick empty exit after resume argv as the same class of miss.
    if (
      rec.resumeAttempt &&
      !rec.resumeFailureSeen &&
      rec.journalBytes === 0 &&
      Date.now() - rec.createdAt < 4_000
    ) {
      rec.resumeFailureSeen = true;
    }
    this.maybeFailOpenAfterResumeFailure(rec);
  }

  /**
   * One-shot fail-open: resume generation died with harness proof of a missing
   * remote/local session → mint a new pin id and respawn. Explicit resumption
   * UI (later) is the only path that may fail closed.
   */
  private maybeFailOpenAfterResumeFailure(rec: SessionRec): void {
    if (rec.failOpenUsed || !rec.resumeAttempt || !rec.resumeFailureSeen) return;
    if (rec.killed) return;
    const seed = rec.failOpenSeed;
    if (!seed || !rec.harness || !isPinSessionHarness(rec.harness)) return;
    if (this.shuttingDown) return;

    rec.failOpenUsed = true;
    const freshId = randomUUID();
    let freshLaunch = seed.launch;
    let freshFirstTypedMessage = seed.firstTypedMessage;
    try {
      if (seed.resumeFallbackIntent) {
        const plan = planFreshManagedSpawnIntent(
          { harness: rec.harness, agentKey: seed.agentKey },
          seed.resumeFallbackIntent,
          freshId,
        );
        if (!plan) {
          throw new Error(`could not resolve fresh ${rec.harness} launch`);
        }
        freshLaunch = plan.launch;
        freshFirstTypedMessage = plan.firstTypedMessage;
      } else {
        const plan = planFreshPinSession({
          harness: rec.harness,
          documentLaunch: seed.launch,
          agentKey: seed.agentKey,
          cwd: seed.launch?.cwd ?? rec.cwd,
          sessionId: freshId,
        });
        freshLaunch = plan.launch;
      }
    } catch (err) {
      console.error(
        `[term] fail-open pin plan failed for ${rec.bindingId}; leaving exited:`,
        err,
      );
      return;
    }

    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, {
      seq: rec.seq,
      type: "output",
      data:
        `\r\n[vellum] resume failed for prior session; starting fresh session ${freshId}\r\n`,
    });

    // Spawn the replacement on this turn — not on a microtask. Exit bookkeeping
    // above is complete; deferring let createAgentSeat return the dead resume
    // summary while the live pin was still "about to" start. The renderer then
    // painted Agent stopped, and Reopen only re-attached to the generation that
    // was already running. Keep fail-open on the create/exit stack so ensure
    // and attach see the live generation immediately.
    if (this.shuttingDown) return;
    const live = this.sessions.get(rec.bindingId);
    if (live && live !== rec && sessionStatusOf(live) !== "exited") return;
    try {
      this.open(
        {
          kind: "agent",
          harness: seed.harness,
          agentKey: seed.agentKey,
          ...(freshLaunch ? { launch: freshLaunch } : {}),
        },
        {
          bindingId: seed.bindingId,
          ...(seed.hostId ? { hostId: seed.hostId } : {}),
          ...(seed.cols !== undefined ? { cols: seed.cols } : {}),
          ...(seed.rows !== undefined ? { rows: seed.rows } : {}),
          ...(seed.canvasName ? { canvasName: seed.canvasName } : {}),
          ...(seed.nodeId ? { nodeId: seed.nodeId } : {}),
          ...(seed.label ? { label: seed.label } : {}),
          ...(seed.title ? { title: seed.title } : {}),
          ...(freshFirstTypedMessage
            ? { firstTypedMessage: freshFirstTypedMessage }
            : {}),
        },
        {
          resumeAttempt: false,
          failOpenSeed: {
            ...seed,
            ...(freshLaunch ? { launch: freshLaunch } : {}),
            ...(freshFirstTypedMessage
              ? { firstTypedMessage: freshFirstTypedMessage }
              : {}),
          },
          failOpenUsed: true,
        },
      );
    } catch (err) {
      console.error(
        `[term] fail-open respawn failed for ${rec.bindingId}:`,
        err,
      );
    }
  }

  private failBeforeOwnership(rec: SessionRec, error: unknown): void {
    this.removeLiveRecord(rec);
    rec.phase = SessionPhase.Closed({ surface: "native", reason: "spawn_failed" });
    const classified = classifySpawnFailure(error, rec.harness);
    rec.exitReason = classified.reason;
    rec.exitMessage = classified.message;
    rec.seq = rec.seq + 1n;
    this.pushJournal(rec, {
      seq: rec.seq,
      type: "output",
      data: `\r\n[vellum] ${classified.journal}\r\n`,
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
    // Drop headless grid and structured authority for this exact epoch.
    this.observerPlane.detach(rec.bindingId, rec.epoch);
    this.clearPrimeAgentReporterHook(rec, "generation_exited");
    seatStateRuntime.unbind(
      rec.bindingId,
      rec.epoch,
      "generation_exited",
    );
    // These two stores are binding-keyed rather than epoch-keyed. An old exact
    // exit must never clear a replacement generation's prompt/session.
    if (this.sessions.get(rec.bindingId) === rec) {
      clearFirstTypedMessage(rec.bindingId);
      clearCapturedSessionId(rec.bindingId);
    }
    if (!this.liveRecords.delete(rec)) return;
    this.notifyQuiescentWaiters();
  }

  private notifyQuiescentWaiters(): void {
    for (const waiter of [...this.recordExitWaiters]) {
      if (
        !this.recordQuiescent(waiter.record) &&
        !this.recordCleanupFailed(waiter.record)
      ) continue;
      this.recordExitWaiters.delete(waiter);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(this.recordQuiescent(waiter.record));
    }
    if (!this.shutdownQuiescent()) return;
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

  private processPrincipal(rec: SessionRec): ProcessPrincipal | undefined {
    if (rec.canvasName === undefined || rec.nodeId === undefined) return undefined;
    // Managed actor seats bind as agent so work-control process-bind matches the card.
    return rec.agentKey
      ? {
          agentKey: rec.agentKey,
          canvasName: rec.canvasName,
          nodeId: rec.nodeId,
        }
      : {
          bindingId: rec.bindingId,
          canvasName: rec.canvasName,
          nodeId: rec.nodeId,
        };
  }

  private bindDaemonProcessIdentity(rec: SessionRec): boolean {
    const daemon = rec.primeDaemon;
    const principal = this.processPrincipal(rec);
    if (principal === undefined || daemon === undefined) return true;
    try {
      const binding = getProcessIdentityMap().bindGeneration(
        daemon.daemonPid,
        principal,
      );
      if (binding === undefined) return false;
      rec.daemonIdentityBinding = binding;
      return true;
    } catch (error) {
      console.error(
        `[term] daemon identity bind failed for ${rec.bindingId}@${rec.epoch}:`,
        error,
      );
      return false;
    }
  }

  private bindPtyProcessIdentity(rec: SessionRec): boolean {
    const principal = this.processPrincipal(rec);
    if (principal === undefined) return true;
    if (rec.pid === undefined || sessionStatusOf(rec) !== "running") return false;
    try {
      const binding = getProcessIdentityMap().bindGeneration(rec.pid, principal);
      if (binding === undefined) return false;
      rec.ptyIdentityBinding = binding;
      return true;
    } catch (error) {
      console.error(
        `[term] terminal identity bind failed for ${rec.bindingId}@${rec.epoch}:`,
        error,
      );
      return false;
    }
  }

  private bindAllProcessIdentities(rec: SessionRec): boolean {
    if (!this.bindDaemonProcessIdentity(rec)) return false;
    if (this.bindPtyProcessIdentity(rec)) return true;
    this.revokeProcessIdentities(rec);
    return false;
  }

  private revokeProcessIdentities(rec: SessionRec): void {
    const identities = getProcessIdentityMap();
    const bindings = [
      rec.daemonIdentityBinding,
      rec.ptyIdentityBinding,
    ].filter((binding): binding is ProcessIdentityBinding => binding !== undefined);
    rec.daemonIdentityBinding = undefined;
    rec.ptyIdentityBinding = undefined;
    for (const binding of bindings) {
      try {
        // False means this exact capability is already stale/revoked. It never
        // authorizes a numeric fallback that could erase a replacement.
        identities.unbindGeneration(binding);
      } catch (error) {
        console.error(
          `[term] exact identity revoke failed for ${rec.bindingId}@${rec.epoch}:`,
          error,
        );
      }
    }
  }

  private summaryOf(rec: SessionRec): TerminalSessionSummary {
    // Prefer live OSC window title (shell/app set) over spawn basename.
    const oscTitle =
      this.observerPlane.snapshot(rec.bindingId)?.signals.title?.trim() ||
      undefined;
    const processName =
      (oscTitle && oscTitle.length > 0 ? oscTitle : undefined) ||
      rec.processName ||
      (typeof rec.title === "string" && rec.title.trim().length > 0
        ? rec.title.trim()
        : undefined);
    return {
      bindingId: rec.bindingId,
      epoch: rec.epoch,
      hostId: rec.hostId,
      status: sessionStatusOf(rec),
      ...(rec.killed ? { stopping: true as const } : {}),
      title: rec.title ?? oscTitle,
      ...(processName ? { processName } : {}),
      cwd: rec.cwd,
      pid: rec.pid,
      detached: rec.detached,
      canvasName: rec.canvasName,
      nodeId: rec.nodeId,
      createdAt: rec.createdAt,
      label: rec.label,
      backend: rec.backend,
      ...(rec.exitReason ? { exitReason: rec.exitReason } : {}),
      ...(rec.exitMessage ? { exitMessage: rec.exitMessage } : {}),
      ...(rec.harness ? { harness: rec.harness } : {}),
      ...(rec.agentKey ? { agentKey: rec.agentKey } : {}),
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
