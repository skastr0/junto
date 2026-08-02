import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Layer,
  Runtime,
  Scope,
  Stream,
} from "effect";
import type { CliResult } from "../adapters/exec";
import { resolvedSpawnEnvSync } from "../adapters/exec";
import {
  appProcessPlane,
  type AppChildIo,
} from "../app-process-plane";
import { isDemoMode } from "../demo/mode";
import { scriptedTransportFor } from "../demo/service";
import {
  makeScopedPromiseRunner,
  type SshLease,
} from "../ssh";
import {
  isKnownHerdrHost,
  listHerdrHosts,
  type HerdrHostId,
} from "./hosts";
import { LocalMirrorTransport, RemoteMirrorTransport } from "./mirror-transport";
import { HerdrMirrorRegistry, type HerdrHostRevocationHooks } from "./mirrors";
import { HerdrObservePool } from "./observe-pool";
import { HerdrService, type HerdrRunner, type HerdrServerStarter } from "./service";
import type { HerdrServerRoute } from "./route";
import { HerdrServiceMap, type HostShellRunner } from "./service-map";
import {
  HerdrStreamManager,
  type HerdrClientIo,
  type HerdrSpawnFn,
  type RemoteScopeCloseReceipt,
} from "./stream";
import { makeTerminalSessions, TerminalSessions } from "../term/sessions";
import { HerdrTransport } from "./transport";
import { parseCliEnvelope, parseProcessInfo } from "./parse";
import { findHostById } from "../hosts/snapshot";
import { HostServeCatalog } from "../hosts/serve-catalog";
import { tailscalePeerCache } from "../hosts/tailscale-peers";
import { parseHostSshRoute, parseSshEndpoint } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import { remoteHostProbe } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import { runCli } from "../adapters/exec";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  herdrShutdownMessage,
  type HerdrComponentShutdownReceipt,
  type HerdrShutdownCause,
} from "./shutdown";

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** Herdr servers are explicitly independent daemons, never app-owned children. */
export type HerdrServerLifetime = "daemon-outlives-app";

const HERDR_SERVER_LIFETIME: HerdrServerLifetime = "daemon-outlives-app";

export interface HerdrDaemonShutdownReceipt {
  readonly clean: true;
  readonly retained: 0;
  readonly excluded: true;
  readonly lifetime: HerdrServerLifetime;
  readonly reason: "independent-daemon-never-app-owned";
}

export interface HerdrShutdownReceipt {
  readonly clean: boolean;
  readonly retained: number;
  readonly causes: ReadonlyArray<HerdrShutdownCause & { readonly component: string }>;
  readonly components: Readonly<Record<string, HerdrComponentShutdownReceipt>>;
  readonly server: HerdrDaemonShutdownReceipt;
}

interface HerdrShutdownPart {
  readonly beginShutdown: () => unknown;
  readonly drainOnQuit: () => Promise<HerdrComponentShutdownReceipt>;
}

export interface HerdrShutdownController {
  readonly beginShutdown: () => void;
  readonly drainOnQuit: () => Promise<HerdrShutdownReceipt>;
  readonly isQuiescing: () => boolean;
}

/**
 * One monotonic Herdr quit boundary. Every component is cut synchronously;
 * drains then start together and are aggregated without erasing a rejection.
 */
