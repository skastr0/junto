import { seatStateRuntime } from "./agent-state";
import { LocalSessionHost } from "./local-host";
import { linuxReleaseFenceActive } from "./release-fence";
import { TerminalNodeDeleteService } from "./node-delete";
import { TerminalRouter } from "./router";
import {
  startTermControlServer,
  TermControlStartupError,
  type TermControlServer,
  type TermControlServerShutdownReceipt,
} from "./control-server";
import type { LocalHostShutdownResult } from "./local-host";
import type { TerminalRouterShutdownReceipt } from "./router";
import { performance } from "node:perf_hooks";
import { primeAgentDaemons } from "./prime-agent-daemon";
import {
  PrimeAgentReporterPlane,
  primeAgentReporterPlane,
  type PrimeAgentReporterShutdownReceipt,
} from "./prime-agent-reporter";

export interface TermPlaneShutdownReceipt {
  readonly clean: boolean;
  readonly local?: LocalHostShutdownResult;
  readonly router?: TerminalRouterShutdownReceipt;
  readonly control?: TermControlServerShutdownReceipt;
  readonly reporter?: PrimeAgentReporterShutdownReceipt;
  readonly retainedLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

/**
 * Machine-safety quit gate: only host-owned local PTY generations may block
 * app exit. Control UDS / remote-router retention is operator-visible debt
 * (process exit reclaims FDs; remotes keep their own sessions) — never a reason
 * to trap the operator inside a non-quitting Electron process.
 */
export const termPlaneBlocksAppExit = (
  receipt: TermPlaneShutdownReceipt,
): boolean =>
  receipt.retainedLabels.includes("local-sessions") ||
  (receipt.local?.clean === false &&
    receipt.local.stragglers.some(
      (straggler) => straggler.ownedPtyOutstanding === true,
    ));

export interface TermPlaneStartOptions {
  /**
   * Root for an app-owned control directory. Production omits this and keeps
   * the canonical ~/.junto/term contract; isolated app instances may supply
   * their own Electron-owned userData path.
   */
  readonly controlHome?: string;
}

export interface TermProductAutomationSuspension {
  /**
   * Drop Junto-owned attach/write/retry authority without signaling the PTY
   * process. Implementations must be monotonic and idempotent.
   */
  readonly suspend: () => void;
}

const TERM_PLANE_SHUTDOWN_DEADLINE_MS = 5_000;

const settledBefore = async <A>(
  promise: Promise<A>,
  deadline: number,
): Promise<PromiseSettledResult<A> | undefined> => {
  const remainingMs = Math.max(0, deadline - performance.now());
  if (remainingMs === 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): PromiseFulfilledResult<A> => ({ status: "fulfilled", value }),
        (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
      ),
      new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * App-scoped terminal plane:
 * - LocalSessionHost owns local PTYs
 * - Term control UDS exposes that host to remote CCs via SSH forward
 * - TerminalRouter routes IPC by hostId
 */
const productionLocalSessionHost = (): LocalSessionHost =>
  new LocalSessionHost(undefined, {
    externalMaintenanceFence: linuxReleaseFenceActive,
    primeDaemons: primeAgentDaemons,
  });

export interface TermPrimeAgentReporterPlane {
  readonly start: (options?: { readonly home?: string }) => Promise<void>;
  readonly beginShutdown: () => void;
  readonly shutdown: () => Promise<PrimeAgentReporterShutdownReceipt>;
}

export class TermPlane {
  readonly host: LocalSessionHost;
  readonly router: TerminalRouter;
  /** Single process-wide terminal delete fence — renderer IPC and overseer share this. */
  readonly nodeDelete: TerminalNodeDeleteService;
  private control: TermControlServer | undefined;
  private readonly reporter: TermPrimeAgentReporterPlane;
  private reporterStartupFailure: unknown;
  private controlStartupFailure: TermControlStartupError | undefined;
  private starting: Promise<void> | undefined;
  private productAutomationSuspension:
    | TermProductAutomationSuspension
    | undefined;
  private shuttingDown = false;
  private shutdownReason = "app_quit";
  private localShutdownFlight: Promise<LocalHostShutdownResult> | undefined;
  private drainFlight: Promise<TermPlaneShutdownReceipt> | undefined;

  constructor(
    host?: LocalSessionHost,
    reporter?: TermPrimeAgentReporterPlane,
  ) {
    const production = host === undefined;
    this.host = host ?? productionLocalSessionHost();
    // Explicit test hosts receive an isolated lifecycle by default. Production
    // must share the singleton used by primeAgentDaemons.
    this.reporter =
      reporter ??
      (production ? primeAgentReporterPlane : new PrimeAgentReporterPlane());
    this.router = new TerminalRouter(this.host);
    this.nodeDelete = new TerminalNodeDeleteService(this.router);
  }

  /**
   * Bind the exact process-local managed-drive/message-delivery authority.
   * A late bind after shutdown is suspended immediately, so
   * asynchronous IPC boot cannot reopen the terminal write path.
   */
  bindProductAutomationSuspension(
    suspension: TermProductAutomationSuspension,
  ): void {
    const existing = this.productAutomationSuspension;
    if (existing !== undefined && existing !== suspension) {
      throw new Error(
        "terminal product automation suspension is already bound",
      );
    }
    this.productAutomationSuspension = suspension;
    if (this.shuttingDown) {
      suspension.suspend();
    }
  }

  private suspendProductAutomation(): void {
    try {
      this.productAutomationSuspension?.suspend();
    } catch {
      // Router/control admission is still closed by the caller. A product
      // automation cleanup failure cannot reopen those stronger boundaries.
    }
  }

  private startLocalShutdown(reason: string): Promise<LocalHostShutdownResult> {
    if (this.localShutdownFlight !== undefined) return this.localShutdownFlight;
    const current = this.host.shutdownAll(reason);
    this.localShutdownFlight = current;
    // A false receipt is a bounded observation, not a terminal fact. Clear the
    // completed attempt so a later exact exit can converge on the next drain.
    void current.then(
      () => {
        if (this.localShutdownFlight === current) this.localShutdownFlight = undefined;
      },
      () => {
        if (this.localShutdownFlight === current) this.localShutdownFlight = undefined;
      },
    );
    return current;
  }

  /** Start local control socket (idempotent). */
  start = async (options?: TermPlaneStartOptions): Promise<void> => {
    if (this.shuttingDown) throw new Error("terminal plane is stopping");
    // Evaluator lives on the spawn host. Command Center IPC also starts it;
    // Remote has no renderer IPC, so the plane is the one start that both run.
    seatStateRuntime.start();
    if (this.controlStartupFailure !== undefined) throw this.controlStartupFailure;
    if (this.control) return;
    if (this.starting) return this.starting;
    let current!: Promise<void>;
    current = (async () => {
      try {
        // The daemon plane registers synchronously while a managed Prime
        // Agent seat opens. Its receiver must be bound and permission-hardened
        // before any control surface can admit such a create.
        try {
          await this.reporter.start({ home: options?.controlHome });
        } catch (error) {
          // Structured reporting is a Prime Agent prerequisite, not the
          // terminal plane itself. Retain the failure for quit diagnostics and
          // leave reporter registration closed; unrelated shells/harnesses and
          // the owner-local control server remain available.
          this.reporterStartupFailure = error;
          console.error("[term] Prime Agent reporter startup failed:", error);
        }
        const control = await startTermControlServer(this.host, {
          home: options?.controlHome,
        });
        this.control = control;
        if (this.shuttingDown) control.beginShutdown();
        console.info(`[term] control socket ${control.socketPath}`);
      } catch (error) {
        if (error instanceof TermControlStartupError) {
          // A post-bind failure may retain an uncloseable listener while a
          // foreign replacement occupies the canonical path. Keep that exact
          // authority in the aggregate plane instead of losing it with the
          // rejected start promise.
          this.control = error.control;
          this.controlStartupFailure = error;
          this.control.beginShutdown();
        }
        throw error;
      }
    })();
    this.starting = current;
    try {
      await current;
    } finally {
      if (this.starting === current) this.starting = undefined;
    }
  };

  /**
   * Monotonic admission cut for local sessions, remote dials, and UDS frames.
   * Local signaling starts only after the shared promise is published by the
   * host, so reentrant backend callbacks observe the same shutdown generation.
   */
  beginShutdown(reason = "app_quit"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownReason = reason;
    seatStateRuntime.stop();
    this.suspendProductAutomation();
    this.startLocalShutdown(reason);
    this.router.beginShutdown();
    this.control?.beginShutdown();
  }

  drainOnQuit(reason = "app_quit"): Promise<TermPlaneShutdownReceipt> {
    this.beginShutdown(reason);
    if (this.drainFlight !== undefined) return this.drainFlight;
    const current = (async (): Promise<TermPlaneShutdownReceipt> => {
      const deadline = performance.now() + TERM_PLANE_SHUTDOWN_DEADLINE_MS;
      const diagnostics: string[] = [];
      const retainedLabels = new Set<string>();
      if (this.reporterStartupFailure !== undefined) {
        retainedLabels.add("prime-agent-reporter-start");
        diagnostics.push(
          `prime-agent-reporter-start: ${this.reporterStartupFailure instanceof Error ? this.reporterStartupFailure.message : String(this.reporterStartupFailure)}`,
        );
      }

      const localFlight = this.startLocalShutdown(this.shutdownReason);
      const routerFlight = this.router.drainOnQuit();
      // A start admitted before the cut may publish a control server in its
      // continuation. Retain that exact promise before taking the control
      // component snapshot.
      const startFlight = this.starting;
      if (startFlight !== undefined) {
        const startOutcome = await settledBefore(startFlight, deadline);
        if (startOutcome === undefined) {
          retainedLabels.add("control-start");
        } else if (startOutcome.status === "rejected") {
          diagnostics.push(
            `control-start: ${startOutcome.reason instanceof Error ? startOutcome.reason.message : String(startOutcome.reason)}`,
          );
        }
      }

      // Prime Agent daemon/session cleanup is part of LocalSessionHost drain.
      // Keep the reporter accepting release/state packets until that exact
      // cleanup settles. Construct this flight only after a concurrently
      // admitted start has settled, so a late listener cannot appear behind an
      // already-clean shutdown receipt.
      const reporterFlight = localFlight.then(
        () => {
          this.reporter.beginShutdown();
          return this.reporter.shutdown();
        },
        () => {
          this.reporter.beginShutdown();
          return this.reporter.shutdown();
        },
      );

      this.control?.beginShutdown();
      const controlFlight = this.control?.drainOnQuit();
      const [
        localOutcome,
        routerOutcome,
        controlOutcome,
        reporterOutcome,
      ] = await Promise.all([
        settledBefore(localFlight, deadline),
        settledBefore(routerFlight, deadline),
        controlFlight === undefined
          ? Promise.resolve(undefined)
          : settledBefore(controlFlight, deadline),
        settledBefore(reporterFlight, deadline),
      ]);

      let local: LocalHostShutdownResult | undefined;
      if (localOutcome === undefined) {
        retainedLabels.add("local-sessions");
      } else if (localOutcome.status === "rejected") {
        diagnostics.push(
          `local: ${localOutcome.reason instanceof Error ? localOutcome.reason.message : String(localOutcome.reason)}`,
        );
      } else {
        local = localOutcome.value;
        if (!local.clean) {
          for (const straggler of local.stragglers) {
            if (straggler.ownedPtyOutstanding === true) {
              retainedLabels.add("local-sessions");
            }
            if (straggler.primeDaemon !== undefined) {
              retainedLabels.add("prime-agent-daemon");
              const daemon = straggler.primeDaemon;
              diagnostics.push(
                `prime-agent-daemon: ${straggler.bindingId}@${straggler.epoch} ${daemon.state}${daemon.daemonPid === undefined ? "" : ` pid=${daemon.daemonPid}`}${daemon.message === undefined ? "" : `, ${daemon.message}`}`,
              );
            }
          }
        }
      }

      let router: TerminalRouterShutdownReceipt | undefined;
      if (routerOutcome === undefined) {
        retainedLabels.add("remote-router");
      } else if (routerOutcome.status === "rejected") {
        diagnostics.push(
          `router: ${routerOutcome.reason instanceof Error ? routerOutcome.reason.message : String(routerOutcome.reason)}`,
        );
      } else {
        router = routerOutcome.value;
        if (!router.clean) {
          retainedLabels.add("remote-router");
          diagnostics.push(...router.diagnostics.map((item) => `router: ${item}`));
        }
      }

      let control: TermControlServerShutdownReceipt | undefined;
      if (controlFlight !== undefined) {
        if (controlOutcome === undefined) {
          retainedLabels.add("control-server");
        } else if (controlOutcome.status === "rejected") {
          diagnostics.push(
            `control: ${controlOutcome.reason instanceof Error ? controlOutcome.reason.message : String(controlOutcome.reason)}`,
          );
        } else {
          control = controlOutcome.value;
          if (!control.clean) {
            retainedLabels.add("control-server");
            if (control.retainedLabels.length > 0) {
              diagnostics.push(`control-retained: ${control.retainedLabels.join(", ")}`);
            }
            diagnostics.push(...control.diagnostics.map((item) => `control: ${item}`));
          }
        }
      }

      let reporter: PrimeAgentReporterShutdownReceipt | undefined;
      if (reporterOutcome === undefined) {
        retainedLabels.add("prime-agent-reporter");
        diagnostics.push("prime-agent-reporter: shutdown timed out");
      } else if (reporterOutcome.status === "rejected") {
        retainedLabels.add("prime-agent-reporter");
        diagnostics.push(
          `prime-agent-reporter: ${reporterOutcome.reason instanceof Error ? reporterOutcome.reason.message : String(reporterOutcome.reason)}`,
        );
      } else {
        reporter = reporterOutcome.value;
        if (!reporter.clean) {
          retainedLabels.add("prime-agent-reporter");
        }
        if (reporter.retainedLabels.length > 0) {
          diagnostics.push(
            `prime-agent-reporter-retained: ${reporter.retainedLabels.join(", ")}`,
          );
        }
        diagnostics.push(
          ...reporter.diagnostics.map(
            (item) => `prime-agent-reporter: ${item}`,
          ),
        );
      }

      const clean =
        retainedLabels.size === 0 &&
        diagnostics.length === 0 &&
        local?.clean === true &&
        router?.clean === true &&
        (controlFlight === undefined || control?.clean === true) &&
        reporter?.clean === true;
      return Object.freeze({
        clean,
        ...(local === undefined ? {} : { local }),
        ...(router === undefined ? {} : { router }),
        ...(control === undefined ? {} : { control }),
        ...(reporter === undefined ? {} : { reporter }),
        retainedLabels: Object.freeze([...retainedLabels].sort()),
        diagnostics: Object.freeze(diagnostics),
      });
    })();
    this.drainFlight = current;
    void current.then(
      () => {
        if (this.drainFlight === current) this.drainFlight = undefined;
      },
      () => {
        if (this.drainFlight === current) this.drainFlight = undefined;
      },
    );
    return current;
  }

  stop = async (): Promise<void> => {
    const receipt = await this.drainOnQuit("term_plane_stop");
    if (!receipt.clean) {
      throw new Error(
        `terminal plane shutdown retained: ${receipt.retainedLabels.join(", ") || receipt.diagnostics.join(", ") || "unknown resource"}`,
      );
    }
    this.control = undefined;
  };

  runningCount(): number {
    return this.router.runningCount();
  }
}

export const termPlane = new TermPlane();
