import { Effect, Schema } from "effect";

const ENDPOINT_PATTERN = /^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/;
// OpenSSH receives one shell-quoted argv record, so an absolute package path
// may contain ordinary spaces (for example `Junto.app`). Control
// characters and leading option syntax remain non-admissible.
const EXECUTABLE_PATTERN = /^(?!-)[^\u0000-\u001f\u007f]+$/u;

export const SshEndpoint = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(255)),
  Schema.check(Schema.isPattern(ENDPOINT_PATTERN)),
  Schema.brand("SshEndpoint"),
);
export type SshEndpoint = typeof SshEndpoint.Type;

export const SshIdentityFile = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.makeFilter((value) =>
    value.startsWith("/") &&
    !value.includes("\u0000") &&
    !value.includes("\n") &&
    !value.includes("\r"),
  {
    message: "SSH identity file must be a bounded absolute path",
  },)),
  Schema.brand("SshIdentityFile"),
);
export type SshIdentityFile = typeof SshIdentityFile.Type;

export const SshHostKeyPolicy = Schema.Literals(["system", "accept-new"]);
export type SshHostKeyPolicy = typeof SshHostKeyPolicy.Type;

const SshRouteTypeId: unique symbol = Symbol("@junto/ssh/SshRoute");

export interface SshRoute {
  readonly [SshRouteTypeId]: typeof SshRouteTypeId;
}

export type SshTarget = SshEndpoint | SshRoute;

interface SshRouteDetails {
  readonly endpoint: SshEndpoint;
  readonly identityFile?: SshIdentityFile;
  readonly hostKeyPolicy: SshHostKeyPolicy;
}

const sshRoutes = new WeakMap<SshRoute, SshRouteDetails>();

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

/** Process or pipe death. Not I/O — a closed SSH child is not a stream bound. */
export class SshProcessError extends Schema.TaggedError<SshProcessError>()(
  "SshProcessError",
  {
    endpoint: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

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
    stream: Schema.Literals(["stdout", "stderr"]),
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
  detail: Schema.optionalKey(Schema.String),
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
  | SshProcessError
  | SshTimeoutError
  | SshOutputLimitError
  | SshExitError
  | SshForwardError;

export const parseSshEndpoint = (input: unknown): Effect.Effect<SshEndpoint, SshInputError> =>
  Schema.decodeUnknownEffect(SshEndpoint)(input).pipe(
    Effect.mapError(() =>
      new SshInputError({
        message: "SSH endpoint must be a bounded option-safe host or SSH config alias",
      }),
    ),
  );

export const parseSshRoute = (input: {
  readonly endpoint: unknown;
  readonly identityFile?: unknown;
  readonly hostKeyPolicy?: unknown;
}): Effect.Effect<SshRoute, SshInputError> =>
  Effect.gen(function* () {
    const endpoint = yield* parseSshEndpoint(input.endpoint);
    const identityFile =
      input.identityFile === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(SshIdentityFile)(input.identityFile).pipe(
            Effect.mapError(
              () =>
                new SshInputError({
                  message:
                    "SSH identity file must be a bounded absolute path",
                }),
            ),
          );
    const hostKeyPolicy =
      input.hostKeyPolicy === undefined
        ? "system"
        : yield* Schema.decodeUnknownEffect(SshHostKeyPolicy)(
            input.hostKeyPolicy,
          ).pipe(
            Effect.mapError(
              () =>
                new SshInputError({
                  message: "SSH host-key policy is invalid",
                }),
            ),
          );
    const route = Object.freeze({
      [SshRouteTypeId]: SshRouteTypeId,
    }) as SshRoute;
    sshRoutes.set(route, {
      endpoint,
      ...(identityFile === undefined ? {} : { identityFile }),
      hostKeyPolicy,
    });
    return route;
  });

export const parseHostSshRoute = (host: {
  readonly sshEndpoint?: unknown;
  readonly sshIdentityFile?: unknown;
  readonly sshHostKeyPolicy?: unknown;
}): Effect.Effect<SshRoute, SshInputError> =>
  parseSshRoute({
    endpoint: host.sshEndpoint,
    ...(host.sshIdentityFile === undefined
      ? {}
      : { identityFile: host.sshIdentityFile }),
    ...(host.sshHostKeyPolicy === undefined
      ? {}
      : { hostKeyPolicy: host.sshHostKeyPolicy }),
  });

/** @internal SSH policy compiler and transport accounting only. */
export const inspectSshTarget = (target: SshTarget): SshRouteDetails => {
  if (typeof target === "string") {
    return { endpoint: target, hostKeyPolicy: "system" };
  }
  const details = sshRoutes.get(target);
  if (!details) {
    throw new TypeError("SshRoute was not minted by the SSH domain");
  }
  return details;
};

const RemoteCommandTypeId: unique symbol = Symbol("@junto/ssh/RemoteCommand");

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
 * `ssh` barrel (`ssh/index.ts`). Brand means “created inside Junto’s SSH
 * kernel,” not “safe product operation.” Only:
 * - `ssh/remote-plan.ts` (named plan compilers)
 * - `ssh/read-commands.ts` (closed allowlisted read constructors)
 * - SSH kernel tests (deep-import this module)
 * may call this. Product modules under hosts/, hermes/,
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
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.makeFilter((value) =>
    value.startsWith("/") &&
    REMOTE_SOCKET_PATTERN.test(value) &&
    Buffer.byteLength(value, "utf8") <= 103,
  {
    message: "Remote Unix socket path must be absolute, bounded, and safe for OpenSSH forwarding",
  },)),
  Schema.brand("RemoteUnixSocketPath"),
);
export type RemoteUnixSocketPath = typeof RemoteUnixSocketPath.Type;

export const parseRemoteUnixSocketPath = (
  input: unknown,
): Effect.Effect<RemoteUnixSocketPath, SshInputError> =>
  Schema.decodeUnknownEffect(RemoteUnixSocketPath)(input).pipe(
    Effect.mapError(() =>
      new SshInputError({
        message:
          "Remote Unix socket path must be absolute, at most 103 UTF-8 bytes, and contain only forwarding-safe characters",
      }),
    ),
  );

const RemoteStdinTypeId: unique symbol = Symbol("@junto/ssh/RemoteStdin");

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