export const createHerdrShutdownController = (
  parts: Readonly<Record<string, HerdrShutdownPart>>,
): HerdrShutdownController => {
  let quiescing = false;
  const beginFailures = new Map<string, HerdrShutdownCause[]>();
  let drainFlight: Promise<HerdrShutdownReceipt> | undefined;
  let cleanReceipt: HerdrShutdownReceipt | undefined;

  const beginShutdown = (): void => {
    if (quiescing) return;
    quiescing = true;
    for (const [name, part] of Object.entries(parts)) {
      try {
        part.beginShutdown();
      } catch (error) {
        beginFailures.set(name, [{
          code: "admission-cut-failed",
          message: herdrShutdownMessage(error),
        }]);
      }
    }
  };

  const drainOnQuit = (): Promise<HerdrShutdownReceipt> => {
    beginShutdown();
    if (cleanReceipt) return Promise.resolve(cleanReceipt);
    if (drainFlight) return drainFlight;
    let resolveFlight!: (receipt: HerdrShutdownReceipt) => void;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<HerdrShutdownReceipt>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // Publish identity before invoking any component callback. A component
    // may synchronously re-enter the aggregate while starting its own drain.
    drainFlight = flight;
    void (async (): Promise<HerdrShutdownReceipt> => {
      const names = Object.keys(parts);
      const started = names.map((name) => {
        try {
          const componentFlight = parts[name]!.drainOnQuit();
          if (componentFlight === flight) {
            return Promise.reject(
              new Error(`Herdr component ${name} returned the aggregate drain promise`),
            );
          }
          return Promise.resolve(componentFlight);
        } catch (error) {
          return Promise.reject(error);
        }
      });
      const settled = await Promise.allSettled(started);
      const components: Record<string, HerdrComponentShutdownReceipt> = {};
      const causes: Array<HerdrShutdownCause & { readonly component: string }> = [];
      let retained = 0;
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index]!;
        const result = settled[index]!;
        const beginCauses = beginFailures.get(name) ?? [];
        const receipt = result.status === "fulfilled"
          ? result.success
          : herdrComponentReceipt(1, [{
              code: "component-drain-failed",
              message: herdrShutdownMessage(result.reason),
            }]);
        const combined = beginCauses.length === 0
          ? receipt
          : herdrComponentReceipt(receipt.retained, [...beginCauses, ...receipt.causes]);
        components[name] = combined;
        retained += combined.retained;
        causes.push(...combined.causes.map((cause) => ({ ...cause, component: name })));
      }
      const server: HerdrDaemonShutdownReceipt = Object.freeze({
        clean: true,
        retained: 0,
        excluded: true,
        lifetime: HERDR_SERVER_LIFETIME,
        reason: "independent-daemon-never-app-owned",
      });
      const receipt: HerdrShutdownReceipt = Object.freeze({
        clean: retained === 0 && causes.length === 0,
        retained,
        causes: Object.freeze(causes),
        components: Object.freeze(components),
        server,
      });
      if (receipt.clean) cleanReceipt = receipt;
      return receipt;
    })().then(resolveFlight, rejectFlight);
    void flight.then(() => {
      if (drainFlight === flight) drainFlight = undefined;
    }, () => {
      if (drainFlight === flight) drainFlight = undefined;
    });
    return flight;
  };

  return Object.freeze({
    beginShutdown,
    drainOnQuit,
    isQuiescing: () => quiescing,
  });
};

const REMOTE_SCOPE_CLOSE_TIMEOUT_MS = 1_500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A remote stream owns an Effect scope, not an operating-system pid. Its
 * closer is idempotent and always produces an honest bounded receipt, even
 * if an SSH finalizer defects or never settles.
 */
export const makeBoundedRemoteClose = (
  closeScope: () => Promise<void>,
  timeoutMs = REMOTE_SCOPE_CLOSE_TIMEOUT_MS,
): (() => Promise<RemoteScopeCloseReceipt>) => {
  let completion: Promise<RemoteScopeCloseReceipt> | undefined;
  let terminalReceipt: RemoteScopeCloseReceipt | undefined;
  let boundedFlight: Promise<RemoteScopeCloseReceipt> | undefined;

  const start = (): Promise<RemoteScopeCloseReceipt> => {
    if (completion) return completion;
    try {
      completion = Promise.resolve(closeScope()).then(
        (): RemoteScopeCloseReceipt => {
          terminalReceipt = { status: "closed" };
          return terminalReceipt;
        },
        (error): RemoteScopeCloseReceipt => {
          terminalReceipt = { status: "failed", message: errorMessage(error) };
          return terminalReceipt;
        },
      );
    } catch (error) {
      terminalReceipt = { status: "failed", message: errorMessage(error) };
      completion = Promise.resolve(terminalReceipt);
    }
    return completion;
  };

  return () => {
    if (terminalReceipt) return Promise.resolve(terminalReceipt);
    if (boundedFlight) return boundedFlight;
    const closeCompletion = start();
    if (terminalReceipt) return Promise.resolve(terminalReceipt);
    const flight = new Promise<RemoteScopeCloseReceipt>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (receipt: RemoteScopeCloseReceipt): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(receipt);
      };
      timer = setTimeout(
        () => settle({ status: "timed-out", timeoutMs }),
        timeoutMs,
      );
      (timer as unknown as { unref?: () => void }).unref?.();
      void closeCompletion.then(settle);
    });
    boundedFlight = flight;
    void flight.then(() => {
      if (boundedFlight === flight) boundedFlight = undefined;
    });
    return boundedFlight;
  };
};

interface TrackedHerdrRemoteScope {
  readonly close: () => Promise<RemoteScopeCloseReceipt>;
  closeFlight?: Promise<RemoteScopeCloseReceipt>;
  receipt?: RemoteScopeCloseReceipt;
}

export interface HerdrRemoteScopeShutdownTracker extends HerdrShutdownPart {
  readonly isQuiescing: () => boolean;
  readonly trackOperation: <A>(operation: Promise<A>) => Promise<A>;
  readonly registerScope: (
    close: () => Promise<RemoteScopeCloseReceipt>,
  ) => () => Promise<void>;
}

