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
import { HerdrServiceMap, type HostShellRunner } from "./service-map";
import { HerdrStreamManager, type HerdrProcessLike, type HerdrSpawnFn } from "./stream";
import { HerdrTransport } from "./transport";
import { parseCliEnvelope, parseProcessInfo } from "./parse";
import { findHostById } from "../hosts/snapshot";
import { HostServeCatalog } from "../hosts/serve-catalog";
import { tailscalePeerCache } from "../hosts/tailscale-peers";
import { makeRemoteCommand, parseSshEndpoint } from "../ssh/domain";
import { oneShot } from "../ssh/program";
import { SshTransport } from "../ssh/service";
import { runCli } from "../adapters/exec";

type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** Herdr servers are explicitly independent daemons, never app-owned children. */
export type HerdrServerLifetime = "daemon-outlives-app";

const HERDR_SERVER_LIFETIME: HerdrServerLifetime = "daemon-outlives-app";

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
    /** Host-scoped process→port→URL projection (rate-limited side channel). */
    readonly serviceMap: HerdrServiceMap;
    /** Host-scoped Tailscale Serve / SVC catalog. */
    readonly serveCatalog: HostServeCatalog;
    /** Server spawn semantics; no app shutdown cleanup is implied. */
    readonly serverLifetime: HerdrServerLifetime;
    readonly start: Effect.Effect<void>;
    readonly warm: Effect.Effect<void>;
  }
>() {}

export const HerdrPlaneLive = Layer.scoped(
  HerdrPlane,
  Effect.gen(function* () {
    const transport = yield* HerdrTransport;
    const ssh = yield* SshTransport;
    const owner = yield* Scope.Scope;
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RunPromise = (effect) => Runtime.runPromise(runtime)(effect);
    const runOwned = makeScopedPromiseRunner(runtime, owner);

    const runner: HerdrRunner = async (hostId, args, session, timeoutMs = 12_000) => {
      const known = asHostId(hostId);
      if (!known) return { ok: false, stdout: "", error: `unknown herdr host: ${hostId}` };
      return runOwned(transport.run(known, args, session, timeoutMs));
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
          const ready = await runOwned(awaitServer(known, session));
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
        await runOwned(
          transport.handoffServer(known, session, (confirm) =>
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

    const openMirrorForward = async (hostId: string) => {
      const known = asHostId(hostId);
      if (!known || known === "local") {
        throw new Error(`mirror forward requires an ssh herdr host (got ${hostId})`);
      }
      const scope = await runPromise(Scope.fork(owner, ExecutionStrategy.sequential));
      try {
        const lease = await runPromise(
          transport.forwardMirror(known).pipe(Scope.extend(scope)),
        );
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
      (hostId, remoteName, bytes) =>
        runOwned(transport.stageImage(hostId, remoteName, bytes)),
    );

    // Host removal/edit revocation: reconciliation (mirrors.ts) calls these
    // for the affected host, in order, before its mirror is rebuilt. ssh
    // teardown targets the endpoint's SHARED ControlMaster directly — the
    // host may already be gone from the registry by the time this fires, so
    // it never re-resolves through findHostById/HerdrTransport.
    const revocation: HerdrHostRevocationHooks = {
      detachByHost: (hostId) => streams.detachByHost(hostId, "host_revoked"),
      releaseByHost: (hostId) => observePool.releaseByHost(hostId),
      teardownEndpoint: (endpoint) => {
        void runOwned(
          Effect.gen(function* () {
            const parsed = yield* parseSshEndpoint(endpoint);
            yield* ssh.teardown(parsed);
          }).pipe(Effect.ignore),
        ).catch(() => {
          // Best-effort: a rejected runtime bridge must never crash the
          // reconciliation path that triggered it.
        });
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
    const hostShell: HostShellRunner = async (hostId, argv, timeoutMs = 8_000) => {
      if (argv.length === 0) return { ok: false, stdout: "", error: "empty argv" };
      const executable = argv[0]!;
      const args = argv.slice(1);
      const host = findHostById(hostId);
      if (!host || host.kind === "local" || hostId === "local") {
        return runCli(executable, args, timeoutMs);
      }
      if (!host.endpoint) {
        return { ok: false, stdout: "", error: `host ${hostId} has no ssh endpoint` };
      }
      try {
        const result = await runOwned(
          Effect.gen(function* () {
            const endpoint = yield* parseSshEndpoint(host.endpoint!);
            const command = yield* makeRemoteCommand(executable, args);
            return yield* ssh.run(oneShot(endpoint, command, { budget: "status" }));
          }).pipe(
            Effect.catchAll((error) =>
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
          if (h?.kind === "remote" && h.endpoint) {
            const ep = h.endpoint;
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

    // Warm Tailscale peer cache once at start (soft-fail if CLI missing).
    void tailscalePeerCache.refresh();

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        streams.detachAllOnQuit("runtime_dispose");
        mirrors.stopAll();
        serviceMap.stop();
      }),
    );

    const warm = transport.warm.pipe(Effect.ignore);
    const start = warm.pipe(
      Effect.zipRight(
        Effect.sync(() => {
          mirrors.startAll();
          // Soft warm serve catalogs for known herdr hosts (local first).
          for (const h of listHerdrHosts()) {
            void serveCatalog.refresh(h.id);
          }
        }),
      ),
    );

    return HerdrPlane.of({
      service,
      mirrors,
      observePool,
      streams,
      serviceMap,
      serveCatalog,
      serverLifetime: HERDR_SERVER_LIFETIME,
      start,
      warm,
    });
  }),
);
