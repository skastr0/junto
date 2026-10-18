/**
 * Where a linked machine's term control listens, and the token beside it.
 *
 * A machine record that sets juntoHome runs that machine's core with
 * JUNTO_HOME there, so its .junto sits under juntoHome. Without one, the core
 * runs in the SSH user's $HOME. Both paths come from that one home, so the
 * token read from a home only ever goes to the same home's socket.
 *
 * The record's schema checks only a leading "/" and no control characters,
 * and path.join would quietly fold "..", "." and "//" and move the token read.
 * So a juntoHome that is not already clean is refused as written, never
 * normalized.
 */
import { posix } from "node:path";
import { Effect } from "effect";
import type { RemoteHost } from "@shared/remote-hosts";
import { TERM_REMOTE_SOCK_REL, TERM_REMOTE_TOKEN_REL } from "@shared/term-control";
import {
  parseRemoteUnixSocketPath,
  SshInputError,
  type RemoteCommand,
  type RemoteUnixSocketPath,
  type SshTarget,
} from "../ssh/domain";
import { homeDirectoryLookup } from "../ssh/program";
import { remoteCat } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";

export type RemoteTermControl = {
  readonly socket: RemoteUnixSocketPath;
  /** Reads the token; its output is the token and nothing else. */
  readonly token: RemoteCommand;
};

const admitJuntoHome = (home: string): Effect.Effect<string, SshInputError> =>
  !home.startsWith("/") ||
  home.endsWith("/") ||
  posix.normalize(home) !== home ||
  home.split("/").some((segment) => segment === "." || segment === "..")
    ? Effect.fail(new SshInputError({ message: `Junto home must be a clean absolute path: ${home}` }))
    : Effect.succeed(home);

/** The socket through parseRemoteUnixSocketPath (103 bytes at most), the token through remoteCat. */
const termControlUnder = (home: string): Effect.Effect<RemoteTermControl, SshInputError> =>
  Effect.all({
    socket: parseRemoteUnixSocketPath(posix.join(home, TERM_REMOTE_SOCK_REL)),
    token: remoteCat(posix.join(home, TERM_REMOTE_TOKEN_REL)),
  });

/** The term control of the machine on this record, from its juntoHome or else the remote $HOME. */
export const remoteTermControl = (
  host: Pick<RemoteHost, "juntoHome">,
  target: SshTarget,
) => Effect.gen(function* () {
  const juntoHome = host.juntoHome;
  if (juntoHome !== undefined) return yield* termControlUnder(yield* admitJuntoHome(juntoHome));
  const ssh = yield* SshTransport;
  const home = (yield* ssh.run(homeDirectoryLookup(target))).stdout.trim() || ".";
  return yield* termControlUnder(home);
});
