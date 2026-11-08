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

export const remoteUname = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/usr/bin/uname", ["-s"]);

export const remoteCat = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/cat", [safe])),
  );
