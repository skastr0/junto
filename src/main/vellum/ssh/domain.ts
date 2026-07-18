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
  stderr: Schema.String,
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
  if (args.length > 256 || args.some((arg) => !validRemoteArg(arg))) {
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
    throw new TypeError("RemoteCommand was not created by makeRemoteCommand");
  }
  return parts;
};

export const UnixSocketPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\u0000") &&
      Buffer.byteLength(value, "utf8") <= 103,
    {
    message: () => "Unix socket path must be absolute and fit the Unix-domain path limit",
    },
  ),
  Schema.brand("UnixSocketPath"),
);
export type UnixSocketPath = typeof UnixSocketPath.Type;

export const parseUnixSocketPath = (
  input: unknown,
): Effect.Effect<UnixSocketPath, SshInputError> =>
  Schema.decodeUnknown(UnixSocketPath)(input).pipe(
    Effect.mapError(() =>
      new SshInputError({ message: "Unix socket path must be absolute and at most 103 UTF-8 bytes" }),
    ),
  );