export interface HerdrOperationShutdownTracker extends HerdrShutdownPart {
  readonly isQuiescing: () => boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
}

/** Track background Herdr work that is launched outside the layer scope. */
export const createHerdrOperationShutdownTracker = (
  code: string,
  timeoutMs = 2_000,
): HerdrOperationShutdownTracker => {
  let quiescing = false;
  const operations = new Set<Promise<void>>();
  const failures: HerdrShutdownCause[] = [];
  let drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  let cleanReceipt: HerdrComponentShutdownReceipt | undefined;

  const beginShutdown = (): void => {
    quiescing = true;
  };

  const run = (operation: () => Promise<void>): Promise<void> => {
    if (quiescing) return Promise.resolve();
    let flight: Promise<void>;
    try {
      flight = Promise.resolve(operation());
    } catch (error) {
      flight = Promise.reject(error);
    }
    operations.add(flight);
    void flight.then(
      () => operations.delete(flight),
      (error) => {
        operations.delete(flight);
        if (quiescing) {
          failures.push({ code: `${code}-failed`, message: herdrShutdownMessage(error) });
        }
      },
    );
    return flight;
  };

  const drainOnQuit = (): Promise<HerdrComponentShutdownReceipt> => {
    beginShutdown();
    if (cleanReceipt) return Promise.resolve(cleanReceipt);
    if (drainFlight) return drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      const settled = await awaitHerdrPromiseFixedPoint(
        () => [...operations],
        timeoutMs,
      );
      const causes = [...failures];
      if (!settled || operations.size > 0) {
        causes.push({
          code: `${code}-retained`,
          message: `${operations.size} ${code} operation(s) did not settle before shutdown timeout`,
        });
      }
      const receipt = operations.size === 0 && causes.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(operations.size, causes);
      if (receipt.clean) cleanReceipt = receipt;
      return receipt;
    })();
    drainFlight = flight;
    void flight.then(() => {
      if (drainFlight === flight) drainFlight = undefined;
    }, () => {
      if (drainFlight === flight) drainFlight = undefined;
    });
    return flight;
  };

  return Object.freeze({
    beginShutdown,
    drainOnQuit,
    isQuiescing: () => quiescing,
    run,
  });
};

/**
 * Shutdown accounting for Effect scopes that back Herdr mirror forwards.
 * A failed or timed-out close remains a retained scope, while a later proven
 * close removes that exact scope and allows a retry to converge cleanly.
 */
export const createHerdrRemoteScopeShutdownTracker = (
  timeoutMs = 2_000,
): HerdrRemoteScopeShutdownTracker => {
  let quiescing = false;
  const operations = new Set<Promise<unknown>>();
  const scopes = new Set<TrackedHerdrRemoteScope>();
  let drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  let cleanReceipt: HerdrComponentShutdownReceipt | undefined;

  const trackOperation = <A>(operation: Promise<A>): Promise<A> => {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };

  const requestClose = (
    scope: TrackedHerdrRemoteScope,
  ): Promise<RemoteScopeCloseReceipt> => {
    if (scope.closeFlight) return scope.closeFlight;
    let closeFlight: Promise<RemoteScopeCloseReceipt>;
    try {
      closeFlight = Promise.resolve(scope.close()).catch(
        (error): RemoteScopeCloseReceipt => ({
          status: "failed",
          message: herdrShutdownMessage(error),
        }),
      );
    } catch (error) {
      closeFlight = Promise.resolve({
        status: "failed",
        message: herdrShutdownMessage(error),
      });
    }
    scope.closeFlight = trackOperation(closeFlight);
    void scope.closeFlight.then((receipt) => {
      scope.receipt = receipt;
      if (receipt.status === "closed") scopes.delete(scope);
      if (scope.closeFlight === closeFlight) scope.closeFlight = undefined;
    });
    return scope.closeFlight;
  };

  const startScopeCloses = (): void => {
    for (const scope of scopes) void requestClose(scope);
  };

  const beginShutdown = (): void => {
    quiescing = true;
    startScopeCloses();
  };

  const registerScope = (
    close: () => Promise<RemoteScopeCloseReceipt>,
  ): (() => Promise<void>) => {
    const scope: TrackedHerdrRemoteScope = { close };
    scopes.add(scope);
    const closeRegisteredScope = (): Promise<void> =>
      requestClose(scope).then(() => undefined);
    if (quiescing) void closeRegisteredScope();
    return closeRegisteredScope;
  };

  const drainOnQuit = (): Promise<HerdrComponentShutdownReceipt> => {
    beginShutdown();
    if (cleanReceipt) return Promise.resolve(cleanReceipt);
    if (drainFlight) return drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      startScopeCloses();
      const settled = await awaitHerdrPromiseFixedPoint(
        () => [...operations],
        timeoutMs,
      );
      const causes: HerdrShutdownCause[] = [];
      for (const scope of scopes) {
        if (scope.receipt?.status === "failed") {
          causes.push({
            code: "mirror-forward-close-failed",
            message: scope.receipt.message,
          });
        } else if (scope.receipt?.status === "timed-out") {
          causes.push({
            code: "mirror-forward-close-timed-out",
            message: `mirror forward scope did not close within ${scope.receipt.timeoutMs}ms`,
          });
        } else {
          causes.push({
            code: "mirror-forward-close-retained",
            message: "mirror forward scope has no terminal close receipt",
          });
        }
      }
      if (!settled || operations.size > 0) {
        causes.push({
          code: "mirror-forward-operation-retained",
          message: `${operations.size} mirror forward operation(s) did not settle before shutdown timeout`,
        });
      }
      const retained = scopes.size + operations.size;
      const receipt = retained === 0 && causes.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(retained, causes);
      if (receipt.clean) cleanReceipt = receipt;
      return receipt;
    })();
    drainFlight = flight;
    void flight.then(() => {
      if (drainFlight === flight) drainFlight = undefined;
    }, () => {
      if (drainFlight === flight) drainFlight = undefined;
    });
    return flight;
  };

  return Object.freeze({
    beginShutdown,
    drainOnQuit,
    isQuiescing: () => quiescing,
    trackOperation,
    registerScope,
  });
};

