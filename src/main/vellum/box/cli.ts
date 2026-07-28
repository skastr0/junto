import { Context, Effect, Layer, Schema } from "effect";
import {
  BoxActionEnvelope,
  BoxCliCommandError,
  BoxCliProtocolError,
  BoxCliStatus,
  BoxCliUnavailableError,
  BoxId,
  BoxMachineEnvelope,
  BoxNewLine,
  type BoxCliAvailability,
  type BoxCliError,
  type BoxId as BoxIdType,
  type BoxMachine,
} from "./domain";
import {
  BoxProcessError,
  BoxProcessRunner,
  resolveBoxCliCandidates,
} from "./process";
import { ownedBoxId, type OwnedBox } from "./ownership";

const decodeStatus = Schema.decodeUnknown(BoxCliStatus, {
  onExcessProperty: "ignore",
});
const decodeMachineEnvelope = Schema.decodeUnknown(BoxMachineEnvelope, {
  onExcessProperty: "ignore",
});
const decodeActionEnvelope = Schema.decodeUnknown(BoxActionEnvelope, {
  onExcessProperty: "ignore",
});
const decodeNewLine = Schema.decodeUnknown(BoxNewLine, {
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
    readonly stdout: string;
    readonly stderr: string;
  },
): BoxCliCommandError =>
  BoxCliCommandError.make({
    operation,
    exitCode: result.exitCode,
    ...(() => {
      const boxId = boxIdFromJsonLines(result.stdout);
      return boxId === undefined ? {} : { boxId };
    })(),
    detail:
      errorDetailFromJsonLines(result.stdout) ||
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

const parseJsonLines = (
  operation: string,
  stdout: string,
): Effect.Effect<ReadonlyArray<unknown>, BoxCliProtocolError> =>
  Effect.try({
    try: () => {
      const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) throw new Error("response contained no JSON lines");
      return lines.map((line) => JSON.parse(line) as unknown);
    },
    catch: (cause) =>
      BoxCliProtocolError.make({
        operation,
        detail: `Box CLI returned invalid JSONL: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
  });

const boxIdFromJsonLines = (stdout: string): BoxIdType | undefined => {
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line) as { readonly id?: unknown };
      const decoded = Schema.decodeUnknownEither(
        Schema.Struct({ id: BoxId }),
        { onExcessProperty: "ignore" },
      )(value);
      if (decoded._tag === "Right") return decoded.right.id;
    } catch {
      // Best-effort recovery metadata only; the typed protocol decoder reports
      // malformed success output on the normal path.
    }
  }
  return undefined;
};

const errorDetailFromJsonLines = (stdout: string): string | undefined => {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line) as {
        readonly event?: unknown;
        readonly error?: unknown;
      };
      if (value.event === "error" && typeof value.error === "string") {
        return value.error;
      }
    } catch {
      // Fall through to stderr or the generic exit detail.
    }
  }
  return undefined;
};

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
    readonly info: (box: OwnedBox) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly stop: (box: OwnedBox) => Effect.Effect<BoxMachine, BoxCliError>;
    readonly resume: (
      box: OwnedBox,
      options?: { readonly includeAccountSecrets?: boolean },
    ) => Effect.Effect<BoxMachine, BoxCliError>;
    /**
     * Ask Box to create/refresh and authorize its CLI-managed SSH key for this
     * exact owned machine. Ordinary remote traffic belongs to SshTransport.
     */
    readonly prepareSsh: (box: OwnedBox) => Effect.Effect<void, BoxCliError>;
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

  const infoByCreatedId = (
    boxId: BoxIdType,
  ): Effect.Effect<BoxMachine, BoxCliError> =>
    jsonMachine("info-created", ["info", boxId]).pipe(
      Effect.flatMap((machine) =>
        machine.id === boxId
          ? Effect.succeed(machine)
          : Effect.fail(
              BoxCliProtocolError.make({
                operation: "info-created",
                detail: "Box info did not match the created Box identity",
              }),
            ),
      ),
    );

  const createMachine = (
    createOptions: {
      readonly autoStop?: boolean;
      readonly includeAccountSecrets?: boolean;
    },
  ): Effect.Effect<BoxMachine, BoxCliError> =>
    run(
      "new",
      [
        "--json",
        "new",
        ...(createOptions.autoStop === false ? ["--no-auto-stop"] : []),
        ...(createOptions.includeAccountSecrets === false ? ["--no-env"] : []),
      ],
      120_000,
    ).pipe(
      Effect.flatMap((result) => parseJsonLines("new", result.stdout)),
      Effect.flatMap((values) =>
        Effect.forEach(values, (value) =>
          decodeNewLine(value).pipe(
            Effect.mapError((error) => protocolError("new", error)),
          ),
        ),
      ),
      Effect.flatMap((lines) => {
        const created = lines.find((line) => line.event === "created");
        const ready = lines.find((line) => line.event === "ready");
        const failure = lines.find((line) => line.event === "error");
        if (failure?.event === "error") {
          return Effect.fail(
            BoxCliCommandError.make({
              operation: "new",
              detail: failure.error,
              ...(created?.event === "created" ? { boxId: created.id } : {}),
            }),
          );
        }
        if (
          created?.event !== "created" ||
          ready?.event !== "ready" ||
          created.id !== ready.id
        ) {
          return Effect.fail(
            BoxCliProtocolError.make({
              operation: "new",
              detail:
                "Box creation did not produce matching created and ready receipts",
            }),
          );
        }
        return infoByCreatedId(created.id);
      }),
    );

  const actionMachine = (
    operation: "stop" | "resume",
    box: OwnedBox,
    args: ReadonlyArray<string>,
  ): Effect.Effect<BoxMachine, BoxCliError> =>
    run(operation, ["--json", ...args], 120_000).pipe(
      Effect.flatMap((result) => parseJson(operation, result.stdout)),
      Effect.flatMap((value) =>
        decodeActionEnvelope(value).pipe(
          Effect.mapError((error) => protocolError(operation, error)),
        ),
      ),
      Effect.flatMap((receipt) => {
        const expected = ownedBoxId(box);
        if (receipt.id !== expected || receipt.box?.id !== expected) {
          return receipt.box === null && receipt.id === expected
            ? jsonMachine(`${operation}-info`, ["info", expected])
            : Effect.fail(
                BoxCliProtocolError.make({
                  operation,
                  detail: "Box action receipt did not match the owned Box",
                }),
              );
        }
        return Effect.succeed(receipt.box);
      }),
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
    create: (createOptions = {}) => createMachine(createOptions),
    info: (box) => jsonMachine("info", ["info", ownedBoxId(box)]),
    stop: (box) => actionMachine("stop", box, ["stop", ownedBoxId(box)]),
    resume: (box, resumeOptions = {}) =>
      actionMachine(
        "resume",
        box,
        [
          "resume",
          ownedBoxId(box),
          ...(resumeOptions.includeAccountSecrets === false
            ? ["--no-env"]
            : []),
        ],
      ),
    prepareSsh: (box) =>
      run("prepare-ssh", ["ssh", ownedBoxId(box), "true"], 120_000).pipe(
        Effect.asVoid,
      ),
  });
};

export const BoxCliLive = Layer.effect(
  BoxCli,
  Effect.map(BoxProcessRunner, (runner) => makeBoxCli(runner)),
);
