/**
 * Closed allowlisted remote command constructors for product modules.
 *
 * Product code (hosts/, hermes/, herdr/, term/, browser/) must
 * mint RemoteCommands only through these factories or named plan compilers in
 * remote-plan.ts / hermes-remote-plan.ts. Free-form executable+args (including
 * `/bin/sh -c …`) is unrepresentable here — that is the seal.
 *
 * Doctrine: brand means “safe product operation,” not merely “created by Vellum.”
 */

import type { Context } from "effect";
import { Effect, Schema } from "effect";
import {
  makeRemoteCommand,
  type RemoteCommand,
  type SshEndpoint,
  type SshError,
  SshInputError,
} from "./domain";
import { oneShot } from "./program";
import { SshTransport } from "./service";

// Clean absolute POSIX path: no shell metacharacters, no `..`, no NULs.
const SAFE_ABS_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

export const DARWIN_PACKAGED_STATION_EXECUTABLE =
  "/Applications/Vellum Command.app/Contents/Resources/bin/vellum-station";
export const DARWIN_PACKAGED_BROWSER_EXECUTABLE =
  "/Applications/Vellum Command.app/Contents/Resources/bin/vellum-browser";
export const LINUX_PACKAGED_STATION_EXECUTABLE =
  "/opt/Vellum Command/resources/bin/vellum-station";
export const LINUX_PACKAGED_BROWSER_EXECUTABLE =
  "/opt/Vellum Command/resources/bin/vellum-browser";

const RemotePackagedPlatformTypeId: unique symbol = Symbol(
  "@vellum/ssh/RemotePackagedPlatform",
);

/**
 * Runtime witness minted only from one current, exact `uname -s` observation.
 * A platform string supplied by a caller cannot select a remote executable.
 */
export interface RemotePackagedPlatform {
  readonly [RemotePackagedPlatformTypeId]:
    typeof RemotePackagedPlatformTypeId;
}

type RemotePackagedPlatformName = "darwin" | "linux";

const remotePackagedPlatforms = new WeakMap<
  RemotePackagedPlatform,
  RemotePackagedPlatformName
>();

type Ssh = Context.Tag.Service<typeof SshTransport>;

export class RemotePlatformProbeError extends Schema.TaggedError<RemotePlatformProbeError>()(
  "RemotePlatformProbeError",
  {
    endpoint: Schema.String,
    reason: Schema.Literal("malformed", "unsupported"),
    message: Schema.String,
  },
) {}

const mintRemotePackagedPlatform = (
  platform: RemotePackagedPlatformName,
): RemotePackagedPlatform => {
  const witness = Object.freeze({
    [RemotePackagedPlatformTypeId]: RemotePackagedPlatformTypeId,
  }) as RemotePackagedPlatform;
  remotePackagedPlatforms.set(witness, platform);
  return witness;
};

const decodeRemotePackagedPlatform = (
  endpoint: SshEndpoint,
  output: string,
): Effect.Effect<RemotePackagedPlatform, RemotePlatformProbeError> => {
  if (output === "Darwin\n") {
    return Effect.succeed(mintRemotePackagedPlatform("darwin"));
  }
  if (output === "Linux\n") {
    return Effect.succeed(mintRemotePackagedPlatform("linux"));
  }
  const canonicalUnsupported =
    output.endsWith("\n") &&
    output.indexOf("\n") === output.length - 1 &&
    /^[A-Za-z][A-Za-z0-9._-]{0,31}\n$/u.test(output);
  return Effect.fail(
    RemotePlatformProbeError.make({
      endpoint,
      reason: canonicalUnsupported ? "unsupported" : "malformed",
      message: canonicalUnsupported
        ? "remote platform does not have a Vellum packaged executable"
        : "remote platform probe did not return one canonical uname record",
    }),
  );
};

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

/** Fixed OS probe: `uname -s`. */
export const remoteUname = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/usr/bin/uname", ["-s"]);

/**
 * Resolve the installed product platform from the target itself. The probe
 * carries no Station request or browser delegation, and malformed/unsupported
 * evidence fails before either payload can cross SSH.
 */
export const resolveRemotePackagedPlatform = (
  ssh: Ssh,
  endpoint: SshEndpoint,
): Effect.Effect<
  RemotePackagedPlatform,
  SshError | RemotePlatformProbeError
> =>
  Effect.gen(function* () {
    const command = yield* remoteUname();
    const observed = yield* ssh.run(
      oneShot(endpoint, command, { budget: "short" }),
    );
    return yield* decodeRemotePackagedPlatform(endpoint, observed.stdout);
  }).pipe(Effect.withSpan("ssh.remote-packaged-platform"));

