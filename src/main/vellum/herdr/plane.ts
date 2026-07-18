import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
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
import type { SshLease } from "../ssh/service";
import {
  HERDR_HOSTS,
  isKnownHerdrHost,
  type HerdrHostId,
} from "./hosts";
import { LocalMirrorTransport, RemoteMirrorTransport } from "./mirror-transport";
import { HerdrMirrorRegistry } from "./mirrors";
import { HerdrObservePool } from "./observe-pool";
import { HerdrService, type HerdrRunner, type HerdrServerStarter } from "./service";
import { HerdrStreamManager, type HerdrProcessLike, type HerdrSpawnFn } from "./stream";
import { HerdrTransport } from "./transport";

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

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

class EffectHerdrChild extends EventEmitter implements HerdrProcessLike {
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
    private readonly transport: Context.Tag.Service<typeof HerdrTransport>,
    private readonly hostId: HerdrHostId,
    private readonly args: ReadonlyArray<string>,
    private readonly session?: string | null,
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
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.killed) throw new Error("herdr stream is closed");
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
      if (!this.killed) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private finish(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
    if (!this.killed && this.scope) {
      this.killed = true;
      void this.runPromise(Scope.close(this.scope, Exit.void));
    }
  }
}

export class HerdrPlane extends Context.Tag("@vellum/HerdrPlane")<
  HerdrPlane,
  {
    readonly service: HerdrService;
    readonly mirrors: HerdrMirrorRegistry;
    readonly observePool: HerdrObservePool;
    readonly streams: HerdrStreamManager;
    readonly start: Effect.Effect<void>;
    readonly warm: Effect.Effect<void>;
  }
>() {}

export const HerdrPlaneLive = Layer.scoped(
  HerdrPlane,
  Effect.gen(function* () {
    const transport = yield* HerdrTransport;
    const owner = yield* Scope.Scope;
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RunPromise = (effect) => Runtime.runPromise(runtime)(effect);

    const runner: HerdrRunner = async (hostId, args, session, timeoutMs = 12_000) => {
      const known = asHostId(hostId);
      if (!known) return { ok: false, stdout: "", error: `unknown herdr host: ${hostId}` };
      return runPromise(transport.run(known, args, session, timeoutMs));
    };

    const awaitServer = (hostId: HerdrHostId, session?: string | null) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          yield* Effect.sleep(250);
          const status = yield* transport.run(hostId, ["status", "--json"], session, 6_000);
          if (serverRunning(status)) return true;
        }
        return false;
      });

    const startServer: HerdrServerStarter = async (hostId, session) => {
      const known = asHostId(hostId);
      if (!known) return { ok: false, stdout: "", error: `unknown herdr host: ${hostId}` };
      if (known === "local") {
        try {
          const child = spawn("herdr", [...herdrArgs(["server"], session)], {
            detached: true,
            stdio: "ignore",
            env: resolvedSpawnEnvSync(),
          });
          child.unref();
          const ready = await runPromise(awaitServer(known, session));
          return ready
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
        await runPromise(
          transport.handoffServer(session, (confirm) =>
            awaitServer(known, session).pipe(
              Effect.flatMap((ready) =>
                ready
                  ? Effect.succeed(confirm(undefined))
                  : Effect.fail(new Error("herdr server did not become ready")),
              ),
            ),
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

    const openMirrorForward = async () => {
      const scope = await runPromise(Scope.fork(owner, ExecutionStrategy.sequential));
      try {
        const lease = await runPromise(transport.forwardMirror.pipe(Scope.extend(scope)));
        return {
          localSocket: String(lease.localSocket),
          closed: runPromise(lease.exitCode).then(() => undefined, () => undefined),
          close: () => runPromise(Scope.close(scope, Exit.void)),
        };
      } catch (error) {
        await runPromise(Scope.close(scope, Exit.void));
        throw error;
      }
    };

    const mirrors = new HerdrMirrorRegistry((hostId) =>
      hostId === "local"
        ? new LocalMirrorTransport()
        : new RemoteMirrorTransport(hostId, openMirrorForward),
    );

    const spawnHerdr: HerdrSpawnFn = (hostId, args, session) => {
      const known = asHostId(hostId);
      if (!known) throw new Error(`unknown herdr host: ${hostId}`);
      if (known === "local") {
        return spawn("herdr", [...herdrArgs(args, session)], {
          stdio: ["pipe", "pipe", "pipe"],
          env: resolvedSpawnEnvSync(),
        }) as unknown as HerdrProcessLike;
      }
      return new EffectHerdrChild(runPromise, owner, transport, known, args, session);
    };

    const observePool = new HerdrObservePool({ spawnFn: spawnHerdr });
    const streams = new HerdrStreamManager(
      observePool,
      spawnHerdr,
      (remoteName, bytes) => runPromise(transport.stageImage(remoteName, bytes)),
    );
    const service = new HerdrService(
      runner,
      (hostId) => mirrors.mirrorFor(hostId),
      startServer,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        streams.detachAllOnQuit("runtime_dispose");
        mirrors.stopAll();
      }),
    );

    const warm = transport.warm.pipe(Effect.ignore);
    const start = warm.pipe(Effect.zipRight(Effect.sync(() => mirrors.startAll())));

    return HerdrPlane.of({ service, mirrors, observePool, streams, start, warm });
  }),
);
