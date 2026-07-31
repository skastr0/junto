import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AgentReply } from "@shared/ipc";
import type { SnapshotBundle } from "@shared/entities";
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
import { resolvedSpawnEnvSync } from "../adapters/exec";
import {
  fetchHermesBundle,
  type HermesFleetOperations,
} from "../adapters/hermes";
import { appProcessPlane } from "../app-process-plane";
import type { AppProcessLease, AppProcessPlane } from "../app-process-plane";
import type { AcpChildLike, SpawnFn } from "../chat/acp-client";
import {
  ChatService,
  ChatServiceContext,
  requireCleanChatShutdown,
  type ChatCloseAllResult,
} from "../chat/service";
import type { AcpSpawnTarget } from "../chat/spawn";
import { makeScopedPromiseRunner, type SshLease } from "../ssh";
import {
  isLocalHermesHost,
  isDefaultHermesProfile,
  resolveHermesStationIdentity,
  type HermesProfileName,
  type HermesStationIdentity,
} from "./domain";
import { HermesTransport } from "./transport";
import { SettingsService } from "../settings/service";
import {
  getProcessIdentityMap,
  type ProcessIdentityMap,
} from "../process-identity";

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const acpArgs = (profile: HermesProfileName): ReadonlyArray<string> =>
  isDefaultHermesProfile(profile) ? ["acp"] : ["-p", profile, "acp"];

type LocalAcpProcessPlane = Pick<AppProcessPlane, "terminate">;

/**
 * Bind an attached local ACP generation before Chat receives the child. A
 * missing PID/start-key is a closed admission failure: the exact app-owned
 * child is terminated and never runs as an unregistered agent.
 */
export const bindLocalAcpProcessIdentity = (
  lease: AppProcessLease,
  agentKey: string,
  processPlane: LocalAcpProcessPlane = appProcessPlane,
  identities: ProcessIdentityMap = getProcessIdentityMap(),
): void => {
  const pid = lease.io.pidForDiagnostics;
  const binding =
    pid === undefined
      ? undefined
      : identities.bindGeneration(pid, { agentKey });
  if (binding === undefined) {
    try {
      processPlane.terminate(
        lease,
        "local ACP process identity admission failed",
      );
    } finally {
      throw new Error("local ACP process identity admission failed");
    }
  }

  try {
    lease.io.onClose(() => {
      identities.unbindGeneration(binding);
    });
  } catch {
    identities.unbindGeneration(binding);
    try {
      processPlane.terminate(
        lease,
        "local ACP process identity observer failed",
      );
    } finally {
      throw new Error("local ACP process identity observer failed");
    }
  }
};

