import { Context, Effect, Layer, Scope } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import type { CliResult } from "../adapters/exec";
import { runCli } from "../adapters/exec";
import {
  findHostByHermesId,
  sshEndpointForHermesId,
} from "../hosts/snapshot";
import {
  makeRemoteCommand,
  parseSshEndpoint,
  SshInputError,
  type RemoteCommand,
  type SshEndpoint,
  type SshError,
} from "../ssh/domain";
import {
  compileHermesAvatar,
  compileHermesIdentityBatch,
} from "../ssh/hermes-remote-plan";
import {
  dedicatedStream,
  oneShot,
  type OneShotBudget,
} from "../ssh/program";
import {
  SshTransport,
  type ConfirmSshReady,
  type SshLease,
  type SshReady,
} from "../ssh/service";
import {
  isDefaultHermesProfile,
  type HermesHostId,
  type HermesProfileName,
} from "./domain";

const commandArgs = (
  profile: HermesProfileName,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  isDefaultHermesProfile(profile) ? args : ["-p", profile, ...args];

const describeSshFailure = (error: SshError | SshInputError): string => {
  switch (error._tag) {
    case "SshExitError":
      return `ssh operation exited with code ${error.code}`;
    case "SshTimeoutError":
      return `ssh operation timed out after ${error.timeoutMs}ms`;
    default:
      return error.message;
  }
};

/** Resolve only the canonical Hermes agent-key id for a configured remote. */
export const resolveHermesRemoteHost = (host: HermesHostId): RemoteHost | undefined =>
  findHostByHermesId(host);

const resolveHermesEndpoint = (
  hermesId: HermesHostId,
): Effect.Effect<SshEndpoint, SshInputError> => {
  const endpoint = sshEndpointForHermesId(hermesId);
  if (!endpoint) {
    const byId = resolveHermesRemoteHost(hermesId);
    if (!byId?.endpoint) {
      return Effect.fail(
        new SshInputError({
          message: `hermes host ${hermesId} is not a configured remote endpoint`,
        }),
      );
    }
    return parseSshEndpoint(byId.endpoint);
  }
  return parseSshEndpoint(endpoint);
};

export class HermesTransport extends Context.Tag("@vellum/HermesTransport")<
  HermesTransport,
  {
    readonly profiles: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly version: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly identityBatch: (host: HermesHostId) => Effect.Effect<CliResult>;
    readonly avatar: (
      host: HermesHostId,
      profile: HermesProfileName,
    ) => Effect.Effect<CliResult>;
    readonly connectAcp: <A, E, R>(
      host: HermesHostId,
      profile: HermesProfileName,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<SshReady<A>, E, R>,
    ) => Effect.Effect<A, SshError | SshInputError | E, R | Scope.Scope>;
  }
>() {}

export const HermesTransportLive = Layer.effect(
  HermesTransport,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;

    const local = (
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ): Effect.Effect<CliResult> =>
      Effect.tryPromise(() => runCli("hermes", args, timeoutMs)).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );

    /** Pure argv remote hermes CLI — no shell. */
    const remoteArgv = (
      endpoint: SshEndpoint,
      args: ReadonlyArray<string>,
      budget: OneShotBudget,
    ): Effect.Effect<CliResult> =>
      makeRemoteCommand("hermes", args).pipe(
        Effect.flatMap((command) => ssh.run(oneShot(endpoint, command, { budget }))),
        Effect.map((result): CliResult => ({ ok: true, stdout: result.stdout })),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );

    const onHost = (
      host: HermesHostId,
      args: ReadonlyArray<string>,
      budget: OneShotBudget,
      localTimeoutMs: number,
    ): Effect.Effect<CliResult> => {
      if (host === "local") return local(args, localTimeoutMs);
      const resolved = resolveHermesRemoteHost(host);
      if (!resolved || resolved.kind !== "remote" || !resolved.endpoint) {
        return Effect.succeed({
          ok: false,
          stdout: "",
          error: `unknown hermes host: ${host}`,
        });
      }
      return parseSshEndpoint(resolved.endpoint).pipe(
        Effect.flatMap((endpoint) => remoteArgv(endpoint, args, budget)),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );
    };

    /**
     * Run a branded RemoteCommand on a remote hermes host.
     * Compilers live in hermes-remote-plan — never hand-built shell here.
     */
    const remoteCompiled = (
      host: HermesHostId,
      command: Effect.Effect<RemoteCommand, SshInputError>,
      budget: OneShotBudget,
    ): Effect.Effect<CliResult> => {
      if (host === "local") {
        return Effect.succeed({
          ok: false,
          stdout: "",
          error: "remote hermes program requires a remote host",
        });
      }
      return resolveHermesEndpoint(host).pipe(
        Effect.flatMap((endpoint) =>
          command.pipe(
            Effect.flatMap((cmd) => ssh.run(oneShot(endpoint, cmd, { budget }))),
            Effect.map((result): CliResult => ({ ok: true, stdout: result.stdout })),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.succeed({
            ok: false,
            stdout: "",
            error: describeSshFailure(error),
          }),
        ),
      );
    };

    const connectAcp: Context.Tag.Service<typeof HermesTransport>["connectAcp"] = (
      host,
      profile,
      awaitReady,
    ) => {
      if (host === "local") {
        return Effect.fail(
          new SshInputError({
            message: "HermesTransport.connectAcp is reserved for remote hosts",
          }),
        );
      }
      return resolveHermesEndpoint(host).pipe(
        Effect.flatMap((endpoint) =>
          makeRemoteCommand("hermes", commandArgs(profile, ["acp"])).pipe(
            Effect.flatMap((command) =>
              ssh.connect(dedicatedStream(endpoint, command, "agent"), awaitReady),
            ),
          ),
        ),
      );
    };

    return HermesTransport.of({
      profiles: (host) => onHost(host, ["profile", "list"], "standard", 12_000),
      version: (host) => onHost(host, ["version"], "standard", 12_000),
      identityBatch: (host) =>
        remoteCompiled(host, compileHermesIdentityBatch(), "bulk"),
      avatar: (host, profile) =>
        remoteCompiled(host, compileHermesAvatar(profile), "bulk"),
      connectAcp,
    });
  }),
);
