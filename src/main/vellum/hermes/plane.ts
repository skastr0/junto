import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AgentIdentity, AgentReply } from "@shared/ipc";
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
import {
  fetchAgentAvatar,
  fetchAgentIdentity,
  type HermesIdentityOperations,
} from "../adapters/hermes-identity";
import { admitChildProcess } from "../process-signal";
import type {
  AcpChildEnvironmentOverlay,
  AcpChildLike,
  SpawnFn,
} from "../chat/acp-client";
import {
  ChatService,
  ChatServiceContext,
  requireCleanChatShutdown,
} from "../chat/service";
import type { AcpSpawnTarget } from "../chat/spawn";
import {
  makeScopedPromiseRunner,
  type SshLease,
} from "../ssh";
import {
  isDefaultHermesProfile,
  type HermesProfileName,
} from "./domain";
import { HermesTransport } from "./transport";

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const acpArgs = (profile: HermesProfileName): ReadonlyArray<string> =>
  isDefaultHermesProfile(profile) ? ["acp"] : ["-p", profile, "acp"];

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
    queueMicrotask(() => { void this.start(); });
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
        this.transport.connectAcp(
          this.host,
          this.profile,
          (lease, confirm) =>
            Effect.gen(this, function* () {
              this.lease = lease;
              yield* Effect.forkIn(
                Stream.runForEach(lease.stdout, (chunk) =>
                  Effect.sync(() => { this.stdout.write(chunk); }),
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
                  Effect.sync(() => { this.stderr.write(chunk); }),
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
        ).pipe(Scope.extend(scope)),
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
      try { this.stdout.end(); } catch { /* observer-only stream */ }
      try { this.stderr.end(); } catch { /* observer-only stream */ }
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

  private emitContained(event: "error" | "exit" | "close", value: unknown): void {
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
    readonly fetchBundle: () => Promise<SnapshotBundle>;
    readonly fetchAgentIdentity: (key: string) => Promise<AgentIdentity | null>;
    readonly fetchAgentAvatar: (key: string) => Promise<string | null>;
    readonly fetchAgentMessage: (key: string, text: string) => Promise<AgentReply>;
  }
>() {}

export const HermesPlaneLive = Layer.scoped(
  HermesPlane,
  Effect.gen(function* () {
    const transport = yield* HermesTransport;
    const owner = yield* Scope.Scope;
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RunPromise = (effect) => Runtime.runPromise(runtime)(effect);
    const runOwned = makeScopedPromiseRunner(runtime, owner);

    const operations: HermesIdentityOperations & HermesFleetOperations = {
      profiles: (host) => runOwned(transport.profiles(host)),
      version: (host) => runOwned(transport.version(host)),
      identityBatch: (host) => runOwned(transport.identityBatch(host)),
      avatar: (host, profile) => runOwned(transport.avatar(host, profile)),
    };

    const spawnAcp: SpawnFn = (
      target: AcpSpawnTarget,
      options?: { readonly environmentOverlay?: AcpChildEnvironmentOverlay },
    ) => {
      // Local = direct hermes child. Any other host id is treated as remote
      // (must exist in the host registry with kind=remote).
      if (target.host !== "local") {
        if (options?.environmentOverlay !== undefined) {
          throw new Error("ACP child environment overlays are local-only");
        }
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

      const env = options?.environmentOverlay === undefined
        ? resolvedSpawnEnvSync()
        : { ...resolvedSpawnEnvSync(), ...options.environmentOverlay };
      const child = spawn("hermes", [...acpArgs(target.profile)], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }) as ChildProcessWithoutNullStreams;
      return {
        kind: "local-process",
        child,
        process: admitChildProcess({
          source: `hermes-acp:${target.profile}`,
          child,
        }),
      };
    };

    const chat = new ChatService(spawnAcp);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        requireCleanChatShutdown(await chat.closeAll());
      }),
    );

    return HermesPlane.of({
      chat,
      fetchBundle: () => fetchHermesBundle(operations),
      fetchAgentIdentity: (key) => fetchAgentIdentity(operations, key),
      fetchAgentAvatar: (key) => fetchAgentAvatar(operations, key),
      fetchAgentMessage: (key, text) => chat.agentMessage(key, text),
    });
  }),
);

export const ChatServiceFromHermesLive = Layer.effect(
  ChatServiceContext,
  Effect.map(HermesPlane, (plane) => plane.chat),
);
