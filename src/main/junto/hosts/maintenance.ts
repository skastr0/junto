/**
 * Remote terminal maintenance for the live update path.
 *
 * An update of an incumbent Remote must not mutate the installed generation
 * while its terminal plane carries active sessions. Before any incumbent
 * mutation, reconcile acquires — inside one Scope so release happens on every
 * outcome (success, refusal, failure):
 *
 *   1. the Command Center route cut (`term/router.acquireRemoteHostMaintenance`):
 *      proves zero active sessions and retires this Command Center's routes
 *      and forwards to the host, and
 *   2. a direct socket-bound maintenance lease on the Remote's term control
 *      server, held open across the whole apply. While held, the Remote
 *      refuses new terminal sessions, fencing the incumbent generation. On
 *      Linux targets the staged root release fence is acknowledged through
 *      the lease (`maintenance.fence`); macOS has no root release fence, so
 *      the held lease itself is the generation fence.
 *
 * Refusal with active sessions surfaces the fixed
 * "close-active-junto-terminals" recovery action and leaves the incumbent
 * untouched. First installs have no incumbent and never touch this module.
 */
import { join } from "node:path";
import { Context, Effect, type Scope } from "effect";
import type { HostWorkAttach } from "@shared/host-runtime";
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "@shared/remote-update-status";
import type { RemoteHost } from "@shared/remote-hosts";
import {
  TERM_REMOTE_SOCK_REL,
  termControlTokenPath,
} from "@shared/term-control";
import { parseRemoteUnixSocketPath, type SshTarget } from "../ssh/domain";
import { unixForward } from "../ssh/program";
import type { SshTransportShape } from "../ssh/service";
import { TermControlClient } from "../term/control-client";
import { homeDirectoryLookup } from "../ssh/program";
import {
  failedBeforeMutation,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import { readRemoteTextFile } from "./host-runtime-platform";
import { decodeRemoteHomeDirectoryOutput } from "./remote-home";

export type HostMaintenanceRefusalReason =
  | "active-terminal-sessions"
  | "maintenance-held"
  | "shutting-down"
  | "unavailable";

export type HostMaintenanceRefusal = {
  readonly acquired: false;
  readonly reason: HostMaintenanceRefusalReason;
  readonly detail: string;
  /** Present only for active-terminal-sessions refusals. */
  readonly activeTerminalSessions?: number;
};

export type HostMaintenanceHold = {
  readonly acquired: true;
  /** Receipts to surface on the deploy job (route cut, fence). */
  readonly stages: readonly string[];
};

export type HostMaintenanceAdmission =
  | HostMaintenanceHold
  | HostMaintenanceRefusal;

export type HostMaintenanceAcquireInput = {
  readonly host: RemoteHost;
  readonly sshTarget: SshTarget;
  /** Observed Remote work-attach plane; "up" means a live terminal plane. */
  readonly workAttach: HostWorkAttach;
  readonly platform: "darwin" | "linux";
};

/**
 * Update-of-incumbent maintenance authority. Acquire is Scoped: everything it
 * holds (route cut, remote lease, SSH forward) releases when the Scope closes,
 * on every outcome.
 */
export class HostMaintenanceAuthority extends Context.Service<
  HostMaintenanceAuthority,
  {
    readonly acquire: (
      input: HostMaintenanceAcquireInput,
    ) => Effect.Effect<HostMaintenanceAdmission, never, Scope.Scope>;
  }
>()("@junto/HostMaintenanceAuthority") {}

const describeMaintenanceFailure = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "terminal route maintenance failed";

const unavailable = (detail: string): HostMaintenanceRefusal => ({
  acquired: false,
  reason: "unavailable",
  detail,
});

const ROUTER_REASONS = {
  active_sessions: "active-terminal-sessions",
  maintenance_held: "maintenance-held",
  shutting_down: "shutting-down",
} as const;

const MAINTENANCE_CONNECT_TIMEOUT_MS = 10_000;

/** Live authority: CC route cut, then a held remote lease + fence. */
export const makeLiveHostMaintenanceAuthority = (
  ssh: SshTransportShape,
): Context.Service.Shape<typeof HostMaintenanceAuthority> => ({
  acquire: (input) =>
    Effect.gen(function* () {
      const { host, sshTarget } = input;
      if (input.workAttach === "down") {
        return {
          acquired: true,
          stages: [
            "Junto is not answering on this machine — no live terminal to pause",
          ],
        } satisfies HostMaintenanceHold;
      }
      if (input.workAttach === "unknown") {
        return unavailable(
          `${host.label}: could not determine whether the Remote terminal plane is live`,
        );
      }

      // 1. Command Center route cut: zero-session proof + route retirement.
      const cut = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const { termPlane } = await import("../term/plane");
            return await termPlane.router.acquireRemoteHostMaintenance(
              host.id,
            );
          },
          catch: (error) => new Error(describeMaintenanceFailure(error)),
        }),
        (admission) =>
          admission.acquired
            ? Effect.sync(() => {
                admission.lease.release();
              })
            : Effect.void,
      ).pipe(Effect.result);
      if (cut._tag === "Failure") {
        return unavailable(
          `${host.label}: could not acquire Remote terminal maintenance — ${cut.failure.message}`,
        );
      }
      if (!cut.success.acquired) {
        const refusal = cut.success;
        return {
          acquired: false,
          reason: ROUTER_REASONS[refusal.reason],
          detail: `${host.label}: Remote terminal maintenance refused (${ROUTER_REASONS[refusal.reason]})`,
          ...(refusal.reason === "active_sessions"
            ? {
                activeTerminalSessions:
                  refusal.evidence.activeTerminalSessions,
              }
            : {}),
        } satisfies HostMaintenanceRefusal;
      }
      // Stage copy is operator-facing: it renders verbatim as the Fleet
      // deploy progress detail and step log. Plain product English only —
      // internal receipts such as observation ids never surface here.
      const stages: string[] = [
        "Paused new terminal sessions for this update",
      ];

      // 2. Direct socket-bound lease on the Remote term control server. The
      // route cut above retired its own dial, so this lease is what stays
      // held across the incumbent mutation.
      const homeResult = yield* ssh
        .run(homeDirectoryLookup(sshTarget))
        .pipe(Effect.result);
      if (homeResult._tag === "Failure") {
        return unavailable(
          `${host.label}: Remote home lookup failed before terminal maintenance`,
        );
      }
      const home = decodeRemoteHomeDirectoryOutput(homeResult.success.stdout);
      if (home === null) {
        return unavailable(
          `${host.label}: Remote home is not a canonical absolute path`,
        );
      }
      const token = yield* readRemoteTextFile(
        ssh,
        sshTarget,
        termControlTokenPath(home),
      );
      if (token._tag !== "present") {
        return unavailable(
          `${host.label}: Remote terminal control token is unavailable`,
        );
      }
      const sockPath = yield* parseRemoteUnixSocketPath(
        join(home, TERM_REMOTE_SOCK_REL),
      ).pipe(Effect.result);
      if (sockPath._tag === "Failure") {
        return unavailable(
          `${host.label}: Remote terminal control socket path is invalid`,
        );
      }
      const forward = yield* ssh
        .forward(unixForward(sshTarget, sockPath.success))
        .pipe(Effect.result);
      if (forward._tag === "Failure") {
        return unavailable(
          `${host.label}: Remote terminal control forward failed`,
        );
      }
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            TermControlClient.connect({
              socketPath: String(forward.success.localSocket),
              token: token.text,
              timeoutMs: MAINTENANCE_CONNECT_TIMEOUT_MS,
            }),
          catch: (error) => new Error(describeMaintenanceFailure(error)),
        }),
        (connected) => Effect.sync(() => connected.close()),
      ).pipe(Effect.result);
      if (client._tag === "Failure") {
        return unavailable(
          `${host.label}: could not connect to the Remote terminal control plane — ${client.failure.message}`,
        );
      }
      const acquired = yield* Effect.tryPromise({
        try: () => client.success.acquireMaintenance(),
        catch: (error) => new Error(describeMaintenanceFailure(error)),
      }).pipe(Effect.result);
      if (acquired._tag === "Failure") {
        return unavailable(
          `${host.label}: could not acquire the Remote terminal maintenance lease — ${acquired.failure.message}`,
        );
      }
      if (!acquired.success.acquired) {
        const refusal = acquired.success;
        return {
          acquired: false,
          reason: ROUTER_REASONS[refusal.reason],
          detail: `${host.label}: Remote terminal maintenance refused (${ROUTER_REASONS[refusal.reason]})`,
          ...(refusal.reason === "active_sessions"
            ? {
                activeTerminalSessions:
                  refusal.evidence.activeTerminalSessions,
              }
            : {}),
        } satisfies HostMaintenanceRefusal;
      }
      const lease = acquired.success.lease;
      // Release on every outcome. A failed wire release closes the client
      // socket, and the server's socket-bound cleanup frees the lease.
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => lease.release(),
          catch: (error) => new Error(describeMaintenanceFailure(error)),
        }).pipe(Effect.catch(() => Effect.void)),
      );
      stages.push(
        "Holding terminal sessions closed while Junto updates",
      );

      // 3. Fence the incumbent generation.
      if (input.platform === "linux") {
        const fence = yield* Effect.tryPromise({
          try: () => lease.acknowledgeFence(),
          catch: (error) => new Error(describeMaintenanceFailure(error)),
        }).pipe(Effect.result);
        if (fence._tag === "Failure") {
          return unavailable(
            `${host.label}: the incumbent generation release fence was not acknowledged — ${fence.failure.message}`,
          );
        }
        stages.push("Locked the installed Junto for replacement");
      } else {
        // macOS has no root release fence; the held socket-bound lease keeps
        // the Remote's create admission closed for the whole mutation.
        stages.push("Locked the installed Junto for replacement");
      }

      return { acquired: true, stages } satisfies HostMaintenanceHold;
    }),
});

