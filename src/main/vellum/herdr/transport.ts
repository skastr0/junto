import { Context, Effect, Layer, Scope } from "effect";
import { join } from "node:path";
import type { CliResult } from "../adapters/exec";
import { runCli } from "../adapters/exec";
import { findHostById, hostsWithCapability } from "../hosts/snapshot";
import {
  makeRemoteStdin,
  parseHostSshRoute,
  parseRemoteUnixSocketPath,
  parseSshRoute,
  SshInputError,
  type SshError,
  type SshTarget,
} from "../ssh/domain";
import {
  daemonHandoff,
  homeDirectoryLookup,
  oneShot,
  oneShotWithStdin,
  sharedStream,
  unixForward,
  type OneShotBudget,
} from "../ssh/program";
import { remoteHerdrCli } from "../ssh/read-commands";
import { compileHerdrImageStage } from "../ssh/remote-plan";
import {
  SshTransport,
  type ConfirmSshReady,
  type SshForwardLease,
  type SshLease,
  type SshReady,
} from "../ssh/service";
import { isKnownHerdrHost, type HerdrHostId } from "./hosts";
import type { HerdrServerRoute } from "./route";

const withSession = (
  args: ReadonlyArray<string>,
  session?: string | null,
): ReadonlyArray<string> => (session ? ["--session", session, ...args] : args);

const budgetFor = (timeoutMs: number): OneShotBudget => {
  if (timeoutMs <= 6_000) return "short";
  if (timeoutMs <= 8_000) return "status";
  if (timeoutMs <= 10_000) return "list";
  return "standard";
};

const sshFailure = (error: SshError | SshInputError): string => {
  switch (error._tag) {
    case "SshExitError":
      return `ssh operation exited with code ${error.code}`;
    case "SshTimeoutError":
      return `ssh operation timed out after ${error.timeoutMs}ms`;
    default:
      return error.message;
  }
};

const resolveRemoteEndpoint = (
  hostId: HerdrHostId,
  route?: HerdrServerRoute,
): Effect.Effect<SshTarget, SshInputError> => {
  if (route) {
    if (route.hostId !== hostId || route.kind !== "remote" || !route.endpoint) {
      return Effect.fail(new SshInputError({ message: `invalid captured herdr route for ${hostId}` }));
    }
    return parseSshRoute({
      endpoint: route.endpoint,
      ...(route.identityFile ? { identityFile: route.identityFile } : {}),
      ...(route.hostKeyPolicy ? { hostKeyPolicy: route.hostKeyPolicy } : {}),
    });
  }
  const host = findHostById(hostId);
  if (!host || host.kind !== "remote" || !host.sshEndpoint) {
    return Effect.fail(
      new SshInputError({
        message: `herdr host ${hostId} is not a configured ssh endpoint`,
      }),
    );
  }
  return parseHostSshRoute(host);
};

