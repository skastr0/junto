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
import type {
  AcpChildEnvironmentOverlay,
  AcpChildLike,
  SpawnFn,
} from "../chat/acp-client";
import {
  ChatService,
  ChatServiceContext,
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

const terminateLocalAcpChild = (
  child: ChildProcessWithoutNullStreams,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      resolve();
    };
    child.once("close", finish);
    child.once("error", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
      }
    }, 2_000);
    boundTimer = setTimeout(finish, 4_000);
  });
};

class EffectAcpChild extends EventEmitter implements AcpChildLike {
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

  constructor(
    private readonly runPromise: RunPromise,
    private readonly owner: Scope.Scope,
    private readonly transport: Context.Tag.Service<typeof HermesTransport>,
    private readonly profile: HermesProfileName,
  ) {
    super();
    queueMicrotask(() => { void this.start(); });
  }

  kill(_signal?: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    const close = this.scope
      ? this.runPromise(Scope.close(this.scope, Exit.void))
      : Promise.resolve();
    void close.finally(() => this.finish(null));
    return true;
  }

  private async start(): Promise<void> {
    try {
      const scope = await this.runPromise(
        Scope.fork(this.owner, ExecutionStrategy.sequential),
      );
      this.scope = scope;
      if (this.killed) {
        await this.runPromise(Scope.close(scope, Exit.void));
        this.finish(null);
        return;
      }

      await this.runPromise(
        this.transport.connectAcp(
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
                    onSuccess: (code) => this.finish(code),
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
      if (this.killed) {
        this.finish(null);
        return;
      }
      if (this.scope) {
        await this.runPromise(Scope.close(this.scope, Exit.void));
      }
      this.fail(error);
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
    if (this.settled || this.killed) return;
    this.settled = true;
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
    if (this.scope) {
      void this.runPromise(Scope.close(this.scope, Exit.void));
    }
  }

  private finish(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
    this.emit("close", code);
    if (!this.killed && this.scope) {
      this.killed = true;
      void this.runPromise(Scope.close(this.scope, Exit.void));
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
      identityBatch: () => runOwned(transport.identityBatch),
      avatar: (profile) => runOwned(transport.avatar(profile)),
    };

    const localChildren = new Set<ChildProcessWithoutNullStreams>();

    const spawnAcp: SpawnFn = (
      target: AcpSpawnTarget,
      options?: { readonly environmentOverlay?: AcpChildEnvironmentOverlay },
    ): AcpChildLike => {
      if (target.host === "remote-a") {
        if (options?.environmentOverlay !== undefined) {
          throw new Error("ACP child environment overlays are local-only");
        }
        return new EffectAcpChild(runPromise, owner, transport, target.profile);
      }

      const env = options?.environmentOverlay === undefined
        ? resolvedSpawnEnvSync()
        : { ...resolvedSpawnEnvSync(), ...options.environmentOverlay };
      const child = spawn("hermes", [...acpArgs(target.profile)], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }) as ChildProcessWithoutNullStreams;
      localChildren.add(child);
      child.once("close", () => localChildren.delete(child));
      child.once("error", () => localChildren.delete(child));
      return child;
    };

    const chat = new ChatService(spawnAcp);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        chat.closeAll();
        await Promise.all([...localChildren].map(terminateLocalAcpChild));
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
