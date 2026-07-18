import { Context, Effect, Layer, Scope } from "effect";
import { join } from "node:path";
import type { CliResult } from "../adapters/exec";
import { runCli } from "../adapters/exec";
import {
  makeRemoteCommand,
  makeRemoteStdin,
  parseRemoteUnixSocketPath,
  parseSshEndpoint,
  type SshError,
  type SshInputError,
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
import {
  SshTransport,
  type ConfirmSshReady,
  type SshForwardLease,
  type SshLease,
  type SshReady,
} from "../ssh/service";
import { isKnownHerdrHost, type HerdrHostId } from "./hosts";

const REMOTE_HOST: HerdrHostId = "remote-a";
const REMOTE_ENDPOINT = "remote-a";
const REMOTE_STAGE_DIR = "/tmp/vellum-herdr-images";
const REMOTE_STAGE_SCRIPT = [
  "umask 077",
  "mkdir -p \"$1\"",
  "cat > \"$2\"",
  "chmod 600 \"$2\"",
].join("\n");

const withSession = (
  args: ReadonlyArray<string>,
  session?: string | null,
): ReadonlyArray<string> => session ? ["--session", session, ...args] : args;

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
    ) => Effect.Effect<CliResult>;
    readonly warm: Effect.Effect<void, SshError>;
    readonly connect: <A, E, R>(
      spec: HerdrStreamSpec,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | SshInputError | E, R | Scope.Scope>;
    readonly forwardMirror: Effect.Effect<SshForwardLease, SshError | SshInputError, Scope.Scope>;
    readonly handoffServer: <A, E, R>(
      session: string | null | undefined,
      awaitReady: (confirm: ConfirmSshReady) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | SshInputError | E, R>;
    readonly stageImage: (
      remoteName: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string, SshError | SshInputError>;
  }
>() {}

export const HerdrTransportLive = Layer.effect(
  HerdrTransport,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const endpoint = yield* parseSshEndpoint(REMOTE_ENDPOINT).pipe(Effect.orDie);

    const runRemote = (
      args: ReadonlyArray<string>,
      session: string | null | undefined,
      timeoutMs: number,
    ): Effect.Effect<CliResult> =>
      makeRemoteCommand("herdr", withSession(args, session)).pipe(
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
    ): Effect.Effect<CliResult> => {
      if (hostId === "local") {
        return Effect.tryPromise(() => runCli("herdr", withSession(args, session), timeoutMs)).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              ok: false,
              stdout: "",
              error: error instanceof Error ? error.message : String(error),
            } satisfies CliResult),
          ),
        );
      }
      return runRemote(args, session, timeoutMs);
    };

    const connect: Context.Tag.Service<typeof HerdrTransport>["connect"] = (spec, awaitReady) => {
      if (!isKnownHerdrHost(spec.hostId) || spec.hostId !== REMOTE_HOST) {
        return Effect.dieMessage("HerdrTransport.connect is reserved for the fixed remote host");
      }
      return makeRemoteCommand("herdr", withSession(spec.args, spec.session)).pipe(
        Effect.flatMap((command) =>
          ssh.connect(sharedStream(endpoint, command, "fast"), awaitReady),
        ),
      );
    };

    const forwardMirror = ssh.run(homeDirectoryLookup(endpoint)).pipe(
      Effect.flatMap((result) =>
        parseRemoteUnixSocketPath(join(result.stdout.trim(), ".config", "herdr", "herdr.sock")),
      ),
      Effect.flatMap((remoteSocket) => ssh.forward(unixForward(endpoint, remoteSocket))),
    );

    const handoffServer: Context.Tag.Service<typeof HerdrTransport>["handoffServer"] =
      (session, awaitReady) =>
        makeRemoteCommand("herdr", withSession(["server"], session)).pipe(
          Effect.flatMap((command) => ssh.handoff(daemonHandoff(endpoint, command), awaitReady)),
        );

    const stageImage = (
      remoteName: string,
      bytes: Uint8Array,
    ): Effect.Effect<string, SshError | SshInputError> => {
      const remotePath = `${REMOTE_STAGE_DIR}/${remoteName}`;
      return Effect.all({
        command: makeRemoteCommand("/bin/sh", [
          "-c",
          REMOTE_STAGE_SCRIPT,
          "vellum-stage-image",
          REMOTE_STAGE_DIR,
          remotePath,
        ]),
        input: makeRemoteStdin(bytes),
      }).pipe(
        Effect.flatMap(({ command, input }) =>
          ssh.run(oneShotWithStdin(endpoint, command, input)),
        ),
        Effect.as(remotePath),
      );
    };

    return HerdrTransport.of({
      run,
      warm: ssh.warm(endpoint),
      connect,
      forwardMirror,
      handoffServer,
      stageImage,
    });
  }),
);