export interface HerdrStreamSpec {
  readonly hostId: HerdrHostId;
  readonly args: ReadonlyArray<string>;
  readonly session?: string | null;
}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/HerdrTransport` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class HerdrTransport extends Context.Service<HerdrTransport, HerdrTransport>()("@vellum/HerdrTransport") {}`
 * - Layer today: HerdrTransportLive — V4 rename candidate HerdrTransport.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class HerdrTransport extends Context.Service<HerdrTransport,
  {
    readonly run: (
      hostId: HerdrHostId,
      args: ReadonlyArray<string>,
      session?: string | null,
      timeoutMs?: number,
      route?: HerdrServerRoute,
    ) => Effect.Effect<CliResult>;
    readonly warm: Effect.Effect<void, SshError | SshInputError>;
    readonly connect: <A, E, R>(
      spec: HerdrStreamSpec,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | SshInputError | E, R | Scope.Scope>;
    readonly forwardMirror: (
      hostId: HerdrHostId,
    ) => Effect.Effect<SshForwardLease, SshError | SshInputError, Scope.Scope>;
    readonly handoffServer: <A, E, R>(
      hostId: HerdrHostId,
      session: string | null | undefined,
      awaitReady: (confirm: ConfirmSshReady) => Effect.Effect<SshReady<A>, E, R>,
      route?: HerdrServerRoute,
    ) => Effect.Effect<A, SshError | SshInputError | E, R>;
    readonly stageImage: (
      hostId: HerdrHostId,
      remoteName: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string, SshError | SshInputError>;
  }>()("@vellum/HerdrTransport") {}

export const HerdrTransportLive = Layer.effect(
  HerdrTransport,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;

    const runRemote = (
      endpoint: SshTarget,
      args: ReadonlyArray<string>,
      session: string | null | undefined,
      timeoutMs: number,
    ): Effect.Effect<CliResult> =>
      remoteHerdrCli(withSession(args, session)).pipe(
        Effect.flatMap((command) =>
          ssh.run(oneShot(endpoint, command, { budget: budgetFor(timeoutMs) })),
        ),
        Effect.map((result): CliResult => ({ ok: true, stdout: result.stdout })),
        Effect.catch((error) =>
          Effect.succeed({ ok: false, stdout: "", error: sshFailure(error) }),
        ),
      );

    const run = (
      hostId: HerdrHostId,
      args: ReadonlyArray<string>,
      session?: string | null,
      timeoutMs = 12_000,
      route?: HerdrServerRoute,
    ): Effect.Effect<CliResult> => {
      if (!route && !isKnownHerdrHost(hostId)) {
        return Effect.succeed({
          ok: false,
          stdout: "",
          error: `unknown herdr host: ${hostId}`,
        });
      }
      if (hostId === "local") {
        return Effect.tryPromise(() =>
          runCli("herdr", withSession(args, session), timeoutMs),
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              stdout: "",
              error: error instanceof Error ? error.message : String(error),
            } satisfies CliResult),
          ),
        );
      }
      return resolveRemoteEndpoint(hostId, route).pipe(
        Effect.flatMap((endpoint) => runRemote(endpoint, args, session, timeoutMs)),
        Effect.catch((error) =>
          Effect.succeed({ ok: false, stdout: "", error: sshFailure(error) }),
        ),
      );
    };

    const connect: Context.Service.Shape<typeof HerdrTransport>["connect"] = (
      spec,
      awaitReady,
    ) => {
      if (!isKnownHerdrHost(spec.hostId) || spec.hostId === "local") {
        return Effect.fail(
          new SshInputError({
            message: "HerdrTransport.connect is reserved for configured ssh herdr hosts",
          }),
        );
      }
      return resolveRemoteEndpoint(spec.hostId).pipe(
        Effect.flatMap((endpoint) =>
          remoteHerdrCli(withSession(spec.args, spec.session)).pipe(
            Effect.flatMap((command) =>
              ssh.connect(sharedStream(endpoint, command, "fast"), awaitReady),
            ),
          ),
        ),
      );
    };

    const forwardMirror: Context.Service.Shape<typeof HerdrTransport>["forwardMirror"] = (
      hostId,
    ) =>
      resolveRemoteEndpoint(hostId).pipe(
        Effect.flatMap((endpoint) =>
          ssh.run(homeDirectoryLookup(endpoint)).pipe(
            Effect.flatMap((result) =>
              parseRemoteUnixSocketPath(
                join(result.stdout.trim(), ".config", "herdr", "herdr.sock"),
              ),
            ),
            Effect.flatMap((remoteSocket) => ssh.forward(unixForward(endpoint, remoteSocket))),
          ),
        ),
      );

    const handoffServer: Context.Service.Shape<typeof HerdrTransport>["handoffServer"] = (
      hostId,
      session,
      awaitReady,
      route,
    ) =>
      resolveRemoteEndpoint(hostId, route).pipe(
        Effect.flatMap((endpoint) =>
          remoteHerdrCli(withSession(["server"], session)).pipe(
            Effect.flatMap((command) =>
              ssh.handoff(daemonHandoff(endpoint, command), awaitReady),
            ),
          ),
        ),
      );

    const stageImage: Context.Service.Shape<typeof HerdrTransport>["stageImage"] = (
      hostId,
      remoteName,
      bytes,
    ) =>
      resolveRemoteEndpoint(hostId).pipe(
        Effect.flatMap((endpoint) =>
          Effect.all({
            staged: compileHerdrImageStage(remoteName),
            input: makeRemoteStdin(bytes),
          }).pipe(
            Effect.flatMap(({ staged, input }) =>
              ssh
                .run(oneShotWithStdin(endpoint, staged.command, input))
                .pipe(Effect.as(staged.path)),
            ),
          ),
        ),
      );

    // Warm every configured ssh herdr host (best-effort, concurrent).
    const warm: Effect.Effect<void, SshError | SshInputError> = Effect.suspend(() => {
      const remotes = hostsWithCapability("herdr").filter((host) => host.kind === "remote");
      return Effect.forEach(
        remotes,
        (host) =>
          resolveRemoteEndpoint(host.id).pipe(
            Effect.flatMap((endpoint) => ssh.warm(endpoint)),
            Effect.ignore,
          ),
        { concurrency: 4, discard: true },
      );
    });

    return HerdrTransport.of({
      run,
      warm,
      connect,
      forwardMirror,
      handoffServer,
      stageImage,
    });
  }),
);