export class EffectAcpChild extends EventEmitter implements AcpChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.enqueue(new TextEncoder().encode(chunk));
      return true;
    },
  };

  private scope: Scope.CloseableScope | undefined;
  private lease: SshLease | undefined;
  private pending: Uint8Array[] = [];
  private writes = Promise.resolve();
  private killed = false;
  private settled = false;
  private startSettled = false;
  private finishRequested = false;
  private cleanupFlight: Promise<void> | undefined;
  private finishFlight: Promise<void> | undefined;
  private cleanupFailed = false;
  private terminalResolve!: () => void;
  private readonly terminalCompletion = new Promise<void>((resolve) => {
    this.terminalResolve = resolve;
  });

  constructor(
    private readonly runPromise: RunPromise,
    private readonly transport: Context.Tag.Service<typeof HermesTransport>,
    private readonly host: string,
    private readonly profile: HermesProfileName,
  ) {
    super();
    queueMicrotask(() => {
      void this.start();
    });
  }

  close(): Promise<void> {
    if (this.settled) return this.terminalCompletion;
    this.killed = true;
    if (this.scope !== undefined || this.startSettled) this.requestFinish(null);
    return this.terminalCompletion;
  }

  get clean(): boolean {
    return !this.cleanupFailed;
  }

  private async start(): Promise<void> {
    try {
      const scope = await this.runPromise(
        Scope.make(ExecutionStrategy.sequential),
      );
      this.scope = scope;
      if (this.killed) return;

      await this.runPromise(
        this.transport
          .connectAcp(this.host, this.profile, (lease, confirm) =>
            Effect.gen(this, function* () {
              this.lease = lease;
              yield* Effect.forkIn(
                Stream.runForEach(lease.stdout, (chunk) =>
                  Effect.sync(() => {
                    this.stdout.write(chunk);
                  }),
                ).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => this.deferFailure(error)),
                  ),
                  Effect.ignore,
                ),
                scope,
              );
              yield* Effect.forkIn(
                Stream.runForEach(lease.stderr, (chunk) =>
                  Effect.sync(() => {
                    this.stderr.write(chunk);
                  }),
                ).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => this.deferFailure(error)),
                  ),
                  Effect.ignore,
                ),
                scope,
              );
              yield* Effect.forkIn(
                lease.exitCode.pipe(
                  Effect.match({
                    onFailure: (error) => this.deferFailure(error),
                    onSuccess: (code) => this.requestFinish(code),
                  }),
                ),
                scope,
              );
              return confirm(undefined);
            }),
          )
          .pipe(Scope.extend(scope)),
      );

      const pending = this.pending;
      this.pending = [];
      for (const bytes of pending) this.dispatch(bytes);
    } catch (error) {
      if (!this.killed) this.emitDiagnostic(error);
      this.killed = true;
    } finally {
      this.startSettled = true;
      if (this.killed) this.requestFinish(null);
    }
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.killed) throw new Error("ACP stream is closed");
    if (!this.lease) {
      this.pending.push(Uint8Array.from(bytes));
      return;
    }
    this.dispatch(bytes);
  }

  private dispatch(bytes: Uint8Array): void {
    const lease = this.lease;
    if (!lease) return;
    this.writes = this.writes
      .then(() => this.runPromise(lease.write(bytes)))
      .catch((error) => {
        this.fail(error);
      });
  }

  private deferFailure(error: unknown): void {
    queueMicrotask(() => this.fail(error));
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    if (!this.killed) this.emitDiagnostic(error);
    this.killed = true;
    this.requestFinish(null);
  }

  private requestFinish(code: number | null): void {
    if (this.settled || this.finishRequested) return;
    this.finishRequested = true;
    this.killed = true;
    queueMicrotask(() => {
      void this.finishAfterCleanup(code);
    });
  }

  private closeScope(): Promise<void> {
    if (this.cleanupFlight !== undefined) return this.cleanupFlight;
    const scope = this.scope;
    if (scope === undefined) return Promise.resolve();
    let close: Promise<void>;
    try {
      close = this.runPromise(Scope.close(scope, Exit.void));
    } catch (error) {
      close = Promise.reject(error);
    }
    this.cleanupFlight = close.catch((error) => {
      this.cleanupFailed = true;
      this.emitDiagnostic(error);
    });
    return this.cleanupFlight;
  }

  private finishAfterCleanup(code: number | null): Promise<void> {
    if (this.finishFlight !== undefined) return this.finishFlight;
    this.finishFlight = (async () => {
      await this.closeScope();
      if (this.settled) return;
      this.settled = true;
      this.pending = [];
      try {
        this.stdout.end();
      } catch {
        /* observer-only stream */
      }
      try {
        this.stderr.end();
      } catch {
        /* observer-only stream */
      }
      this.emitContained("exit", code);
      this.emitContained("close", code);
      this.terminalResolve();
    })();
    return this.finishFlight;
  }

  private emitDiagnostic(error: unknown): void {
    this.emitContained(
      "error",
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private emitContained(
    event: "error" | "exit" | "close",
    value: unknown,
  ): void {
    try {
      this.emit(event, value);
    } catch {
      // Consumers are observers; cleanup and the following terminal event
      // must continue even when one listener throws.
    }
  }
}

export class HermesPlane extends Context.Tag("@vellum/HermesPlane")<
  HermesPlane,
  {
    readonly chat: ChatService;
    readonly shutdown: HermesShutdownPort;
    readonly fetchBundle: () => Promise<SnapshotBundle>;
    readonly fetchAgentMessage: (
      key: string,
      text: string,
    ) => Promise<AgentReply>;
  }
>() {}

export interface HermesShutdownFailure {
  readonly kind: "chat-close-rejected";
  readonly message: string;
}

/**
 * The complete ChatService teardown evidence published at the Hermes plane
 * boundary. A rejected close sink is converted into explicit unclean evidence
 * so the caller never mistakes a swallowed rejection for a clean shutdown.
 */
export interface HermesShutdownReceipt extends ChatCloseAllResult {
  readonly failure?: HermesShutdownFailure;
}

export interface HermesShutdownPort {
  /**
   * Closes ChatService admission synchronously on first invocation, then waits
   * for every admitted local or remote ACP teardown receipt.
   */
  readonly drainOnQuit: () => Promise<HermesShutdownReceipt>;
}

const describeShutdownFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const rejectedShutdownReceipt = (error: unknown): HermesShutdownReceipt =>
  Object.freeze({
    clean: false,
    teardowns: Object.freeze([]),
    failure: Object.freeze({
      kind: "chat-close-rejected" as const,
      message: describeShutdownFailure(error),
    }),
  });

/**
 * Publish one shutdown flight before crossing the ChatService seam. This is
 * deliberately exported as the direct boundary used by both main and the
 * Effect layer finalizer; neither can start a competing cleanup generation.
 */
export const makeHermesShutdownPort = (
  chat: Pick<ChatService, "closeAll">,
): HermesShutdownPort => {
  let flight: Promise<HermesShutdownReceipt> | undefined;

  const drainOnQuit = (): Promise<HermesShutdownReceipt> => {
    if (flight !== undefined) return flight;

    let resolveFlight!: (receipt: HermesShutdownReceipt) => void;
    flight = new Promise<HermesShutdownReceipt>((resolve) => {
      resolveFlight = resolve;
    });

    let closeFlight: Promise<ChatCloseAllResult>;
    try {
      // closeAll flips ChatService admission before returning its promise.
      closeFlight = Promise.resolve(chat.closeAll());
    } catch (error) {
      resolveFlight(rejectedShutdownReceipt(error));
      return flight;
    }
    void closeFlight.then(
      (receipt) => resolveFlight(receipt),
      (error) => resolveFlight(rejectedShutdownReceipt(error)),
    );
    return flight;
  };

  return Object.freeze({ drainOnQuit });
};

export const finalizeHermesShutdown = (
  shutdown: HermesShutdownPort,
): Effect.Effect<HermesShutdownReceipt> =>
  Effect.promise(async () => {
    const receipt = await shutdown.drainOnQuit();
    requireCleanChatShutdown(receipt);
    return receipt;
  });

export const HermesPlaneLive = Layer.scoped(
  HermesPlane,
  Effect.gen(function* () {
    const transport = yield* HermesTransport;
    const settings = yield* SettingsService;
    const owner = yield* Scope.Scope;
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RunPromise = (effect) =>
      Runtime.runPromise(runtime)(effect);
    const runOwned = makeScopedPromiseRunner(runtime, owner);
    let observedIdentity: HermesStationIdentity | undefined;
    let observedUpdate = false;
    let applyStationIdentity:
      ((next: HermesStationIdentity) => void) | undefined;
    const unsubscribeSettings = settings.subscribe((next) => {
      const identity = resolveHermesStationIdentity(next.station);
      observedUpdate = true;
      observedIdentity = identity;
      applyStationIdentity?.(identity);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeSettings));
    const initialSettings = yield* settings.get;
    // Subscribe-before-read closes the hydration gap. A complete transaction
    // observed while settings.get is pending wins over the older load result.
    let stationIdentity: HermesStationIdentity =
      observedUpdate && observedIdentity !== undefined
        ? observedIdentity
        : resolveHermesStationIdentity(initialSettings.station);

    const operations: HermesFleetOperations = {
      profiles: (host) => runOwned(transport.profiles(host)),
      version: (host) => runOwned(transport.version(host)),
    };

    const spawnAcp: SpawnFn = (target: AcpSpawnTarget) => {
      // Only this station's exact configured Hermes self key is a direct
      // child. Every other key remains registry/SSH-backed.
      if (!isLocalHermesHost(target.host, stationIdentity)) {
        const child = new EffectAcpChild(
          runPromise,
          transport,
          target.host,
          target.profile,
        );
        return {
          kind: "remote-scope",
          child,
          close: () => child.close(),
          isClean: () => child.clean,
        };
      }

      const lease = appProcessPlane.spawnChild({
        source: `hermes-acp:${target.profile}`,
        purpose: `local ACP session for ${target.profile}`,
        command: "hermes",
        args: acpArgs(target.profile),
        env: resolvedSpawnEnvSync(),
      });
      bindLocalAcpProcessIdentity(lease, `${target.host}:${target.profile}`);
      return {
        kind: "local-process",
        lease,
        processPlane: appProcessPlane,
      };
    };

    const chat = new ChatService(spawnAcp, (host) =>
      isLocalHermesHost(host, stationIdentity),
    );
    applyStationIdentity = (nextIdentity) => {
      const previousIdentity = stationIdentity;
      if (
        previousIdentity.hostId === nextIdentity.hostId &&
        previousIdentity.agentHostId === nextIdentity.agentHostId
      ) {
        return;
      }
      stationIdentity = nextIdentity;
      chat.reconcileHostLocality((host) =>
        isLocalHermesHost(host, previousIdentity),
      );
    };
    const shutdown = makeHermesShutdownPort(chat);
    yield* Effect.addFinalizer(() => finalizeHermesShutdown(shutdown));

    return HermesPlane.of({
      chat,
      shutdown,
      fetchBundle: () => fetchHermesBundle(operations, stationIdentity),
      fetchAgentMessage: (key, text) => chat.agentMessage(key, text),
    });
  }),
);

export const ChatServiceFromHermesLive = Layer.effect(
  ChatServiceContext,
  Effect.map(HermesPlane, (plane) => plane.chat),
);
