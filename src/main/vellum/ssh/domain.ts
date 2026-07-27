import { Effect, Schema } from "effect";

const ENDPOINT_PATTERN = /^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/;
const EXECUTABLE_PATTERN = /^(?!-)[^\s\u0000-\u001f\u007f]+$/u;

export const SshEndpoint = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(ENDPOINT_PATTERN),
  Schema.brand("SshEndpoint"),
);
export type SshEndpoint = typeof SshEndpoint.Type;

export class SshInputError extends Schema.TaggedError<SshInputError>()("SshInputError", {
  message: Schema.String,
}) {}

export class SshSetupError extends Schema.TaggedError<SshSetupError>()("SshSetupError", {
  endpoint: Schema.String,
  message: Schema.String,
}) {}

export class SshSpawnError extends Schema.TaggedError<SshSpawnError>()("SshSpawnError", {
  endpoint: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export class SshIoError extends Schema.TaggedError<SshIoError>()("SshIoError", {
  endpoint: Schema.String,
  operation: Schema.String,
  message: Schema.String,
}) {}

export class SshTimeoutError extends Schema.TaggedError<SshTimeoutError>()("SshTimeoutError", {
  endpoint: Schema.String,
  operation: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class SshOutputLimitError extends Schema.TaggedError<SshOutputLimitError>()(
  "SshOutputLimitError",
  {
    endpoint: Schema.String,
    operation: Schema.String,
    stream: Schema.Literal("stdout", "stderr"),
    limitBytes: Schema.Number,
  },
) {}

// OpenSSH reserves 255 for its own failures, but a remote program may also
// exit 255. Keep one sound exit error instead of pretending transport and
// remote-command failures are perfectly distinguishable.
export class SshExitError extends Schema.TaggedError<SshExitError>()("SshExitError", {
  endpoint: Schema.String,
  operation: Schema.String,
  code: Schema.Number,
}) {}

export class SshForwardError extends Schema.TaggedError<SshForwardError>()("SshForwardError", {
  endpoint: Schema.String,
  message: Schema.String,
}) {}

export type SshError =
  | SshInputError
  | SshSetupError
  | SshSpawnError
  | SshIoError
  | SshTimeoutError
  | SshOutputLimitError
  | SshExitError
  | SshForwardError;

export const parseSshEndpoint = (input: unknown): Effect.Effect<SshEndpoint, SshInputError> =>
  Schema.decodeUnknown(SshEndpoint)(input).pipe(
    Effect.mapError(() =>
      new SshInputError({
        message: "SSH endpoint must be a bounded option-safe host or SSH config alias",
      }),
    ),
  );

const RemoteCommandTypeId: unique symbol = Symbol("@vellum/ssh/RemoteCommand");

export interface RemoteCommand {
  readonly [RemoteCommandTypeId]: typeof RemoteCommandTypeId;
}

interface RemoteCommandParts {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
}

const commandParts = new WeakMap<RemoteCommand, RemoteCommandParts>();

const validRemoteArg = (arg: string): boolean =>
  !arg.includes("\u0000") && Buffer.byteLength(arg, "utf8") <= 64 * 1024;

const remoteCommandBytes = (executable: string, args: ReadonlyArray<string>): number =>
  [executable, ...args].reduce(
    (total, token) => total + Buffer.byteLength(token, "utf8") + 1,
    0,
  );

/**
 * Low-level mint: bounds check + WeakMap brand only.
 *
 * **@internal** — not a product safety boundary and **not** on the public
 * `ssh` barrel (`ssh/index.ts`). Brand means “created inside Vellum’s SSH
 * kernel,” not “safe product operation.” Only:
 * - `ssh/remote-plan.ts` / `ssh/hermes-remote-plan.ts` (named plan compilers)
 * - `ssh/read-commands.ts` (closed allowlisted read constructors)
 * - SSH kernel tests (deep-import this module)
 * may call this. Product modules under hosts/, hermes/, herdr/,
 * term/, browser/ must use named factories — never this function.
 *
 * Residual (Cut 3, deliberate): one WeakMap command brand for all recipes
 * (argv reads, `/bin/sh -c` plans, dormant Darwin `bash -lc`). Do not invent
 * parallel command types — seal at the named-compiler boundary instead.
 */
export const makeRemoteCommand = (
  executable: string,
  args: ReadonlyArray<string> = [],
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    !EXECUTABLE_PATTERN.test(executable) ||
    Buffer.byteLength(executable, "utf8") > 1_024
  ) {
    return Effect.fail(
      new SshInputError({ message: "remote executable must be a bounded option-safe token" }),
    );
  }
  if (
    args.length > 256 ||
    args.some((arg) => !validRemoteArg(arg)) ||
    remoteCommandBytes(executable, args) > 128 * 1024
  ) {
    return Effect.fail(
      new SshInputError({ message: "remote command arguments exceed the SSH command boundary" }),
    );
  }
  const command = Object.freeze({
    [RemoteCommandTypeId]: RemoteCommandTypeId,
  }) as RemoteCommand;
  commandParts.set(command, Object.freeze({ executable, args: Object.freeze([...args]) }));
  return Effect.succeed(command);
};

/** @internal SSH policy compiler only. */
export const inspectRemoteCommand = (command: RemoteCommand): RemoteCommandParts => {
  const parts = commandParts.get(command);
  if (!parts) {
    throw new TypeError("RemoteCommand was not minted by the SSH command kernel");
  }
  return parts;
};

const REMOTE_SOCKET_PATTERN = /^\/[A-Za-z0-9._+@/-]+$/u;

export const RemoteUnixSocketPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(
    (value) =>
      value.startsWith("/") &&
      REMOTE_SOCKET_PATTERN.test(value) &&
      Buffer.byteLength(value, "utf8") <= 103,
    {
      message: () =>
        "Remote Unix socket path must be absolute, bounded, and safe for OpenSSH forwarding",
    },
  ),
  Schema.brand("RemoteUnixSocketPath"),
);
export type RemoteUnixSocketPath = typeof RemoteUnixSocketPath.Type;

export const parseRemoteUnixSocketPath = (
  input: unknown,
): Effect.Effect<RemoteUnixSocketPath, SshInputError> =>
  Schema.decodeUnknown(RemoteUnixSocketPath)(input).pipe(
    Effect.mapError(() =>
      new SshInputError({
        message:
          "Remote Unix socket path must be absolute, at most 103 UTF-8 bytes, and contain only forwarding-safe characters",
      }),
    ),
  );

const RemoteStdinTypeId: unique symbol = Symbol("@vellum/ssh/RemoteStdin");

export interface RemoteStdin {
  readonly [RemoteStdinTypeId]: typeof RemoteStdinTypeId;
}

const remoteInputs = new WeakMap<RemoteStdin, Uint8Array>();
const MAX_REMOTE_STDIN_BYTES = 16 * 1024 * 1024;

export const makeRemoteStdin = (
  input: string | Uint8Array,
): Effect.Effect<RemoteStdin, SshInputError> => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_REMOTE_STDIN_BYTES) {
    return Effect.fail(
      new SshInputError({ message: "remote stdin exceeds the 16 MiB operation boundary" }),
    );
  }
  const value = Object.freeze({
    [RemoteStdinTypeId]: RemoteStdinTypeId,
  }) as RemoteStdin;
  remoteInputs.set(value, Uint8Array.from(bytes));
  return Effect.succeed(value);
};

/** @internal SSH policy compiler only. */
export const inspectRemoteStdin = (input: RemoteStdin): Uint8Array => {
  const bytes = remoteInputs.get(input);
  if (!bytes) throw new TypeError("RemoteStdin was not created by makeRemoteStdin");
  return Uint8Array.from(bytes);
};
