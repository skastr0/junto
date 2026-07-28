import { Context, Effect, Layer, Schema } from "effect";
import {
  BoxCliCommandError,
  BoxCliProtocolError,
  BoxCliStatus,
  BoxCliUnavailableError,
  BoxMachineEnvelope,
  type BoxCliAvailability,
  type BoxCliError,
  type BoxId,
  type BoxMachine,
} from "./domain";
import {
  BoxProcessError,
  BoxProcessRunner,
  resolveBoxCliCandidates,
} from "./process";

const decodeStatus = Schema.decodeUnknown(BoxCliStatus, {
  onExcessProperty: "ignore",
});
const decodeMachineEnvelope = Schema.decodeUnknown(BoxMachineEnvelope, {
  onExcessProperty: "ignore",
});

const parseJson = (
  operation: string,
  stdout: string,
): Effect.Effect<unknown, BoxCliProtocolError> =>
  Effect.try({
    try: () => JSON.parse(stdout),
    catch: (cause) =>
      BoxCliProtocolError.make({
        operation,
        detail: `Box CLI returned invalid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });

const protocolError = (
  operation: string,
  cause: unknown,
): BoxCliProtocolError =>
  BoxCliProtocolError.make({
    operation,
    detail:
      cause instanceof Error
        ? cause.message
        : `Box CLI response did not match the ${operation} contract`,
  });

const commandError = (
  operation: string,
  result: {
    readonly exitCode: number;
    readonly stderr: string;
  },
): BoxCliCommandError =>
  BoxCliCommandError.make({
    operation,
    exitCode: result.exitCode,
    detail:
      result.stderr.trim() ||
      `Box CLI ${operation} exited with status ${result.exitCode}`,
  });

const processError = (
  operation: string,
  error: BoxProcessError,
): BoxCliCommandError =>
  BoxCliCommandError.make({
    operation,
    detail: error.detail,
  });

export interface BoxCliOptions {
  readonly executablePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export class BoxCli extends Context.Tag("@vellum/box/BoxCli")<
  BoxCli,
  {
    readonly availability: Effect.Effect<BoxCliAvailability>;
    readonly create: (
      options?: {
        readonly autoStop?: boolean;
        readonly includeAccountSecrets?: boolean;
      },
    ) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly info: (id: BoxId) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly stop: (id: BoxId) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly resume: (
      id: BoxId,
      options?: { readonly includeAccountSecrets?: boolean },
    ) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly ssh: (
      id: BoxId,
      command: ReadonlyArray<string>,
    ) => Effect.Effect<string, BoxCliError>;
  }
>() {}

export const makeBoxCli = (
  runner: Context.Tag.Service<typeof BoxProcessRunner>,
  options: BoxCliOptions = {},
): Context.Tag.Service<typeof BoxCli> => {
  const candidates = resolveBoxCliCandidates(
    options.executablePath,
    options.environment,
    options.homeDirectory,
  );
  const executable = candidates[0];

  const run = (
    operation: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ): Effect.Effect<
    {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
    BoxCliUnavailableError | BoxCliCommandError
  > => {
    if (executable === undefined) {
      return Effect.fail(
        BoxCliUnavailableError.make({
          detail:
            "Box CLI was not found in PATH or at ~/.ascii/bin/box",
        }),
      );
    }
    return runner
      .run({
        executable,
        args: ["--no-update", ...args],
        operation,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      .pipe(
        Effect.mapError((error) => processError(operation, error)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(commandError(operation, result)),
        ),
      );
  };

  const jsonMachine = (
    operation: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ): Effect.Effect<BoxMachine, BoxCliError> =>
    run(operation, ["--json", ...args], timeoutMs).pipe(
      Effect.flatMap((result) => parseJson(operation, result.stdout)),
      Effect.flatMap((value) =>
        decodeMachineEnvelope(value).pipe(
          Effect.mapError((error) => protocolError(operation, error)),
        ),
      ),
      Effect.map((envelope) => envelope.box),
    );

  const availability: Effect.Effect<BoxCliAvailability> =
    executable === undefined
      ? Effect.succeed({
          available: false,
          authenticated: false,
          healthy: false,
          detail: "Box CLI not installed",
        })
      : Effect.gen(function* () {
          const versionResult = yield* Effect.either(
            run("version", ["--version"]),
          );
          if (versionResult._tag === "Left") {
            return {
              available: true,
              executable,
              authenticated: false,
              healthy: false,
              detail: versionResult.left.detail,
            };
          }
          const version = versionResult.right.stdout
            .trim()
            .replace(/^box\s+/u, "");
          const statusResult = yield* Effect.either(
            run("status", ["--json", "status"]),
          );
          if (statusResult._tag === "Left") {
            return {
              available: true,
              executable,
              version,
              authenticated: false,
              healthy: false,
              detail: statusResult.left.detail,
            };
          }
          const parsed = yield* Effect.either(
            parseJson("status", statusResult.right.stdout).pipe(
              Effect.flatMap((value) =>
                decodeStatus(value).pipe(
                  Effect.mapError((error) => protocolError("status", error)),
                ),
              ),
            ),
          );
          if (parsed._tag === "Left") {
            return {
              available: true,
              executable,
              version,
              authenticated: false,
              healthy: false,
              detail: parsed.left.detail,
            };
          }
          const status = parsed.right;
          const authenticated =
            status.account.loginState === "active" &&
            status.account.status === "active";
          return {
            available: true,
            executable,
            version,
            authenticated,
            healthy: status.api.healthy,
            account: status.account.identifier,
            detail:
              authenticated && status.api.healthy
                ? `Box CLI ${version} is authenticated`
                : `Box CLI ${version} requires authentication or API recovery`,
          };
        });

  return BoxCli.of({
    availability,
    create: (createOptions = {}) =>
      jsonMachine("new", [
        "new",
        ...(createOptions.autoStop === false ? ["--no-auto-stop"] : []),
        ...(createOptions.includeAccountSecrets === false ? ["--no-env"] : []),
      ]),
    info: (id) => jsonMachine("info", ["info", id]),
    stop: (id) => jsonMachine("stop", ["stop", id], 120_000),
    resume: (id, resumeOptions = {}) =>
      jsonMachine(
        "resume",
        [
          "resume",
          id,
          ...(resumeOptions.includeAccountSecrets === false
            ? ["--no-env"]
            : []),
        ],
        120_000,
      ),
    ssh: (id, command) =>
      run("ssh", ["ssh", id, ...command], 120_000).pipe(
        Effect.map((result) => result.stdout),
      ),
  });
};

export const BoxCliLive = Layer.effect(
  BoxCli,
  Effect.map(BoxProcessRunner, (runner) => makeBoxCli(runner)),
);