const herdrArgs = (
  args: ReadonlyArray<string>,
  session?: string | null,
): ReadonlyArray<string> => session ? ["--session", session, ...args] : args;

const asHostId = (hostId: string): HerdrHostId | undefined =>
  isKnownHerdrHost(hostId) ? hostId as HerdrHostId : undefined;

const serverRunning = (result: CliResult): boolean => {
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      readonly server?: { readonly running?: boolean; readonly status?: string };
    };
    return parsed.server?.running === true || parsed.server?.status === "running";
  } catch {
    return false;
  }
};

/**
 * OS spawn/handoff is necessary but never sufficient for server readiness.
 * Only Herdr's bounded status protocol probe can prove the daemon is usable.
 */
export const proveHerdrProtocolReadyAfterOsHandoff = async (
  osHandoff: Promise<unknown>,
  protocolProbe: () => Promise<boolean>,
): Promise<boolean> => {
  await osHandoff;
  return protocolProbe();
};

/**
 * Narrow the central process plane's stream-only I/O facade to the Herdr
 * protocol client. Close remains replayable through AppChildIo, so a very
 * short-lived child cannot exit between spawn and listener attachment.
 */
class AppProcessHerdrClient implements HerdrClientIo {
  readonly stdin: HerdrClientIo["stdin"];
  readonly stdout: HerdrClientIo["stdout"];
  readonly stderr: HerdrClientIo["stderr"];

  constructor(private readonly io: AppChildIo) {
    // Local herdr control/observe children are real Node streams. Async EPIPE
    // on stdin after `herdr terminal session control` exits is not a
    // ChildProcess "error" — callers must be able to attach stdin.on("error").
    this.stdin = {
      write: (chunk) => io.stdin.write(chunk),
      once: (event, listener) => io.stdin.once(event, listener),
      on: (event, listener) => io.stdin.on(event, listener),
    };
    this.stdout = {
      setEncoding: (encoding) => io.stdout.setEncoding(encoding as BufferEncoding),
      on: (event, listener) => {
        if (event === "data") {
          return io.stdout.on("data", listener as (chunk: string) => void);
        }
        return io.stdout.on("error", listener as (error: Error) => void);
      },
    };
    this.stderr = {
      setEncoding: (encoding) => io.stderr.setEncoding(encoding as BufferEncoding),
      on: (event, listener) => {
        if (event === "data") {
          return io.stderr.on("data", listener as (chunk: string) => void);
        }
        return io.stderr.on("error", listener as (error: Error) => void);
      },
    };
  }

  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close" | "error",
    listener: ((code: number | null) => void) | ((error: Error) => void),
  ): unknown {
    if (event === "close") {
      const onClose = listener as (code: number | null) => void;
      return this.io.onClose(({ code }) => onClose(code));
    }
    return this.io.onError(listener as (error: Error) => void);
  }
}

