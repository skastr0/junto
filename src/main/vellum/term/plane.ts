import { LocalSessionHost } from "./local-host";
import { linuxReleaseFenceActive } from "./release-fence";
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

export interface TermPlaneShutdownReceipt {
  readonly clean: boolean;
  readonly local?: LocalHostShutdownResult;
  readonly router?: TerminalRouterShutdownReceipt;
  readonly control?: TermControlServerShutdownReceipt;
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
  (receipt.local !== undefined && !receipt.local.clean);

export interface TermPlaneStartOptions {
  /**
   * Root for an app-owned control directory. Production omits this and keeps
   * the canonical ~/.vellum/term contract; isolated app instances may supply
   * their own Electron-owned userData path.
   */
  readonly controlHome?: string;
}

export interface TermProductAutomationSuspension {
  /**
   * Drop Vellum-owned attach/write/retry authority without signaling the PTY
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
  });

export class TermPlane {
  readonly host: LocalSessionHost;
  readonly router: TerminalRouter;
  private control: TermControlServer | undefined;
  private controlStartupFailure: TermControlStartupError | undefined;
  private starting: Promise<void> | undefined;
  private productAutomationSuspension:
    | TermProductAutomationSuspension
    | undefined;
  private licenseRevoked = false;
  private shuttingDown = false;
  private shutdownReason = "app_quit";
  private localShutdownFlight: Promise<LocalHostShutdownResult> | undefined;
  private drainFlight: Promise<TermPlaneShutdownReceipt> | undefined;

  constructor(host = productionLocalSessionHost()) {
    this.host = host;
    this.router = new TerminalRouter(host);
  }

  /**
   * Bind the exact process-local managed-drive/message-delivery authority.
   * A late bind after revocation or shutdown is suspended immediately, so
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
    if (this.licenseRevoked || this.shuttingDown) {
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
    if (this.licenseRevoked) {
      throw new Error("terminal plane admission closed after license revocation");
    }
    if (this.controlStartupFailure !== undefined) throw this.controlStartupFailure;
    if (this.control) return;
    if (this.starting) return this.starting;
    let current!: Promise<void>;
    current = (async () => {
      try {
        const control = await startTermControlServer(this.host, {
          home: options?.controlHome,
        });
        this.control = control;
        if (this.shuttingDown || this.licenseRevoked) control.beginShutdown();
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
   * Monotonic product-admission cut for license revocation.
   *
   * Existing local PTYs remain operator-owned and running. Only the terminal
   * router and control socket stop admitting future product work. Normal app
   * quit remains responsible for signaling and draining those owned PTYs.
   */
  suspendForLicenseRevocation(): void {
    if (this.licenseRevoked) return;
    this.licenseRevoked = true;
    this.suspendProductAutomation();
    this.router.beginShutdown();
    this.control?.beginShutdown();
  }

  /**
   * Monotonic admission cut for local sessions, remote dials, and UDS frames.
   * Local signaling starts only after the shared promise is published by the
   * host, so reentrant backend callbacks observe the same shutdown generation.
   */
  beginShutdown(reason = "app_quit"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownReason = reason;
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

      this.control?.beginShutdown();
      const controlFlight = this.control?.drainOnQuit();
      const [localOutcome, routerOutcome, controlOutcome] = await Promise.all([
        settledBefore(localFlight, deadline),
        settledBefore(routerFlight, deadline),
        controlFlight === undefined
          ? Promise.resolve(undefined)
          : settledBefore(controlFlight, deadline),
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
        if (!local.clean) retainedLabels.add("local-sessions");
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

      const clean =
        retainedLabels.size === 0 &&
        diagnostics.length === 0 &&
        local?.clean === true &&
        router?.clean === true &&
        (controlFlight === undefined || control?.clean === true);
      return Object.freeze({
        clean,
        ...(local === undefined ? {} : { local }),
        ...(router === undefined ? {} : { router }),
        ...(control === undefined ? {} : { control }),
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