/**
 * Read a confined absolute path with `/bin/cat`.
 * Path is re-admitted; free-form shell is not representable.
 */
export const remoteCat = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/cat", [safe])),
  );

/**
 * File existence probe: `/bin/test -f <path>`.
 * Only the fixed `-f` shape is admitted — no free-form test expressions.
 */
export const remoteTestFileExists = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/test", ["-f", safe])),
  );

/**
 * Product Hermes CLI on the remote PATH.
 * Executable is fixed to `hermes`; args are revalidated tokens only.
 */
export const remoteHermesCli = (
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitCliArgs(args).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("hermes", safe)),
  );

/**
 * Product Herdr CLI on the remote PATH.
 * Executable is fixed to `herdr`; args are revalidated tokens only.
 */
export const remoteHerdrCli = (
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitCliArgs(args).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("herdr", safe)),
  );

/** Version probe for doctor: fixed argv per product binary. */
export const remoteProductVersion = (
  binary: "herdr" | "hermes",
): Effect.Effect<RemoteCommand, SshInputError> =>
  binary === "herdr"
    ? remoteHerdrCli(["--version"])
    : remoteHermesCli(["version"]);

/**
 * Fixed host LISTEN probe used by herdr service-map.
 * `pidList` must be a comma-joined positive integer list only.
 */
export const remoteLsofTcpListen = (
  pidList: string,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    typeof pidList !== "string" ||
    pidList.length === 0 ||
    pidList.length > 4_096 ||
    !/^[1-9][0-9]{0,9}(?:,[1-9][0-9]{0,9}){0,255}$/u.test(pidList)
  ) {
    return Effect.fail(
      new SshInputError({
        message: "lsof pid list must be a bounded comma-joined positive integer list",
      }),
    );
  }
  return makeRemoteCommand("lsof", [
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-a",
    "-p",
    pidList,
  ]);
};

/** Fixed Tailscale serve status JSON probe. */
export const remoteTailscaleServeStatus = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => makeRemoteCommand("tailscale", ["serve", "status", "--json"]);

/**
 * Closed host-shell argv admission for herdr plane probes.
 * Only the two product LISTEN / serve shapes are representable.
 */
export const remoteHostProbe = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    argv.length === 4 &&
    argv[0] === "tailscale" &&
    argv[1] === "serve" &&
    argv[2] === "status" &&
    argv[3] === "--json"
  ) {
    return remoteTailscaleServeStatus();
  }
  if (
    argv.length === 6 &&
    argv[0] === "lsof" &&
    argv[1] === "-nP" &&
    argv[2] === "-iTCP" &&
    argv[3] === "-sTCP:LISTEN" &&
    argv[4] === "-a" &&
    argv[5] !== undefined
  ) {
    return remoteLsofTcpListen(argv[5]);
  }
  return Effect.fail(
    new SshInputError({
      message: "host probe argv is not an allowlisted product shape",
    }),
  );
};

/**
 * Fixed packaged station-browser wrapper. The executable comes only from a
 * current platform witness; PATH and user-installed symlinks are never read.
 */
export const remoteVellumBrowserStation = (
  platform: RemotePackagedPlatform,
): Effect.Effect<
  RemoteCommand,
  SshInputError
> => {
  const observed = remotePackagedPlatforms.get(platform);
  if (observed === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "remote packaged platform witness is invalid",
      }),
    );
  }
  return makeRemoteCommand(
    observed === "darwin"
      ? DARWIN_PACKAGED_BROWSER_EXECUTABLE
      : LINUX_PACKAGED_BROWSER_EXECUTABLE,
    ["station"],
  );
};

/**
 * Fixed Station API stdin wrapper. Fleet traffic is one typed request on
 * stdin and one typed response on stdout. Only the immutable packaged resource
 * selected by current host evidence can receive that request.
 */
export const remoteVellumStation = (
  platform: RemotePackagedPlatform,
): Effect.Effect<
  RemoteCommand,
  SshInputError
> => {
  const observed = remotePackagedPlatforms.get(platform);
  if (observed === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "remote packaged platform witness is invalid",
      }),
    );
  }
  return makeRemoteCommand(
    observed === "darwin"
      ? DARWIN_PACKAGED_STATION_EXECUTABLE
      : LINUX_PACKAGED_STATION_EXECUTABLE,
    [],
  );
};