/** Map a maintenance refusal onto the typed deploy result. Incumbent untouched. */
export const maintenanceRefusedDeployResult = (
  host: RemoteHost,
  refusal: HostMaintenanceRefusal,
): ConfiguredRemoteDeployResult => {
  if (refusal.reason === "active-terminal-sessions") {
    const sessions = refusal.activeTerminalSessions ?? 1;
    const detail =
      `${host.label}: package activation deferred — ` +
      `${sessions} Junto terminal session(s) active. ` +
      REMOTE_UPDATE_IDLE_PRODUCT_COPY;
    return {
      ...failedBeforeMutation(host, detail, {
        code: "conflict",
        recoveryAction: {
          kind: "close-active-junto-terminals",
          activeTerminalSessions: sessions,
        },
      }),
      message: REMOTE_UPDATE_IDLE_PRODUCT_COPY,
    };
  }
  const detail =
    refusal.reason === "maintenance-held"
      ? `${host.label}: another update is already holding this machine's terminals`
      : refusal.reason === "shutting-down"
        ? `${host.label}: Junto on this machine is shutting down`
        : refusal.detail;
  return failedBeforeMutation(host, detail, { code: "conflict" });
};

/**
 * Bracket an incumbent mutation with the maintenance authority. Refusal
 * returns the typed result without running `apply`; a hold keeps the lease
 * for the entire `apply` and releases it on every outcome.
 */
export const withIncumbentMaintenance = (
  authority: Context.Service.Shape<typeof HostMaintenanceAuthority>,
  input: HostMaintenanceAcquireInput,
  onStage: (stage: string) => void,
  apply: Effect.Effect<ConfiguredRemoteDeployResult>,
): Effect.Effect<ConfiguredRemoteDeployResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      const admission = yield* authority.acquire(input);
      if (!admission.acquired) {
        return maintenanceRefusedDeployResult(input.host, admission);
      }
      for (const stage of admission.stages) onStage(stage);
      return yield* apply;
    }),
  );