/** Remote SSH stream facade. Deliberately has no `kill` method or pid. */
class EffectHerdrScopeClient extends EventEmitter implements HerdrClientIo {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.enqueue(new TextEncoder().encode(chunk));
      return true;
    },
  };
  readonly close: () => Promise<RemoteScopeCloseReceipt>;

  private lease: SshLease | undefined;
  private pending: Uint8Array[] = [];
  private writes = Promise.resolve();
  private closeRequested = false;
  private settled = false;
  private scopeReadySettled = false;
  private readonly scopeReady: Promise<Scope.CloseableScope | undefined>;
  private resolveScopeReady!: (scope: Scope.CloseableScope | undefined) => void;
  private scopeCloseFlight: Promise<void> | undefined;

  constructor(
    private readonly runPromise: RunPromise,
    private readonly transport: Context.Service.Shape<typeof HerdrTransport>,
    private readonly hostId: HerdrHostId,
    private readonly args: ReadonlyArray<string>,
    private readonly session?: string | null,
  ) {
    super();
    this.scopeReady = new Promise((resolve) => {
      this.resolveScopeReady = resolve;
    });
    const boundedClose = makeBoundedRemoteClose(async () => {
      try {
        await this.closeScope();
      } finally {
        this.finish(null);
      }
    });
    this.close = () => {
      this.closeRequested = true;
      return boundedClose();
    };
    queueMicrotask(() => { void this.start(); });
  }

  private markScopeReady(scope: Scope.CloseableScope | undefined): void {
    if (this.scopeReadySettled) return;
    this.scopeReadySettled = true;
    this.resolveScopeReady(scope);
  }

  private closeScope(): Promise<void> {
    this.scopeCloseFlight ??= this.scopeReady.then((scope) =>
      scope
        ? this.runPromise(Scope.close(scope, Exit.void))
        : undefined,
    );
    return this.scopeCloseFlight;
  }

  private async start(): Promise<void> {
    try {
      const scope = await this.runPromise(
        Scope.make(ExecutionStrategy.sequential),
      );
      this.markScopeReady(scope);
      if (this.closeRequested) {
        await this.closeScope().catch(() => undefined);
        this.finish(null);
        return;
      }

      await this.runPromise(
        this.transport.connect(
          { hostId: this.hostId, args: this.args, session: this.session },
          (lease, confirm) =>
            Effect.gen(this, function* () {
              this.lease = lease;
              yield* Effect.forkIn(
                Stream.runForEach(lease.stdout, (chunk) =>
                  Effect.sync(() => { this.stdout.write(chunk); }),
                ).pipe(Effect.ignore),
                scope,
              );
              yield* Effect.forkIn(
                Stream.runForEach(lease.stderr, (chunk) =>
                  Effect.sync(() => { this.stderr.write(chunk); }),
                ).pipe(Effect.ignore),
                scope,
              );
              yield* Effect.forkIn(
                lease.exitCode.pipe(
                  Effect.tap((code) => Effect.sync(() => this.finish(code))),
                  Effect.ignore,
                ),
                scope,
              );
              return confirm(undefined);
            }),
        ).pipe(Scope.extend(scope)),
      );

      // Close can race the async connect after the pre-connect check. Never
      // flush queued user input into a lease once its scope is retiring.
      if (this.closeRequested) {
        await this.closeScope().catch(() => undefined);
        this.finish(null);
        return;
      }
      const pending = this.pending;
      this.pending = [];
      for (const bytes of pending) this.dispatch(bytes);
    } catch (error) {
      this.markScopeReady(undefined);
      if (this.closeRequested) {
        this.finish(null);
        return;
      }
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      this.finish(null);
    }
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.closeRequested || this.settled) throw new Error("herdr stream is closed");
    if (!this.lease) {
      this.pending.push(Uint8Array.from(bytes));
      return;
    }
    this.dispatch(bytes);
  }

  private dispatch(bytes: Uint8Array): void {
    const lease = this.lease;
    if (!lease) return;
    this.writes = this.writes.then(() => this.runPromise(lease.write(bytes))).catch((error) => {
      if (!this.closeRequested && !this.settled) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private finish(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.pending = [];
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
    void this.closeScope().catch(() => undefined);
  }
}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/HerdrPlane` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class HerdrPlane extends Context.Service<HerdrPlane, HerdrPlane>()("@vellum/HerdrPlane") {}`
 * - Layer today: HerdrPlaneLive — V4 rename candidate HerdrPlane.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class HerdrPlane extends Context.Service<HerdrPlane,
  {
    readonly service: HerdrService;
    readonly mirrors: HerdrMirrorRegistry;
    readonly observePool: HerdrObservePool;
    /**
     * Product seam for herdr control open/write/close. IPC and message delivery
     * must use this — not streams.* — so Effect domain laws are the only path.
     */
    readonly sessions: Context.Service.Shape<typeof TerminalSessions>;
    /**
     * Implementation detail of sessions (observe handoff, host revocation).
     * Not a product write API.
     */
    readonly streams: HerdrStreamManager;
    /** Host-scoped process→port→URL projection (rate-limited side channel). */
    readonly serviceMap: HerdrServiceMap;
    /** Host-scoped Tailscale Serve / SVC catalog. */
    readonly serveCatalog: HostServeCatalog;
    /** Server spawn semantics; no app shutdown cleanup is implied. */
    readonly serverLifetime: HerdrServerLifetime;
    /** Synchronously and permanently refuses new Herdr-owned activity. */
    readonly beginShutdown: () => void;
    readonly drainOnQuit: () => Promise<HerdrShutdownReceipt>;
    readonly isQuiescing: () => boolean;
    readonly start: Effect.Effect<void>;
    readonly warm: Effect.Effect<void>;
  }>()("@vellum/HerdrPlane") {}

export const HerdrPlaneLive = Layer.effect(
  HerdrPlane,
  Effect.gen(function* () {
    const transport = yield* HerdrTransport;
    const ssh = yield* SshTransport;
    const owner = yield* Scope.Scope;
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RunPromise = (effect) => Runtime.runPromise(runtime)(effect);
    const runOwned = makeScopedPromiseRunner(runtime, owner);

    const runner: HerdrRunner = async (hostId, args, session, timeoutMs = 12_000, route) => {
      const known = route?.hostId === hostId ? hostId as HerdrHostId : asHostId(hostId);
      if (!known) return { ok: false, stdout: "", error: `unknown herdr host: ${hostId}` };
      return runOwned(transport.run(known, args, session, timeoutMs, route));
    };

    const awaitServer = (
      hostId: HerdrHostId,
      session?: string | null,
      route?: HerdrServerRoute,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          yield* Effect.sleep(250);
          const status = yield* transport.run(hostId, ["status", "--json"], session, 6_000, route);
          if (serverRunning(status)) return true;
        }
        return false;
      });

    const startServer: HerdrServerStarter = async (hostId, session, route) => {
      const known = route?.hostId === hostId ? hostId as HerdrHostId : asHostId(hostId);
      if (!known) return { ok: false, stdout: "", error: `unknown herdr host: ${hostId}` };
      if (known === "local") {
        try {
          // This receipt proves only OS spawn/handoff. Herdr readiness is a
          // separate protocol fact and is never inferred from the spawn event.
          const osHandoff = appProcessPlane.spawnOutlivingDaemon({
            source: "herdr-server",
            purpose: "herdr-server:daemon-outlives-app",
            command: "herdr",
            args: herdrArgs(["server"], session),
            env: resolvedSpawnEnvSync(),
            lifetime: "outlives-app",
          });
          const protocolReady = await proveHerdrProtocolReadyAfterOsHandoff(
            osHandoff.readiness,
            () => runOwned(awaitServer(known, session, route)),
          );
          return protocolReady
            ? { ok: true, stdout: "" }
            : { ok: false, stdout: "", error: "herdr server did not become ready" };
        } catch (error) {
          return {
            ok: false,
            stdout: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      try {
        await runOwned(
          transport.handoffServer(known, session, (confirm) =>
            awaitServer(known, session, route).pipe(
              Effect.flatMap((ready) =>
                ready
                  ? Effect.succeed(confirm(undefined))
                  : Effect.fail(new Error("herdr server did not become ready")),
              ),
            ),
            route,
          ),
        );
        return { ok: true, stdout: "" };
      } catch (error) {
        return {
          ok: false,
          stdout: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const mirrorForwardPart = createHerdrRemoteScopeShutdownTracker();

    const openMirrorForward = (hostId: string) => {
      if (mirrorForwardPart.isQuiescing()) {
        return Promise.reject(new Error("Herdr mirror forwards are shutting down"));
      }
      const known = asHostId(hostId);
      if (!known || known === "local") {
        return Promise.reject(new Error(`mirror forward requires an ssh herdr host (got ${hostId})`));
      }
      const operation = (async () => {
        // Independent scope: the Herdr shutdown receipt is its sole lifetime
        // owner. Forking under the layer owner would let Effect auto-close a
        // late scope before the bounded Herdr finalizer gets to observe it.
        const scope = await runPromise(Scope.make(ExecutionStrategy.sequential));
        const boundedScopeClose = makeBoundedRemoteClose(
          () => runPromise(Scope.close(scope, Exit.void)),
        );
        const close = mirrorForwardPart.registerScope(boundedScopeClose);
        try {
          const lease = await runPromise(
            transport.forwardMirror(known).pipe(Scope.extend(scope)),
          );
          if (mirrorForwardPart.isQuiescing()) {
            await close();
            throw new Error("Herdr mirror forwards are shutting down");
          }
          return {
            localSocket: String(lease.localSocket),
            closed: runPromise(lease.exitCode).then(() => undefined, () => undefined),
            close,
          };
        } catch (error) {
          await close();
          throw error;
        }
      })();
      return mirrorForwardPart.trackOperation(operation);
    };

    const spawnHerdr: HerdrSpawnFn = (hostId, args, session) => {
      const known = asHostId(hostId);
      if (!known) throw new Error(`unknown herdr host: ${hostId}`);
      if (known === "local") {
        const purpose = args.includes("control")
          ? "herdr-control:session-owned"
          : args.includes("observe")
            ? "herdr-observe:observation-owned"
            : "herdr-client:app-owned";
        const process = appProcessPlane.spawnChild({
          source: "herdr-client",
          purpose,
          command: "herdr",
          args: herdrArgs(args, session),
          env: resolvedSpawnEnvSync(),
        });
        return Object.freeze({
          kind: "local-process",
          child: new AppProcessHerdrClient(process.io),
          terminate: (reason) => appProcessPlane.terminate(process, reason),
          forceTerminate: (reason) =>
            appProcessPlane.forceTerminate(process, reason),
        });
      }
      const child = new EffectHerdrScopeClient(
        runPromise,
        transport,
        known,
        args,
        session,
      );
      return { kind: "remote-scope", child, close: child.close };
    };

    const observePool = new HerdrObservePool({ spawnFn: spawnHerdr });
    const streams = new HerdrStreamManager(
      observePool,
      spawnHerdr,
      (hostId, remoteName, bytes) =>
        runOwned(transport.stageImage(hostId, remoteName, bytes)),
      { manageObservePoolOnShutdown: false },
    );
    // Sole product write/open/close API — IPC must not call streams.* directly.
    const sessions = makeTerminalSessions(streams);

    // Host removal/edit revocation: reconciliation (mirrors.ts) calls these
    // for the affected host, in order, before its mirror is rebuilt. ssh
    // teardown targets the endpoint's SHARED ControlMaster directly — the
    // host may already be gone from the registry by the time this fires, so
    // it never re-resolves through findHostById/HerdrTransport.
    const revocation: HerdrHostRevocationHooks = {
      detachByHost: (hostId) => streams.detachByHost(hostId, "host_revoked"),
      releaseByHost: (hostId) => observePool.releaseByHost(hostId),
      teardownEndpoint: (endpoint) => {
        void mirrorForwardPart.trackOperation(
          runOwned(
            Effect.gen(function* () {
              const parsed = yield* parseSshEndpoint(endpoint);
              yield* ssh.teardown(parsed);
            }).pipe(Effect.ignore),
          ).catch(() => {
            // Reconciliation remains contained, while the exact promise stays
            // in the quit registry until its scope has actually settled.
          }),
        );
      },
    };

    // Demo mode (--vellum-demo): mirrors read from the scripted in-memory
    // transport so the conductor can drive pane state; real transports never
    // construct. Inert otherwise.
    const mirrors = new HerdrMirrorRegistry((hostId) =>
      isDemoMode()
        ? scriptedTransportFor(hostId)
        : hostId === "local"
          ? new LocalMirrorTransport()
          : new RemoteMirrorTransport(hostId, () => openMirrorForward(hostId)),
      revocation,
    );

    const service = new HerdrService(
      runner,
      (hostId) => mirrors.mirrorFor(hostId),
      startServer,
    );

    // Host shell for LISTEN probes — same hop class as herdr remote, never per-card.
    // Remote path only admits closed product shapes (lsof LISTEN / tailscale serve).
    const hostShell: HostShellRunner = async (hostId, argv, timeoutMs = 8_000) => {
      if (argv.length === 0) return { ok: false, stdout: "", error: "empty argv" };
      const executable = argv[0]!;
      const args = argv.slice(1);
      const host = findHostById(hostId);
      if (!host || host.kind === "local" || hostId === "local") {
        return runCli(executable, args, timeoutMs);
      }
      if (!host.sshEndpoint) {
        return { ok: false, stdout: "", error: `host ${hostId} has no ssh endpoint` };
      }
      try {
        const result = await runOwned(
          Effect.gen(function* () {
            const endpoint = yield* parseHostSshRoute(host);
            const command = yield* remoteHostProbe(argv);
            return yield* ssh.run(oneShot(endpoint, command, { budget: "status" }));
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                _fail: true as const,
              }),
            ),
          ),
        );
        if ("_fail" in result && result._fail) {
          return { ok: false, stdout: result.stdout, error: result.stderr || "ssh shell failed" };
        }
        // lsof exits non-zero when no sockets match; caller treats empty stdout as no ports.
        return { ok: true, stdout: result.stdout ?? "" };
      } catch (error) {
        return {
          ok: false,
          stdout: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const fetchProcesses = async (
      hostId: string,
      session: string | null | undefined,
      paneId: string,
    ) => {
      const known = asHostId(hostId);
      if (!known) return [];
      const cli = await runner(
        known,
        ["pane", "process-info", "--pane", paneId],
        session,
        6_000,
      );
      if (!cli.ok) return [];
      const envelope = parseCliEnvelope(cli.stdout);
      if (!envelope.ok) return [];
      return parseProcessInfo(envelope.result).slice(0, 8);
    };

    const resolveHostBaseForCatalog = (hostId: string): string | undefined => {
      if (hostId === "local") return "127.0.0.1";
      return (
        tailscalePeerCache.resolveHost(hostId) ??
        (() => {
          const h = findHostById(hostId);
          if (h?.kind === "remote" && h.sshEndpoint) {
            const ep = h.sshEndpoint;
            const at = ep.lastIndexOf("@");
            return at >= 0 ? ep.slice(at + 1) : ep;
          }
          return hostId === "local" ? undefined : hostId;
        })()
      );
    };

    const serveCatalog = new HostServeCatalog({
      runServeStatus: (hostId) =>
        hostShell(hostId, ["tailscale", "serve", "status", "--json"], 8_000),
      resolveHostBase: resolveHostBaseForCatalog,
      ttlMs: 3 * 60_000,
    });

    const serviceMap = new HerdrServiceMap({
      shell: hostShell,
      fetchProcesses,
      batchPerTick: 2,
      tickIntervalMs: 10_000,
      resolveTailscaleHost: (hostId) => tailscalePeerCache.resolveHost(hostId),
      resolvePreferredServeUrl: (hostId, localPorts) => {
        const hit = serveCatalog.preferredUrl(hostId, localPorts);
        if (!hit) return undefined;
        return { url: hit.url, label: hit.entry.label };
      },
    });

    // The tracked operation is tailscalePeerCache.refresh(), whose own CLI
    // probe carries a 6s bound (hosts/tailscale-peers.ts). The default 2s
    // drain window is shorter than the work it is timing, so quit can report
    // a false "retained" on any run that actually needed the CLI's full
    // budget. Cover that budget with headroom instead of racing it.
    const warmPart = createHerdrOperationShutdownTracker("herdr-warm", 7_000);

    const shutdown = createHerdrShutdownController({
      warm: warmPart,
      "mirror-forwards": mirrorForwardPart,
      service,
      streams,
      observers: observePool,
      mirrors,
      "service-map": serviceMap,
      "serve-catalog": serveCatalog,
    });

    // Warm Tailscale peer cache once at start (soft-fail if CLI missing), but
    // retain the admitted operation in the same quit receipt.
    void warmPart.run(() => tailscalePeerCache.refresh().then(() => undefined));

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const receipt = await shutdown.drainOnQuit();
        if (!receipt.clean) {
          const detail = receipt.causes
            .map((cause) => `${cause.component}:${cause.code}=${cause.message}`)
            .join("; ");
          throw new Error(
            `Herdr shutdown retained ${receipt.retained} operation(s)${detail ? `: ${detail}` : ""}`,
          );
        }
      }),
    );

    const warm = Effect.promise(() => warmPart.run(() =>
      runPromise(transport.warm.pipe(Effect.ignore)),
    ));
    const start = Effect.suspend(() =>
      shutdown.isQuiescing()
        ? Effect.void
        : warm.pipe(
            Effect.zipRight(
              Effect.sync(() => {
                if (shutdown.isQuiescing()) return;
                mirrors.startAll();
                // Soft warm serve catalogs for known herdr hosts (local first).
                for (const h of listHerdrHosts()) {
                  void serveCatalog.refresh(h.id);
                }
              }),
            ),
          ),
    );

    return HerdrPlane.of({
      service,
      mirrors,
      observePool,
      sessions,
      streams,
      serviceMap,
      serveCatalog,
      serverLifetime: HERDR_SERVER_LIFETIME,
      beginShutdown: shutdown.beginShutdown,
      drainOnQuit: shutdown.drainOnQuit,
      isQuiescing: shutdown.isQuiescing,
      start,
      warm,
    });
  }),
);
