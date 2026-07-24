import { Context, Effect, Layer, Scope } from "effect";
import { join } from "node:path";
import type { CliResult } from "../adapters/exec";
import { runCli } from "../adapters/exec";
import { findHostById, hostsWithCapability } from "../hosts/snapshot";
import {
  makeRemoteStdin,
  parseRemoteUnixSocketPath,
  parseSshEndpoint,
  SshInputError,
  type SshEndpoint,
  type SshError,
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
): Effect.Effect<SshEndpoint, SshInputError> => {
  if (route) {
    if (route.hostId !== hostId || route.kind !== "remote" || !route.endpoint) {
      return Effect.fail(new SshInputError({ message: `invalid captured herdr route for ${hostId}` }));
    }
    return parseSshEndpoint(route.endpoint);
  }
  const host = findHostById(hostId);
  if (!host || host.kind !== "remote" || !host.endpoint) {
    return Effect.fail(
      new SshInputError({
        message: `herdr host ${hostId} is not a configured ssh endpoint`,
      }),
    );
  }
  return parseSshEndpoint(host.endpoint);
};

export interface HerdrStreamSpec {
  readonly hostId: HerdrHostId;
  readonly args: ReadonlyArray<string>;
  readonly session?: string | null;
}

export class HerdrTransport extends Context.Tag("@vellum/HerdrTransport")<
  HerdrTransport,
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
  }
>() {}

export const HerdrTransportLive = Layer.effect(
  HerdrTransport,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;

    const runRemote = (
      endpoint: SshEndpoint,
      args: ReadonlyArray<string>,
      session: string | null | undefined,
      timeoutMs: number,
    ): Effect.Effect<CliResult> =>
      remoteHerdrCli(withSession(args, session)).pipe(
        Effect.flatMap((command) =>
          ssh.run(oneShot(endpoint, command, { budget: budgetFor(timeoutMs) })),
        ),
        Effect.map((result): CliResult => ({ ok: true, stdout: result.stdout })),
        Effect.catchAll((error) =>
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
          Effect.catchAll((error) =>
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
        Effect.catchAll((error) =>
          Effect.succeed({ ok: false, stdout: "", error: sshFailure(error) }),
        ),
      );
    };

    const connect: Context.Tag.Service<typeof HerdrTransport>["connect"] = (
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

    const forwardMirror: Context.Tag.Service<typeof HerdrTransport>["forwardMirror"] = (
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

    const handoffServer: Context.Tag.Service<typeof HerdrTransport>["handoffServer"] = (
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

    const stageImage: Context.Tag.Service<typeof HerdrTransport>["stageImage"] = (
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
