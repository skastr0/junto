/** Named commands over the shared SSH transport. */
import { Effect } from "effect";
import { makeRemoteCommand, SshInputError, type RemoteCommand } from "./domain";
const SAFE_ABS_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

const admitReadPath = (path: string): Effect.Effect<string, SshInputError> => {
  if (
    typeof path !== "string" ||
    !SAFE_ABS_PATH.test(path) ||
    path.includes("..") ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 512
  ) {
    return Effect.fail(
      new SshInputError({
        message: "remote read path must be a clean absolute POSIX path",
      }),
    );
  }
  return Effect.succeed(path);
};

/**
 * Product CLI argv: executable is fixed by the factory; args stay argv tokens
 * (no shell). Bounds match makeRemoteCommand (NUL / size); empty tokens rejected.
 */
const admitCliArgs = (
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, SshInputError> => {
  if (args.length > 64) {
    return Effect.fail(
      new SshInputError({ message: "remote CLI argument count exceeds product bound" }),
    );
  }
  for (const arg of args) {
    if (
      typeof arg !== "string" ||
      arg.length === 0 ||
      arg.includes("\0") ||
      Buffer.byteLength(arg, "utf8") > 64 * 1024
    ) {
      return Effect.fail(
        new SshInputError({ message: "remote CLI argument is not a safe product token" }),
      );
    }
  }
  return Effect.succeed(args);
};

export const remoteUname = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/usr/bin/uname", ["-s"]);

export const remoteCat = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/cat", [safe])),
  );

export const remoteHermesCli = (
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitCliArgs(args).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("hermes", safe)),
  );
